// Test harness for the host half. `@deepseek-ai/dsh-tools` only exists in a real
// DSH runtime, so the stub below is installed before the plugin module is
// imported, letting this script exercise the plugin's behaviour with plain node.
//
// usage: node test/harness.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginPath = path.join(here, '..', 'src', 'index.js')

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/**
 * The service every plugin route is admitted through. A real one is the harness'
 * browser/API gate: it rejects a foreign Host or Origin with 403 and a caller
 * without the signed browser-session cookie with 401. The fake below models those
 * two verdicts plus the two shapes this plugin must survive — a service that
 * throws and a composition that has no connection service at all.
 */
function makeConnection() {
  const state = { mode: 'admit', seen: [] }
  return {
    state,
    admit(request) {
      state.seen.push(request)
      if (state.mode === 'throw') throw new Error('the connection service is disposed')
      if (state.mode === 'reject401') return { rejection: 401 }
      if (state.mode === 'reject403') return { rejection: 403 }
      return { peer: { principal: { kind: 'owner' } } }
    },
  }
}

/**
 * Build the fake host context: the services the plugin reads, an HTTP route
 * table, a tool registry, and event emitters that behave like cordis's.
 */
function makeContext({ home, workspaceRoot, connection = null }) {
  const routes = []
  const tools = []
  const listeners = new Map()
  const disposers = []
  /**
   * Run one effect body immediately, as cordis does when a fiber loads, and keep
   * the disposer it returns.
   * @param fn - the effect body.
   * @returns the disposable the caller may ignore.
   */
  function effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
    return disposer
  }
  const storageTables = {
    session_projcache: {
      sessions: {
        rows: new Map([['session-11111111-1111-1111-1111-111111111111', { identity: { createdAt: 1 }, rows: { title: { val: 'fake session' } } }]]),
        get(key) { return this.rows.get(key) },
        async delete(key) { this.rows.delete(key) },
        entries() { return [...this.rows.entries()] },
      },
    },
    workspace: {
      workspaces: {
        rows: new Map([['w1', { sessionIds: ['session-11111111-1111-1111-1111-111111111111', 'other'] }]]),
        async put(key, value) { this.rows.set(key, value) },
        entries() { return [...this.rows.entries()] },
      },
      global: {
        state: { archivedSessionIds: ['session-11111111-1111-1111-1111-111111111111'] },
        get() { return this.state },
        async set(value) { this.state = value },
      },
    },
  }

  const context = {
    logger: { info() {}, warn() {} },
    get(service) {
      if (service === 'storageDomain') {
        return {
          get: (domain) => ({
            table: (table) => storageTables[domain][table],
            global: storageTables[domain].global,
          }),
        }
      }
      if (service === 'webServer') return { register: (route) => { routes.push(route); return () => {} } }
      if (service === 'connection') return connection
      if (service === 'workspaceRegistry') return { list: () => [{ dir: workspaceRoot, sessionIds: ['session-11111111-1111-1111-1111-111111111111'] }] }
      return undefined
    },
    inject(services, callback) {
      if (services.includes('webServer')) {
        callback({ webServer: { register: (route) => { routes.push(route); return () => {} } }, effect })
        return
      }
      if (services.includes('tools')) {
        callback({
          tools: { register: (tool) => tools.push(tool) },
          effect,
        })
      }
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
    },
    effect,
    emit(event, ...args) {
      for (const listener of listeners.get(event) || []) listener(...args)
    },
  }

  return { context, routes, tools, listeners, emit: context.emit, storageTables, disposers }
}

/** Invoke one registered route the way the web server would. */
async function callRoute(routes, routePath, { method = 'POST', body = {}, headers = null } = {}) {
  const route = routes.find((entry) => entry.path === routePath)
  if (!route) throw new Error(`no route registered at ${routePath}`)
  const chunks = []
  const serialized = JSON.stringify(body)
  const req = {
    method,
    headers: {
      'content-length': String(Buffer.byteLength(serialized)),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      ...(headers || {}),
    },
    on(event, listener) {
      if (event === 'data') {
        if (serialized !== undefined) listener(serialized)
      }
      if (event === 'end') listener()
    },
  }
  let status = 0
  let payload = null
  const res = {
    writeHead(code) { status = code },
    end(text) { payload = text ? JSON.parse(text) : null },
  }
  await route.handler(req, res)
  return { status, payload }
}

// --- stub @deepseek-ai/dsh-tools for this process -----------------------------

const stubDir = path.join(here, '..', 'node_modules', '@deepseek-ai', 'dsh-tools')
fs.mkdirSync(stubDir, { recursive: true })
fs.writeFileSync(
  path.join(stubDir, 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-stub', type: 'module', main: 'index.js' }),
)
fs.writeFileSync(path.join(stubDir, 'index.js'), 'export const defineTool = (definition) => definition\n')

// --- fixtures -----------------------------------------------------------------

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sespurge-home-'))
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sespurge-ws-'))
process.env.DSH_HOME = home

const sessionId = 'session-11111111-1111-1111-1111-111111111111'
fs.mkdirSync(path.join(home, 'sessions', '--tmp--', sessionId), { recursive: true })
fs.writeFileSync(path.join(home, 'sessions', '--tmp--', sessionId, 'session.v4.jsonl.zstd'), 'log')

// A directory that looks like a project before the session runs.
fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
fs.mkdirSync(path.join(workspace, 'node_modules', 'ignored'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'src', 'existing.txt'), 'before')
fs.writeFileSync(path.join(workspace, 'node_modules', 'ignored', 'package.json'), '{}')

const session = { id: sessionId, header: { cwd: workspace } }

const connection = makeConnection()
const { context, routes, tools } = makeContext({ home, workspaceRoot: workspace, connection })
const { apply } = await import(`file://${pluginPath.replace(/\\/g, '/')}`)
// The import above resolves the real package name; re-import the stubbed copy by
// path so this harness runs without a DSH installation.
apply(context, { maxEntries: 5000, baselineBudgetMs: 5000, planBudgetMs: 5000 })

console.log('\napply registered everything')
check('eight routes registered', routes.length === 8, `got ${routes.length}: ${routes.map((route) => route.path).join(', ')}`)
check('the ping route reports the plugin', routes.some((route) => route.path === '/__sespurge/ping'))
check('the diagnostics log recorded the boot', fs.existsSync(path.join(home, 'session-file-purge', 'diagnostics.log')))
check('one tool registered', tools.length === 1, `got ${tools.length}`)

console.log('\nbaseline capture')
context.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
await new Promise((resolve) => setTimeout(resolve, 400))
const baselineFile = path.join(home, 'session-file-purge', 'baselines', `${sessionId}.json`)
check('baseline written for the session', fs.existsSync(baselineFile))
const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))
check('baseline records the existing file', baseline.files['src/existing.txt'] !== undefined)
check('baseline skipped node_modules', Object.keys(baseline.files).every((key) => !key.startsWith('node_modules')))

console.log('\nplan after the session writes files')
fs.writeFileSync(path.join(workspace, 'report.docx'), 'x'.repeat(2048))
fs.mkdirSync(path.join(workspace, 'out'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'out', 'chart.png'), 'y'.repeat(512))
fs.appendFileSync(path.join(workspace, 'src', 'existing.txt'), 'after')

const planned = await callRoute(routes, '/__sespurge/plan', { body: { sessionId } })
check('plan route answers ok', planned.status === 200 && planned.payload.ok === true, JSON.stringify(planned.payload))
const plan = planned.payload.value
check('created files are listed', plan.added.some((file) => file.path === 'report.docx') && plan.added.some((file) => file.path === 'out/chart.png'))
check('changed file is listed separately', plan.modified.some((file) => file.path === 'src/existing.txt'))
check('created files start checked', plan.added.every((file) => file.checked === true))
check('changed files start unchecked', plan.modified.every((file) => file.checked === false))

console.log('\npurge into the trash')
const purged = await callRoute(routes, '/__sespurge/purge', {
  body: { sessionId, paths: ['report.docx', 'out/chart.png', '../escape.txt'], planId: plan.planId },
})
check('purge route answers ok', purged.status === 200 && purged.payload.ok === true, JSON.stringify(purged.payload))
const purgeValue = purged.payload.value
check('two files moved', purgeValue.moved.length === 2, JSON.stringify(purgeValue.moved))
check('escaping path refused', purgeValue.failed.some((entry) => entry.path === '../escape.txt'))
check('file no longer in the workspace', !fs.existsSync(path.join(workspace, 'report.docx')))
check('emptied folder removed', !fs.existsSync(path.join(workspace, 'out')))
check('manifest exists in the trash', fs.existsSync(path.join(purgeValue.trashDir, 'manifest.json')))

console.log('\nrestore from the trash')
const trash = await callRoute(routes, '/__sespurge/trash', { method: 'GET' })
check('trash lists the purge', trash.payload.value.entries.length === 1)
const restored = await callRoute(routes, '/__sespurge/trash/restore', { body: { id: purgeValue.trashId } })
check('restore answers ok', restored.payload.ok === true, JSON.stringify(restored.payload))
check('file is back', fs.existsSync(path.join(workspace, 'report.docx')) && fs.existsSync(path.join(workspace, 'out', 'chart.png')))

console.log('\ncleanup: purge and delete the session')
const beforeCleanup = await callRoute(routes, '/__sespurge/plan', { body: { sessionId } })
const cleanup = await callRoute(routes, '/__sespurge/cleanup', {
  body: { sessionId, paths: ['report.docx', 'out/chart.png'], planId: beforeCleanup.payload.value.planId, deleteSession: true },
})
check('cleanup answers ok', cleanup.payload.ok === true, JSON.stringify(cleanup.payload))
const cleanupValue = cleanup.payload.value
check('cleanup purged the selection', cleanupValue.purged && cleanupValue.purged.moved.length === 2)
check('cleanup deleted the session log', !fs.existsSync(path.join(home, 'sessions', '--tmp--', sessionId)))
check('cleanup dropped the projection row', cleanupValue.deleted.projRemoved === true)
check('cleanup dropped the workspace accounting', cleanupValue.deleted.workspaceRemoved === true)
check('baseline forgotten', !fs.existsSync(baselineFile))

console.log('\nrestore a selected subset')
// A fresh session cycle: the same id, a new baseline (the previous one was
// forgotten with the session). The two files appear after the snapshot, so the
// preview lists them as created and the purge is allowed to name them.
fs.mkdirSync(path.join(home, 'sessions', '--tmp--', sessionId), { recursive: true })
fs.writeFileSync(path.join(home, 'sessions', '--tmp--', sessionId, 'session.v4.jsonl.zstd'), 'log')
context.emit('session/disposed', session)
context.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } })
await new Promise((resolve) => setTimeout(resolve, 400))
fs.writeFileSync(path.join(workspace, 'a.txt'), 'a')
fs.writeFileSync(path.join(workspace, 'b.txt'), 'b')
const secondPlan = await callRoute(routes, '/__sespurge/plan', { body: { sessionId } })
check('the second preview lists both files', secondPlan.payload.value.added.length === 2, JSON.stringify(secondPlan.payload.value.added))
const second = await callRoute(routes, '/__sespurge/purge', {
  body: { sessionId, paths: ['a.txt', 'b.txt'], planId: secondPlan.payload.value.planId },
})
check('the new cycle purges both files', second.payload.ok === true && second.payload.value.moved.length === 2, JSON.stringify(second.payload))
const secondId = second.payload.value.trashId
const partial = await callRoute(routes, '/__sespurge/trash/restore', { body: { id: secondId, paths: ['a.txt'] } })
check('only the named file is restored', partial.payload.value.restored.length === 1 && partial.payload.value.remaining === 1)
check('the named file is back', fs.existsSync(path.join(workspace, 'a.txt')))
check('the other file is still in the trash', !fs.existsSync(path.join(workspace, 'b.txt')))

console.log('\ntrash housekeeping')
const dropped = await callRoute(routes, '/__sespurge/trash/drop', { body: { id: secondId } })
check('drop answers ok', dropped.payload.ok === true)
const afterDrop = await callRoute(routes, '/__sespurge/trash', { method: 'GET' })
check('the entry is gone from the index', !afterDrop.payload.value.entries.some((entry) => entry.id === secondId))

console.log('\nvalidation')
const bad = await callRoute(routes, '/__sespurge/plan', { body: { sessionId: 'not-a-session' } })
check('invalid session id refused', bad.status === 400 && bad.payload.ok === undefined)
const wrongMethod = await callRoute(routes, '/__sespurge/plan', { method: 'GET' })
check('wrong method refused', wrongMethod.status === 405)
const unknownEntry = await callRoute(routes, '/__sespurge/trash/restore', { body: { id: 'nope' } })
check('unknown trash entry refused', unknownEntry.status === 404)
const escaping = await callRoute(routes, '/__sespurge/trash/restore', { body: { id: '../../etc' } })
check('path-traversal trash id refused', escaping.status === 404)

console.log('\nhttp admission')
// Every route asks the harness' connection service before it runs: 401 without a
// browser session, 403 from a foreign origin, 503 when the composition has no
// connection service, and 415 for a mutation that does not declare JSON.
const admitsBefore = connection.state.seen.length
fs.writeFileSync(path.join(workspace, 'keep.txt'), 'keep')
connection.state.mode = 'reject401'
const unauthPing = await callRoute(routes, '/__sespurge/ping', { method: 'GET' })
check('an unauthenticated ping is refused', unauthPing.status === 401, JSON.stringify(unauthPing))
const unauthList = await callRoute(routes, '/__sespurge/session/list', { method: 'GET' })
check('an unauthenticated session list is refused', unauthList.status === 401 && unauthList.payload.value === undefined, JSON.stringify(unauthList))
const unauthPurge = await callRoute(routes, '/__sespurge/purge', { body: { sessionId, paths: ['keep.txt'] } })
check('an unauthenticated purge is refused', unauthPurge.status === 401, JSON.stringify(unauthPurge))
check('the refused purge moved nothing', fs.existsSync(path.join(workspace, 'keep.txt')))
connection.state.mode = 'reject403'
const foreign = await callRoute(routes, '/__sespurge/ping', { method: 'GET' })
check('a foreign origin is refused', foreign.status === 403, JSON.stringify(foreign))
connection.state.mode = 'throw'
const disposed = await callRoute(routes, '/__sespurge/ping', { method: 'GET' })
check('a failing connection service fails closed', disposed.status === 403, JSON.stringify(disposed))
connection.state.mode = 'admit'
check('every request reached the connection service first', connection.state.seen.length - admitsBefore === 5, `got ${connection.state.seen.length - admitsBefore}`)
const plainText = await callRoute(routes, '/__sespurge/plan', { body: { sessionId }, headers: { 'content-type': 'text/plain' } })
check('a non-JSON mutation is refused', plainText.status === 415, JSON.stringify(plainText))
const admittedPing = await callRoute(routes, '/__sespurge/ping', { method: 'GET' })
check('the admitted ping answers', admittedPing.status === 200 && admittedPing.payload.value.plugin === 'session-file-purge', JSON.stringify(admittedPing))

const bare = makeContext({ home, workspaceRoot: workspace })
apply(bare.context, { maxEntries: 5000, baselineBudgetMs: 5000, planBudgetMs: 5000 })
check('a composition without a connection service still registers the routes', bare.routes.length === 8, `got ${bare.routes.length}`)
const closedPing = await callRoute(bare.routes, '/__sespurge/ping', { method: 'GET' })
check('without a connection service the route fails closed', closedPing.status === 503, JSON.stringify(closedPing))

console.log('\nmodel tool')
check('one tool registered', tools.length === 1, `got ${tools.length}`)
if (tools[0]) {
  const listed = await tools[0].execute({ sessionId, mode: 'list' })
  check('tool lists the session directory and baseline', listed.includes(workspace) && /baseline captured/.test(listed), listed)
  const purgedByTool = await tools[0].execute({ sessionId, mode: 'purge', paths: ['a.txt'] })
  check('tool purges a named path', /moved into trash: 1/.test(purgedByTool), purgedByTool)
  check('tool purge moved the file', !fs.existsSync(path.join(workspace, 'a.txt')))
}

console.log('\nplan bound selection')
// A third cycle for the same session. The preview digest binds a purge to the
// file list the user actually saw, and any link in the working tree is reported
// but never moved: renaming a link would break it, and copying its target would
// pull outside content into the trash.
fs.mkdirSync(path.join(home, 'sessions', '--tmp--', sessionId), { recursive: true })
fs.writeFileSync(path.join(home, 'sessions', '--tmp--', sessionId, 'session.v4.jsonl.zstd'), 'log')
context.emit('session/disposed', session)
context.emit('session/event', session, { type: 'turn/start', data: { turn: 3 } })
await new Promise((resolve) => setTimeout(resolve, 400))
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sespurge-outside-'))
fs.writeFileSync(path.join(outsideDir, 'outside.txt'), 'outside')
fs.writeFileSync(path.join(workspace, 'c.txt'), 'c')
// A junction is the one link a Windows machine without developer mode can make,
// and Node reports it as an ordinary directory, so only real paths tell it apart.
fs.symlinkSync(outsideDir, path.join(workspace, 'linked'), 'junction')
const thirdPlan = await callRoute(routes, '/__sespurge/plan', { body: { sessionId } })
const third = thirdPlan.payload.value
check('the preview carries a plan id', typeof third.planId === 'string' && /^p1-[0-9a-f]{32}$/.test(third.planId), JSON.stringify(third.planId))
check('the preview lists the new file', third.added.some((file) => file.path === 'c.txt'), JSON.stringify(third.added.map((file) => file.path)))
check('the preview reports the junction', third.links.includes('linked'), JSON.stringify(third.links))
const listedWithLink = await tools[0].execute({ sessionId, mode: 'list' })
check('the tool list reports the junction', /links: 1 \(symbolic links and junctions are reported, never moved\)/.test(listedWithLink), listedWithLink)
const stalePlan = await callRoute(routes, '/__sespurge/purge', {
  body: { sessionId, paths: ['c.txt'], planId: 'p1-00000000000000000000000000000000' },
})
check('a purge whose preview no longer matches is refused', stalePlan.status === 409, JSON.stringify(stalePlan))
const missingPlan = await callRoute(routes, '/__sespurge/purge', { body: { sessionId, paths: ['c.txt'] } })
check('a purge without a plan id is refused', missingPlan.status === 400, JSON.stringify(missingPlan))
const unpicked = await callRoute(routes, '/__sespurge/purge', {
  body: { sessionId, paths: ['node_modules/ignored/package.json'], planId: third.planId },
})
check('a file the preview never offered is refused', unpicked.payload.value.moved.length === 0 &&
  unpicked.payload.value.failed.some((entry) => entry.error === 'not in the previewed file list'), JSON.stringify(unpicked.payload.value))
check('the refused file is still in place', fs.existsSync(path.join(workspace, 'node_modules', 'ignored', 'package.json')))
const linked = await callRoute(routes, '/__sespurge/purge', { body: { sessionId, paths: ['linked'], planId: third.planId } })
check('a junction is refused', linked.payload.value.moved.length === 0 &&
  linked.payload.value.failed.some((entry) => /symbolic link or junction/.test(entry.error)), JSON.stringify(linked.payload.value))
check('the junction still points outside', fs.existsSync(path.join(workspace, 'linked', 'outside.txt')))
const movedC = await callRoute(routes, '/__sespurge/purge', { body: { sessionId, paths: ['c.txt'], planId: third.planId } })
check('the previewed file still moves', movedC.payload.value.moved.length === 1, JSON.stringify(movedC.payload.value))

console.log('\nrestore never overwrites')
fs.writeFileSync(path.join(workspace, 'c.txt'), 'newer')
const keptRestore = await callRoute(routes, '/__sespurge/trash/restore', { body: { id: movedC.payload.value.trashId } })
check('the restore answers ok', keptRestore.payload.ok === true, JSON.stringify(keptRestore.payload))
const restoreValue = keptRestore.payload.value
check('the restored file is reported under a new name',
  restoreValue.renamed.length === 1 && restoreValue.renamed[0].to === 'c (restored).txt', JSON.stringify(restoreValue.renamed))
check('the file already in place is untouched', fs.readFileSync(path.join(workspace, 'c.txt'), 'utf8') === 'newer')
check('the trashed copy came back beside it', fs.readFileSync(path.join(workspace, 'c (restored).txt'), 'utf8') === 'c')

console.log('\nrestore through a link is refused')
// The narrow case left over after the overwrite fix: the file itself is gone, but a
// directory above it has since become a junction. Resolving the leaf alone cannot
// see that, so the restore has to refuse instead of writing into the link's target.
fs.mkdirSync(path.join(workspace, 'nested'), { recursive: true })
fs.writeFileSync(path.join(workspace, 'nested', 'deep.txt'), 'deep')
const fourthPlan = await callRoute(routes, '/__sespurge/plan', { body: { sessionId } })
check(
  'the preview lists the nested file',
  fourthPlan.payload.value.added.some((file) => file.path === 'nested/deep.txt'),
  JSON.stringify(fourthPlan.payload.value.added.map((file) => file.path)),
)
const movedDeep = await callRoute(routes, '/__sespurge/purge', {
  body: { sessionId, paths: ['nested/deep.txt'], planId: fourthPlan.payload.value.planId },
})
check('the nested file moves into the trash', movedDeep.payload.value.moved.length === 1, JSON.stringify(movedDeep.payload.value))
check('the emptied folder is removed', !fs.existsSync(path.join(workspace, 'nested')))
const restoreTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'sespurge-restore-'))
let nestedLink = false
try {
  fs.symlinkSync(restoreTarget, path.join(workspace, 'nested'), 'junction')
  nestedLink = true
} catch {
  nestedLink = false
}
if (!nestedLink) {
  console.log('  skip: this machine cannot create the junction the case needs')
} else {
  const refused = await callRoute(routes, '/__sespurge/trash/restore', { body: { id: movedDeep.payload.value.trashId } })
  const refusedValue = refused.payload.value
  check(
    'a restore whose parent became a link is refused',
    refusedValue.restored.length === 0 && refusedValue.failed.some((entry) => /refuses a restore/.test(entry.error)),
    JSON.stringify(refusedValue),
  )
  check('nothing was written through the link', fs.readdirSync(restoreTarget).length === 0, fs.readdirSync(restoreTarget).join(','))
  check('the trashed copy stays in the trash', refusedValue.remaining === 1, JSON.stringify(refusedValue))
  fs.rmSync(path.join(workspace, 'nested'), { recursive: true, force: true })
}
fs.rmSync(restoreTarget, { recursive: true, force: true })

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
