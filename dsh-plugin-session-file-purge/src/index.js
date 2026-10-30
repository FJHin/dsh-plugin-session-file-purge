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
//   drop:    POST /__sespurge/trash/drop  — one batch, a selection, or all of it
//   list:    GET  /__sespurge/session/list
//   tools:   session_files (plan or purge from inside a conversation)
//
// Every route is admitted through the harness' own connection service first — the
// same Host/Origin fence and signed browser-session cookie that guard /api — so a
// route that lists sessions or moves files answers only the Web UI session that
// could already drive it, never another origin, another local app, or a bare
// curl. See admissionStatus() below.
//
// A purge moves only what a preview listed: every plan carries a digest of its
// own file list, /purge and /cleanup must quote it, and a path that was not in
// that list is refused instead of moved. Links are reported by the scan and never
// moved, never followed, and a restore never overwrites a file that is already
// back at the original path — it comes back under a free name beside it. Parents
// count too: a directory that has since become a link would let a purge or a
// restore reach outside the workspace, so every ancestor is resolved and checked.
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.
// Every registration rides the plugin fiber through ctx.effect / the injected
// context, so disposing the plugin removes its routes, listeners and tools.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diagnose } from './diagnostics.js'
import { captureBaseline, diffAgainstBaseline, normalizeKey, parentHazard, resolveInside, symlinkHazard } from './scan.js'
import { moveToTrash, restoreFile, dropTrashEntry, TrashIndex } from './trash.js'

// Expand the { field: { type, required, description, items } } shorthand into a
// JSON Schema object; pass an already-valid schema through, and reject anything
// else at load time instead of letting the provider fail every request later.
function toJsonSchema(parameters) {
  if (parameters === undefined || parameters === null) return undefined
  if (typeof parameters !== 'object' || Array.isArray(parameters)) {
    throw new TypeError('tool parameters must be an object')
  }
  const fields = Object.entries(parameters)
  const shorthand = fields.every(([, spec]) => spec && typeof spec === 'object' && typeof spec.type === 'string')
  if (!shorthand) {
    if (parameters.type !== 'object') {
      throw new TypeError('tool parameters must be a JSON Schema object with type: "object" and properties')
    }
    return parameters
  }
  const properties = {}
  const required = []
  for (const [field, spec] of fields) {
    const { required: isRequired, ...rest } = spec
    properties[field] = rest
    if (isRequired === true) required.push(field)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false }
}

// The registry receives whatever is registered here verbatim; keep the conversion
// (and its validation) in this package rather than trusting an optional peer.
function defineTool(definition) {
  return { ...definition, parameters: toJsonSchema(definition.parameters) }
}

export const name = 'session-file-purge'

diagnose('module-load', `node ${process.version}`)

// `tools` is optional so a composition without the tool registry still gets the
// HTTP flow; webServer is optional so a terminal-only profile still loads.
export const inject = []
export const optional = ['tools', 'webServer', 'connection']

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
    const empty = {
      sessionId,
      root,
      baseline: null,
      reason: 'no-baseline',
      added: [],
      modified: [],
      links: [],
      removedCount: 0,
      truncated: false,
    }
    empty.planId = planDigest(empty)
    return empty
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

  const plan = {
    sessionId,
    root,
    baseline: { capturedAt: baseline.capturedAt, fileCount: baseline.fileCount, truncated: baseline.truncated === true },
    added,
    modified,
    links: diff.links || [],
    removedCount: diff.removed.length,
    truncated: diff.truncated === true || diff.truncatedByBaseline === true,
    truncationReason: diff.truncationReason,
  }
  plan.planId = planDigest(plan)
  return plan
}

/**
 * The identity of one preview: the list of paths the dialog offered, not what the
 * files contain. A purge must quote this digest, and the digest is recomputed at
 * purge time, so a list that changed since the dialog opened (a file appeared, a
 * session was cleaned in another window) is refused instead of acted on.
 * @param plan - the plan the dialog is showing.
 * @returns a stable digest for exactly that file list.
 */
function planDigest(plan) {
  const lines = [...(plan.added || []), ...(plan.modified || [])].map((file) => `${file.change}\t${file.path}`).sort()
  const material = `${plan.sessionId || ''}\n${plan.root || ''}\n${lines.join('\n')}`
  return `p1-${createHash('sha256').update(material).digest('hex').slice(0, 32)}`
}

/**
 * A purge may only act on the preview the user was looking at.
 * @param plan - the freshly recomputed plan for the session.
 * @param planId - the digest the client sent back.
 */
function assertPlanMatches(plan, planId) {
  if (typeof planId !== 'string' || planId === '') {
    throw new PurgeError('planId is required: a purge may only move the files a preview listed', 400)
  }
  if (plan.planId !== planId) {
    throw new PurgeError('the file list changed since that preview; reopen it and choose again', 409)
  }
}

function planSummary(plan) {
  const total = plan.added.length + plan.modified.length
  const bytes = [...plan.added, ...plan.modified].reduce((sum, file) => sum + (file.size || 0), 0)
  return { total, added: plan.added.length, modified: plan.modified.length, links: (plan.links || []).length, bytes }
}

// --- purge --------------------------------------------------------------------

/**
 * Move the selected files of one session into the trash. Only the files the plan
 * listed can be moved: the selection is intersected with the preview, so a request
 * cannot name a path the dialog never offered (an untouched project file, a link,
 * something outside the working directory).
 * @param options - the session, its root, the selected relative paths, the trash
 * index, the config, and the plan the selection came from.
 * @returns the manifest and a per-path report.
 */
function purgeSelection({ sessionId, root, paths, index, config, note, plan }) {
  const previewed = new Map()
  for (const file of [...((plan && plan.added) || []), ...((plan && plan.modified) || [])]) {
    previewed.set(normalizeKey(file.path), file.change)
  }
  const links = new Set(((plan && plan.links) || []).map((link) => normalizeKey(link)))
  const files = []
  const refused = []
  const directories = new Set()
  for (const candidate of paths) {
    const key = normalizeKey(String(candidate || ''))
    if (links.has(key)) {
      refused.push({ path: key, error: 'is a symbolic link or junction, which is never moved' })
      continue
    }
    if (!previewed.has(key)) {
      refused.push({ path: key, error: 'not in the previewed file list' })
      continue
    }
    const absolute = resolveInside(root, key)
    if (absolute === null) {
      refused.push({ path: key, error: 'outside the session directory' })
      continue
    }
    const hazard = symlinkHazard(root, key)
    if (hazard !== null) {
      refused.push({ path: key, error: hazard })
      continue
    }
    let stat
    try {
      stat = fs.lstatSync(absolute)
    } catch {
      refused.push({ path: key, error: 'missing' })
      continue
    }
    if (stat.isSymbolicLink()) {
      refused.push({ path: key, error: 'is a symbolic link, which is never moved' })
      continue
    }
    if (!stat.isFile()) {
      refused.push({ path: key, error: 'not a regular file' })
      continue
    }
    files.push({ absolute, relative: key })
    let parent = path.dirname(key)
    while (parent !== '.' && parent !== '/' && parent !== '') {
      directories.add(normalizeKey(parent))
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
    // The folder itself may be real while one of its parents has become a link, in
    // which case "remove the now-empty folder" would be removing a folder elsewhere.
    if (parentHazard(root, relative) !== null) continue
    try {
      // A link that happens to sit where a folder used to be is not that folder;
      // readdir would follow it and rmdir would fail (or, worse, look successful).
      if (fs.lstatSync(absolute).isSymbolicLink()) continue
      if (!fs.lstatSync(absolute).isDirectory()) continue
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
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
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

// --- http admission -----------------------------------------------------------

// The service whose verdict decides whether a request may reach a route at all.
// Read per request: the web server and the connection service activate in either
// order, and a disposed plugin must stop answering instead of caching a yes.
function connectionOf(ctx) {
  try {
    const service = ctx.get('connection')
    return service && typeof service.admit === 'function' ? service : null
  } catch {
    return null
  }
}

/**
 * Ask the harness whether this request may use the plugin's routes.
 *
 * `connection.admit` is the gate `/api` itself passes through: it rejects a
 * foreign Host or Origin with 403, and a caller without the browser session with
 * 401. That session is a launch-token-derived cookie, HttpOnly, SameSite=Strict,
 * bound to this hostname and port and signed with a key the browser cannot
 * mint — so answering 200 here means the request came from the Web UI this
 * harness started, not from a page on another origin and not from a bare script.
 * Without the service there is no authenticated browser surface at all, and the
 * route fails closed rather than serving session titles and file moves to
 * whoever can reach the loopback port.
 *
 * @param ctx - host context.
 * @param req - the node request.
 * @returns the rejection status (401/403/503), or 0 when the request is admitted.
 */
function admissionStatus(ctx, req) {
  const connection = connectionOf(ctx)
  if (connection === null) {
    diagnose('http-admission-skipped', 'no connection service; refusing unauthenticated access')
    return 503
  }
  let admission
  try {
    admission = connection.admit(req)
  } catch (error) {
    diagnose('http-admission-failed', String((error && error.message) || error))
    return 403
  }
  if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
    const status = Number(admission.rejection)
    return status === 401 || status === 403 ? status : 403
  }
  return 0
}

const REJECTION_TEXT = {
  401: 'unauthorized',
  403: 'forbidden',
  415: 'content-type must be application/json',
  503: 'the connection service is unavailable, so this route refuses unauthenticated access',
}

// A mutation must not be reachable as a cross-site "simple request": requiring a
// JSON content type means a form post, an <img> probe or a link prefetch cannot
// reach one, even if the cookie policy above ever loosened.
function isJsonRequest(req) {
  const header = String((req.headers && req.headers['content-type']) || '').toLowerCase()
  return header.startsWith('application/json')
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
            const rejection = admissionStatus(ctx, req)
            if (rejection !== 0) {
              sendJson(res, rejection, { error: REJECTION_TEXT[rejection] || 'forbidden' })
              return
            }
            if (method === 'POST' && !isJsonRequest(req)) {
              sendJson(res, 415, { error: REJECTION_TEXT[415] })
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
      assertPlanMatches(result, args.planId)
      const { manifest, refused } = purgeSelection({
        sessionId,
        root: result.root,
        paths,
        index,
        config,
        plan: result,
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
        assertPlanMatches(result, args.planId)
        const outcome = purgeSelection({
          sessionId,
          root: result.root,
          paths,
          index,
          config,
          plan: result,
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
      const renamed = []
      const failed = []
      const restoredSources = new Set()
      for (const file of wanted) {
        try {
          // A file already back at the original path is never overwritten: the
          // trashed copy lands beside it and both names are reported.
          const outcome = restoreFile(manifest, file.path)
          restored.push(outcome.relative)
          if (outcome.renamed) renamed.push({ from: file.path, to: outcome.relative })
          restoredSources.add(file.path)
        } catch (error) {
          failed.push({ path: file.path, error: String((error && error.message) || error) })
        }
      }
      const remaining = manifest.files.filter((file) => !restoredSources.has(file.path))
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
      return { restored, renamed, failed, remaining: remaining.length }
    })

    route('POST', '/__sespurge/trash/drop', async (args) => {
      // Three shapes, one rule: a batch only goes for good when the caller names
      // it. `id` is the row button, `ids` is the panel's selection — it sends the
      // batches it actually listed, so a stale panel cannot take out a newer one —
      // and `all: true` is the explicit "empty the trash" switch.
      const named = Array.isArray(args.ids) ? args.ids : []
      const wanted = args.all === true
        ? index.entries.map((entry) => entry.id)
        : named.length > 0
          ? named.map((value) => String(value ?? ''))
          : typeof args.id === 'string' && args.id !== ''
            ? [args.id]
            : []
      if (wanted.length === 0) {
        if (args.all === true) return { dropped: [], failed: [], remaining: index.entries.length }
        throw new PurgeError('drop needs an entry id, a list of ids, or all: true', 400)
      }
      const dropped = []
      const failed = []
      const seen = new Set()
      for (const raw of wanted) {
        const id = String(raw)
        if (seen.has(id)) continue
        seen.add(id)
        // manifest() refuses separators and "..", so an id from a caller can only
        // ever name a directory directly under the trash root.
        const manifest = index.manifest(id)
        if (manifest === null) {
          failed.push({ id, error: 'that trash entry no longer exists' })
          continue
        }
        try {
          dropTrashEntry(manifest)
          index.remove(id)
          dropped.push(id)
        } catch (error) {
          failed.push({ id, error: String((error && error.message) || error) })
        }
      }
      // One named batch that is not there is still a 404, exactly as before the
      // bulk shape existed: a single miss is an error, a partial selection is a
      // report the panel can show.
      if (wanted.length === 1 && dropped.length === 0 && failed.length === 1) {
        throw new PurgeError('that trash entry no longer exists', 404)
      }
      return { dropped, failed, remaining: index.entries.length }
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

  // Tool definitions stay in the shorthand below, but the registry forwards the
  // definition to the model provider verbatim: the @deepseek-ai/dsh-tools peer is
  // optional, and an identity defineTool (a leftover test stub used to be copied
  // into profile installs) forwarded the shorthand as-is — an object without
  // "type", which the provider rejects with "schema must be a JSON Schema of
  // type object" and which broke every request in every non-ptc preset. Owning
  // the conversion here removes the dependency on that peer entirely.
  //
  // The model tool: plan or purge the files of one session. Registered through a
  // deferred inject so a composition without the tool registry still loads.
  ctx.inject(['tools'], (sub) => {
    sub.effect(() =>
      sub.tools.register(
        defineTool({
          name: 'session_files',
          description:
            'List or clean up the files one session of this workbench produced. mode "list" reports the files the session created or changed since its baseline snapshot; mode "purge" moves the given paths into the plugin trash directory (never deleting them outright). Only paths that mode "list" reported for the same session can be moved, and symbolic links are listed but never moved. The harness keeps no per-session file ledger, so the report comes from diffing the working directory against the snapshot taken when the session started.',
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
            if (summary.links > 0) {
              lines.push(`links: ${summary.links} (symbolic links and junctions are reported, never moved)`)
            }
            for (const file of result.added.slice(0, 100)) lines.push(`+ ${file.path} (${file.size} bytes)`)
            for (const file of result.modified.slice(0, 100)) lines.push(`~ ${file.path} (${file.size} bytes)`)
            if (mode === 'list') return lines.join('\n')

            const paths = Array.isArray(toolArgs.paths) ? toolArgs.paths : []
            if (paths.length === 0) return [...lines, 'purge: no paths were given'].join('\n')
            const outcome = purgeSelection({
              sessionId,
              root: result.root,
              paths,
              index,
              config,
              plan: result,
              note: 'agent tool',
            })
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
