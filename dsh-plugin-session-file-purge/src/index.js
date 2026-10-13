// dsh-plugin-session-file-purge — Host half.
//
// One plugin that does what deleting a session alone does not: it also takes
// away the files that session produced. The pieces:
//
//   baseline snapshot   on `turn/start` (before the first tool of the session
//                       runs) the session's working directory is recorded as
//                       path -> size/mtime under the harness home;
//   plan                the delete flow asks the Host what the session created:
//                       the directory is diffed against the baseline, so every
//                       writer is covered — file tools, shell, python, a build
//                       script — not just the paths a tool happened to name;
//   purge               the selected files are moved into a dated trash
//                       directory (never deleted outright) and their emptied
//                       folders are removed;
//   delete              the session log, projection cache and workspace
//                       accounting are removed the way the standalone
//                       session-delete plugin does it, so the row disappears
//                       without a restart.
//
//   cleanup: POST /__sespurge/cleanup  — the whole flow in one request
//   plan:    POST /__sespurge/plan     — what a session created (no changes)
//   purge:   POST /__sespurge/purge    — trash the selection, keep the session
//   trash:   GET  /__sespurge/trash    — what is in the trash
//   restore: POST /__sespurge/trash/restore
//   list:    GET  /__sespurge/session/list
//   tools:   session_files (plan or purge from inside a conversation)
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.
// Every registration rides the plugin fiber through ctx.effect / the injected
// context, so disposing the plugin removes its routes, listeners and tools.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { diagnose } from './diagnostics.js'
import { captureBaseline, diffAgainstBaseline, resolveInside } from './scan.js'
import { moveToTrash, restoreFile, dropTrashEntry, TrashIndex } from './trash.js'

export const name = 'session-file-purge'

diagnose('module-load', `node ${process.version}`)

// `tools` is optional so a composition without the tool registry still gets the
// HTTP flow; webServer is optional so a terminal-only profile still loads.
export const inject = []
export const optional = ['tools', 'webServer']

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Bound defaults. Deliberately NOT exported as `Config`: a cordis plugin that
// exports `Config` declares a schemastery schema, and the loader validates the
// row's config through `Config['~standard'].validate(...)`. A plain defaults
// object has no `~standard`, so exporting it as `Config` throws during config
// resolution and the row never activates — the plugin then loads (its module is
// imported) while `apply` is silently never called. Bounds are validated field
// by field in `readConfig` below instead.
const DEFAULTS = {
  maxEntries: 200_000,
  baselineBudgetMs: 30_000,
  planBudgetMs: 20_000,
  trashRetentionDays: 30,
  claimWindowMs: 120_000,
}

function readConfig(raw) {
  const config = { ...DEFAULTS }
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULTS)) {
      const value = raw[key]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) config[key] = value
    }
  }
  return config
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function pluginHome() {
  return path.join(dshHome(), 'session-file-purge')
}

function baselinesDir() {
  return path.join(pluginHome(), 'baselines')
}

function trashRoot() {
  return path.join(pluginHome(), 'trash')
}

// --- session ids, sessions root, deletion ------------------------------------

function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) variants.add(sessionId.slice('session-'.length))
  else if (SESSION_ID_RE.test(sessionId)) variants.add(`session-${sessionId}`)
  return [...variants]
}

/** Locate ~/.dsh/sessions/<slug>/<id>/ for both id spellings. */
function findSessionDirs(sessionId) {
  const root = path.join(dshHome(), 'sessions')
  const variants = sessionIdVariants(sessionId)
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    for (const variant of variants) {
      const candidate = path.join(root, entry.name, variant)
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch {
        /* keep scanning */
      }
    }
  }
  return found
}

/**
 * Remove the session from the projection cache and the workspace accounting
 * through the live storage domain, so the in-memory state and the next flush
 * cannot resurrect the row being deleted.
 */
async function stripStorageDomains(ctx, sessionId, { workspace = true } = {}) {
  const sd = ctx.get('storageDomain')
  if (!sd) return { projRemoved: false, workspaceRemoved: false }
  const variants = sessionIdVariants(sessionId)
  let projRemoved = false
  let workspaceRemoved = false

  const proj = sd.get('session_projcache')
  if (proj && typeof proj.table === 'function') {
    try {
      const sessions = proj.table('sessions')
      for (const variant of variants) {
        if (sessions.get(variant) !== undefined) {
          await sessions.delete(variant)
          projRemoved = true
        }
      }
    } catch {
      /* unit closed or table absent */
    }
  }

  if (workspace) {
    const ws = sd.get('workspace')
    if (ws && typeof ws.table === 'function') {
      try {
        const workspaces = ws.table('workspaces')
        for (const [wid, rec] of workspaces.entries()) {
          if (rec && Array.isArray(rec.sessionIds) && variants.some((v) => rec.sessionIds.includes(v))) {
            await workspaces.put(wid, {
              ...rec,
              sessionIds: rec.sessionIds.filter((id) => !variants.includes(id)),
            })
            workspaceRemoved = true
          }
        }
      } catch {
        /* keep going: the log removal is the part that must succeed */
      }
      try {
        const global = ws.global
        if (global && typeof global.get === 'function' && typeof global.set === 'function') {
          const state = global.get()
          if (state && Array.isArray(state.archivedSessionIds)) {
            const kept = state.archivedSessionIds.filter((id) => !variants.includes(id))
            if (kept.length !== state.archivedSessionIds.length) {
              await global.set({ ...state, archivedSessionIds: kept })
              workspaceRemoved = true
            }
          }
        }
      } catch {
        /* optional accounting */
      }
    }
  }

  return { projRemoved, workspaceRemoved }
}

async function stopAgentIfRunning(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return false
  const agent = agents.get(sessionId)
  if (!agent) return false
  if (typeof agent.cancel === 'function') {
    try {
      agent.cancel({ kind: 'user' })
    } catch {
      /* agent may already be settling */
    }
  }
  if (typeof agent.whenIdle === 'function') {
    try {
      await Promise.race([agent.whenIdle(), new Promise((resolve) => setTimeout(resolve, 15_000))])
    } catch {
      /* proceed with deletion anyway */
    }
  }
  return true
}

/** Flush a live session so its dispose has nothing left to write after the log is gone. */
async function flushSessionIfLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return false
  let flushed = false
  for (const variant of sessionIdVariants(sessionId)) {
    const session = sessions.get(variant)
    if (session && typeof sessions.flush === 'function') {
      try {
        await sessions.flush(session)
        flushed = true
      } catch {
        /* deletion proceeds and removes the log anyway */
      }
    }
  }
  return flushed
}

/** Drop the live store entry through the store's own teardown path. */
function detachLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions) return false
  let detached = false
  try {
    const store = sessions.store
    for (const variant of sessionIdVariants(sessionId)) {
      const entry = store && typeof store.get === 'function' ? store.get(variant) : undefined
      if (entry === undefined) continue
      if (typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry)
        detached = true
      } else if (store && typeof store.delete === 'function') {
        store.delete(variant)
        if (sessions.attachments && entry.session && typeof sessions.attachments.delete === 'function') {
          sessions.attachments.delete(entry.session)
        }
        detached = true
      }
    }
  } catch {
    /* ignore */
  }
  return detached
}

/**
 * Delete one session end to end: stop a running agent, flush, detach, remove the
 * on-disk log, drop the projection row, then release the workspace accounting.
 * @returns what each step did.
 */
async function deleteSessionCore(ctx, sessionId) {
  if (!SESSION_ID_RE.test(sessionId)) throw new PurgeError(`invalid session id: ${sessionId}`, 400)
  const stopped = await stopAgentIfRunning(ctx, sessionId)
  await flushSessionIfLive(ctx, sessionId)
  const detached = detachLiveSession(ctx, sessionId)

  const dirs = findSessionDirs(sessionId)
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  const remaining = findSessionDirs(sessionId)
  if (remaining.length > 0) {
    throw new PurgeError(`session files could not be fully removed: ${remaining.join(', ')}`, 500)
  }

  const projStorage = await stripStorageDomains(ctx, sessionId, { workspace: false })
  const workspaceStorage = await stripStorageDomains(ctx, sessionId, { workspace: true })
  const projRemoved = projStorage.projRemoved || workspaceStorage.projRemoved
  const workspaceRemoved = workspaceStorage.workspaceRemoved

  forgetBaseline(sessionId)
  return { stopped, detached, dirRemoved: dirs.length > 0, projRemoved, workspaceRemoved }
}

class PurgeError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

// --- baselines ----------------------------------------------------------------

function baselinePath(sessionId) {
  return path.join(baselinesDir(), `${sessionId}.json`)
}

function readBaseline(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(baselinePath(sessionId), 'utf8'))
  } catch {
    return null
  }
}

function writeBaseline(sessionId, snapshot) {
  try {
    fs.mkdirSync(baselinesDir(), { recursive: true })
    fs.writeFileSync(baselinePath(sessionId), JSON.stringify(snapshot), 'utf8')
  } catch {
    /* a lost baseline degrades the plan, it must not break the session */
  }
}

function forgetBaseline(sessionId) {
  try {
    fs.rmSync(baselinePath(sessionId), { force: true })
  } catch {
    /* ignore */
  }
}

/**
 * Which directories must never appear in a plan.
 * @param ctx - host context, used to find the harness home.
 * @returns absolute paths to skip.
 */
function skipDirectories(ctx) {
  const skip = [pluginHome(), path.join(dshHome(), 'sessions'), path.join(dshHome(), 'attachments')]
  const workspaceRoots = new Set()
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      for (const workspace of registry.list() || []) {
        if (workspace && typeof workspace.dir === 'string') workspaceRoots.add(workspace.dir)
      }
    }
  } catch {
    /* registry absent: the harness home alone is enough */
  }
  return { skip, workspaceRoots }
}

/**
 * The workspace root one session ran in.
 * @param session - a live Session whose header carries the working directory.
 * @returns the absolute cwd, or null when the session has none.
 */
function sessionRoot(session) {
  const cwd = session && session.header ? session.header.cwd : undefined
  if (typeof cwd !== 'string' || cwd === '') return null
  return path.resolve(cwd)
}

// --- plan ---------------------------------------------------------------------

const CHECKED_BY_DEFAULT_LIMIT = 400

/**
 * Diff the session's directory against its baseline and describe what a purge
 * would move.
 * @param options - session id, root, skip list and the plan budget.
 * @returns the candidate files, grouped and described for the dialog.
 */
async function planForSession({ sessionId, root, skip, config }) {
  const baseline = readBaseline(sessionId)
  if (baseline === null) {
    return {
      sessionId,
      root,
      baseline: null,
      reason: 'no-baseline',
      added: [],
      modified: [],
      removedCount: 0,
      truncated: false,
    }
  }

  const diff = await diffAgainstBaseline({
    baseline,
    skipDirs: skip,
    maxEntries: config.maxEntries,
    budgetMs: config.planBudgetMs,
  })

  const added = diff.added.map((file) => ({
    path: file.path,
    absolute: path.join(root, file.path),
    size: file.size,
    mtime: file.mtime,
    change: 'added',
    checked: true,
  }))
  const modified = diff.modified.map((file) => ({
    path: file.path,
    absolute: path.join(root, file.path),
    size: file.size,
    mtime: file.mtime,
    previousSize: file.previousSize,
    change: 'modified',
    checked: false,
  }))

  added.sort((a, b) => b.mtime - a.mtime)
  modified.sort((a, b) => b.mtime - a.mtime)

  // A safety rail for the session that wrote thousands of files: everything is
  // still listed, but only the newest slice starts selected.
  if (added.length > CHECKED_BY_DEFAULT_LIMIT) {
    for (const file of added.slice(CHECKED_BY_DEFAULT_LIMIT)) file.checked = false
  }

  return {
    sessionId,
    root,
    baseline: { capturedAt: baseline.capturedAt, fileCount: baseline.fileCount, truncated: baseline.truncated === true },
    added,
    modified,
    removedCount: diff.removed.length,
    truncated: diff.truncated === true || diff.truncatedByBaseline === true,
    truncationReason: diff.truncationReason,
  }
}

function planSummary(plan) {
  const total = plan.added.length + plan.modified.length
  const bytes = [...plan.added, ...plan.modified].reduce((sum, file) => sum + (file.size || 0), 0)
  return { total, added: plan.added.length, modified: plan.modified.length, bytes }
}

// --- purge --------------------------------------------------------------------

/**
 * Move the selected files of one session into the trash.
 * @param options - the session, its root, the selected relative paths, the trash
 * index and the config.
 * @returns the manifest and a per-path report.
 */
function purgeSelection({ sessionId, root, paths, index, config, note }) {
  const files = []
  const refused = []
  const directories = new Set()
  for (const candidate of paths) {
    const absolute = resolveInside(root, candidate)
    if (absolute === null) {
      refused.push({ path: candidate, error: 'outside the session directory' })
      continue
    }
    let stat
    try {
      stat = fs.statSync(absolute)
    } catch {
      refused.push({ path: candidate, error: 'missing' })
      continue
    }
    if (!stat.isFile()) {
      refused.push({ path: candidate, error: 'not a file' })
      continue
    }
    files.push({ absolute, relative: candidate })
    let parent = path.dirname(candidate)
    while (parent !== '.' && parent !== '/' && parent !== '') {
      directories.add(parent)
      parent = path.dirname(parent)
    }
  }

  fs.mkdirSync(trashRoot(), { recursive: true })
  // Files move first; only then can the folders that held them be recognized as
  // empty (and only the ones this purge actually emptied are removed).
  const manifest = moveToTrash({
    trashRoot: trashRoot(),
    sessionId,
    root,
    files,
    directories: [],
    note,
  })
  manifest.emptiedDirectories = removeEmptiedDirectories(root, [...directories])
  try {
    fs.writeFileSync(path.join(manifest.dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  } catch {
    /* the index still records the purge */
  }
  index.add(manifest)
  pruneTrash(index, config)
  return { manifest, refused }
}

/**
 * Remove the directories a purge emptied, deepest first, and nothing else.
 * @param root - the session's working directory.
 * @param directories - relative parent directories of the moved files.
 * @returns the relative paths actually removed.
 */
function removeEmptiedDirectories(root, directories) {
  const candidates = [...new Set(directories)].sort((a, b) => b.length - a.length)
  const removed = []
  for (const relative of candidates) {
    const absolute = resolveInside(root, relative)
    if (absolute === null) continue
    try {
      if (fs.readdirSync(absolute).length !== 0) continue
      fs.rmdirSync(absolute)
      removed.push(relative)
    } catch {
      /* still occupied, already gone, or not removable */
    }
  }
  return removed
}

/** Remove trash entries older than the retention window. */
function pruneTrash(index, config) {
  const cutoff = Date.now() - config.trashRetentionDays * 24 * 60 * 60 * 1000
  for (const entry of [...index.entries]) {
    const when = Date.parse(entry.at)
    if (Number.isFinite(when) && when < cutoff) {
      const manifest = index.manifest(entry.id)
      if (manifest) dropTrashEntry(manifest)
      index.remove(entry.id)
    }
  }
}

// --- session listing ----------------------------------------------------------

/** The session list the delete dialog matches sidebar rows against. */
function listSessions(ctx) {
  const agents = ctx.get('agents')
  const sd = ctx.get('storageDomain')
  const out = []
  if (!sd) return out
  const proj = sd.get('session_projcache')
  if (!proj || typeof proj.table !== 'function') return out
  try {
    const sessions = proj.table('sessions')
    for (const [id, rec] of sessions.entries()) {
      if (!rec || typeof rec !== 'object') continue
      const rows = rec.rows && typeof rec.rows === 'object' ? rec.rows : {}
      const titleRow = rows.title && rows.title.val
      const identity = rec.identity && typeof rec.identity === 'object' ? rec.identity : {}
      out.push({
        sessionId: id,
        title: typeof titleRow === 'string' ? titleRow : null,
        createdAt: typeof identity.createdAt === 'number' ? identity.createdAt : null,
        running: !!(agents && typeof agents.get === 'function' && agents.get(id)),
        hasBaseline: readBaseline(id) !== null,
      })
    }
  } catch {
    /* unit closed or table absent */
  }
  return out
}

// --- http ---------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 4e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

function requireSessionId(value) {
  const sessionId = String(value || '').trim()
  if (!SESSION_ID_RE.test(sessionId)) throw new PurgeError('a session id is required', 400)
  return sessionId
}

// --- plugin -------------------------------------------------------------------

/**
 * @param ctx - host context.
 * @param rawConfig - the row's config, validated field by field.
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  const index = new TrashIndex(trashRoot())
  /** session id -> { root, claimedAt } for baselines captured this process. */
  const captured = new Map()

  const captureFor = async (session) => {
    const sessionId = session.id
    if (captured.has(sessionId)) return
    if (readBaseline(sessionId) !== null) {
      captured.set(sessionId, { root: sessionRoot(session), claimedAt: Date.now() })
      return
    }
    const root = sessionRoot(session)
    if (root === null) return
    captured.set(sessionId, { root, claimedAt: Date.now() })
    try {
      const snapshot = await captureBaseline({
        root,
        skipDirs: skipDirectories(ctx).skip,
        maxEntries: config.maxEntries,
        budgetMs: config.baselineBudgetMs,
      })
      // The session may have been deleted while this ran; writing then would
      // leave an orphan baseline behind, so re-check the claim.
      if (!captured.has(sessionId)) return
      writeBaseline(sessionId, snapshot)
    } catch (error) {
      ctx.logger?.warn?.(`session-file-purge: baseline for ${sessionId} failed: ${String(error)}`)
    }
  }

  // Baselines are taken when a turn starts, before any tool of that turn runs,
  // and adopted when a session already has one (a conversation continued after
  // a restart keeps the baseline of its first turn).
  ctx.on('session/event', (session, event) => {
    if (!session || event?.type !== 'turn/start') return
    // Only claim once per session per process; an unclaimed session from an
    // earlier process is picked up through the stored baseline on disk.
    if (captured.has(session.id)) return
    void captureFor(session)
  })

  ctx.on('session/disposed', (session) => {
    if (session && captured.has(session.id)) captured.delete(session.id)
  })

  ctx.effect(() => () => {
    captured.clear()
  })

  const plan = async (sessionId) => {
    const sessions = ctx.get('sessions')
    let root = null
    const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (live) root = sessionRoot(live)
    if (root === null) {
      const baseline = readBaseline(sessionId)
      if (baseline) root = baseline.root
    }
    if (root === null) {
      // A session that never started in this process: ask the workspace
      // registry which directory owns it.
      try {
        const registry = ctx.get('workspaceRegistry')
        const variants = sessionIdVariants(sessionId)
        for (const workspace of (registry && registry.list && registry.list()) || []) {
          const ids = workspace && Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
          if (!ids.some((id) => variants.includes(id))) continue
          if (typeof workspace.dir === 'string') root = workspace.dir
          break
        }
      } catch {
        /* registry absent */
      }
    }
    if (root === null) throw new PurgeError('this session has no known working directory', 409)
    return planForSession({ sessionId, root, skip: skipDirectories(ctx).skip, config })
  }

  /**
   * Register every HTTP route on one web server.
   * @param host - the webServer service.
   * @param targetCtx - the context whose fiber owns the registrations.
   * @param how - which path reached here ('direct', 'inject', 'poll'), for the log.
   */
  function registerHttp(host, targetCtx, how) {
    if (typeof host?.register !== 'function') {
      diagnose('http-register-skipped', `no register() on the webServer service (${how})`)
      return
    }
    const route = (method, routePath, handler) =>
      targetCtx.effect(() =>
        host.register({
          kind: 'exact',
          path: routePath,
          handler: async (req, res) => {
            if (req.method !== method) {
              sendJson(res, 405, { error: 'method not allowed' })
              return
            }
            try {
              const body = method === 'POST' && req.headers['content-length'] !== '0' ? await readBody(req) : ''
              const args = body ? JSON.parse(body) : {}
              const value = await handler(args)
              sendJson(res, 200, { ok: true, value })
            } catch (error) {
              const status = error instanceof PurgeError && error.status ? error.status : 500
              sendJson(res, status, { error: String((error && error.message) || error) })
            }
          },
        }),
      )
    route('GET', '/__sespurge/ping', async () => ({ plugin: name, pid: process.pid, via: how }))
    registerRoutes(route)
    diagnose('http-register', `routes registered via ${how} (pid ${process.pid})`)
  }

  /**
   * Register every route through one `route(method, path, handler)` binder.
   * Split out so the registration cannot be reached without the log line above.
   * @param route - the binder.
   */
  function registerRoutes(route) {
    route('GET', '/__sespurge/session/list', async () => ({ sessions: listSessions(ctx) }))

    route('POST', '/__sespurge/plan', async (args) => {
      const sessionId = requireSessionId(args.sessionId)
      const result = await plan(sessionId)
      return result
    })

    route('POST', '/__sespurge/purge', async (args) => {
      const sessionId = requireSessionId(args.sessionId)
      const paths = Array.isArray(args.paths) ? args.paths.slice(0, config.maxEntries) : []
      if (paths.length === 0) throw new PurgeError('no files were selected', 400)
      const result = await plan(sessionId)
      const { manifest, refused } = purgeSelection({
        sessionId,
        root: result.root,
        paths,
        index,
        config,
        note: typeof args.note === 'string' ? args.note : null,
      })
      return {
        trashId: manifest.id,
        moved: manifest.files,
        failed: [...manifest.failed, ...refused],
        bytes: manifest.bytes,
        emptiedDirectories: manifest.emptiedDirectories,
        trashDir: manifest.dir,
      }
    })

    route('POST', '/__sespurge/cleanup', async (args) => {
      const sessionId = requireSessionId(args.sessionId)
      const paths = Array.isArray(args.paths) ? args.paths.slice(0, config.maxEntries) : []
      const result = await plan(sessionId)
      let purged = null
      if (paths.length > 0) {
        const outcome = purgeSelection({
          sessionId,
          root: result.root,
          paths,
          index,
          config,
          note: typeof args.note === 'string' ? args.note : null,
        })
        purged = {
          trashId: outcome.manifest.id,
          moved: outcome.manifest.files,
          failed: [...outcome.manifest.failed, ...outcome.refused],
          bytes: outcome.manifest.bytes,
          emptiedDirectories: outcome.manifest.emptiedDirectories,
          trashDir: outcome.manifest.dir,
        }
      }
      if (args.deleteSession !== false) {
        const deleted = await deleteSessionCore(ctx, sessionId)
        return { purged, deleted: { ...deleted, sessionId } }
      }
      return { purged, deleted: null }
    })

    route('GET', '/__sespurge/trash', async () => {
      const entries = index.entries.map((entry) => ({
        ...entry,
        missing: index.manifest(entry.id) === null,
      }))
      return { trashRoot: trashRoot(), entries }
    })

    route('POST', '/__sespurge/trash/restore', async (args) => {
      const id = String(args.id || '')
      const manifest = index.manifest(id)
      if (manifest === null) throw new PurgeError('that trash entry no longer exists', 404)
      const wanted = Array.isArray(args.paths) && args.paths.length > 0
        ? manifest.files.filter((file) => args.paths.includes(file.path))
        : manifest.files
      const restored = []
      const failed = []
      for (const file of wanted) {
        try {
          restoreFile(manifest, file.path)
          restored.push(file.path)
        } catch (error) {
          failed.push({ path: file.path, error: String((error && error.message) || error) })
        }
      }
      const remaining = manifest.files.filter((file) => !restored.includes(file.path))
      if (remaining.length === 0) {
        dropTrashEntry(manifest)
        index.remove(id)
      } else {
        manifest.files = remaining
        try {
          fs.writeFileSync(path.join(manifest.dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
        } catch {
          /* the index still points at a partially restored entry */
        }
      }
      return { restored, failed, remaining: remaining.length }
    })

    route('POST', '/__sespurge/trash/drop', async (args) => {
      const id = String(args.id || '')
      const manifest = index.manifest(id)
      if (manifest === null) throw new PurgeError('that trash entry no longer exists', 404)
      dropTrashEntry(manifest)
      index.remove(id)
      return { dropped: id }
    })
  }

  // The web surface is registered through whichever path actually works in this
  // composition: the service may already exist, may appear later (a deferred
  // inject), or may be reachable through the context even when it is not a
  // declared dependency — so all three are tried, and the log records which one
  // carried the routes.
  let httpRegistered = false
  const tryRegister = (host, targetCtx, how) => {
    if (httpRegistered) return true
    if (host === undefined || host === null || typeof host.register !== 'function') return false
    registerHttp(host, targetCtx, how)
    httpRegistered = true
    return true
  }

  diagnose('apply', `webServer present: ${ctx.get('webServer') !== undefined}`)
  if (!tryRegister(ctx.get('webServer'), ctx, 'direct')) {
    ctx.inject(['webServer'], (sub) => {
      if (!tryRegister(sub.webServer ?? sub.get?.('webServer'), sub, 'inject')) {
        diagnose('inject-no-webServer', 'the injected context carried no webServer service')
      }
    })
    // Belt and braces: a composition whose webServer service arrives without the
    // inject callback firing (an entry-order accident) still gets its routes on
    // the first timer tick that finds the service.
    const timer = setInterval(() => {
      if (httpRegistered) {
        clearInterval(timer)
        return
      }
      if (tryRegister(ctx.get('webServer'), ctx, 'poll')) clearInterval(timer)
    }, 500)
    if (typeof timer.unref === 'function') timer.unref()
    ctx.effect(() => () => clearInterval(timer))
  }

  // The model tool: plan or purge the files of one session. Registered through a
  // deferred inject so a composition without the tool registry still loads.
  ctx.inject(['tools'], (sub) => {
    sub.effect(() =>
      sub.tools.register(
        defineTool({
          name: 'session_files',
          description:
            'List or clean up the files one session of this workbench produced. mode "list" reports the files the session created or changed since its baseline snapshot; mode "purge" moves the given paths into the plugin trash directory (never deleting them outright). The harness keeps no per-session file ledger, so the report comes from diffing the working directory against the snapshot taken when the session started.',
          parameters: {
            sessionId: { type: 'string', required: true, description: 'The session id (uuid or session-<uuid>).' },
            mode: { type: 'string', required: false, description: '"list" (default) or "purge".' },
            paths: {
              type: 'array',
              required: false,
              description: 'For mode "purge": the relative paths to move into the trash, as reported by mode "list".',
              items: { type: 'string' },
            },
          },
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: value }],
          },
          async execute(toolArgs) {
            const sessionId = requireSessionId(toolArgs.sessionId)
            const mode = toolArgs.mode === 'purge' ? 'purge' : 'list'
            const result = await plan(sessionId)
            const summary = planSummary(result)
            if (result.baseline === null) {
              return `no baseline snapshot exists for ${sessionId}; the files this session produced cannot be identified`
            }
            const lines = [
              `session: ${sessionId}`,
              `directory: ${result.root}`,
              `baseline captured: ${result.baseline.capturedAt}`,
              `created: ${summary.added}, changed: ${summary.modified}, ${summary.bytes} bytes`,
            ]
            if (result.truncated) lines.push('warning: the scan hit its budget; the list may be incomplete')
            for (const file of result.added.slice(0, 100)) lines.push(`+ ${file.path} (${file.size} bytes)`)
            for (const file of result.modified.slice(0, 100)) lines.push(`~ ${file.path} (${file.size} bytes)`)
            if (mode === 'list') return lines.join('\n')

            const paths = Array.isArray(toolArgs.paths) ? toolArgs.paths : []
            if (paths.length === 0) return [...lines, 'purge: no paths were given'].join('\n')
            const outcome = purgeSelection({ sessionId, root: result.root, paths, index, config, note: 'agent tool' })
            return [
              ...lines,
              `moved into trash: ${outcome.manifest.files.length} (${outcome.manifest.bytes} bytes)`,
              `trash: ${outcome.manifest.dir}`,
              ...outcome.manifest.failed.map((f) => `failed: ${f.path} (${f.error})`),
              ...outcome.refused.map((f) => `refused: ${f.path} (${f.error})`),
            ].join('\n')
          },
        }),
      ),
    )
  })
}
