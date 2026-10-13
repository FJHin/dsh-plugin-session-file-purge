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
 * Build the fake host context: the services the plugin reads, an HTTP route
 * table, a tool registry, and event emitters that behave like cordis's.
 */
function makeContext({ home, workspaceRoot }) {
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
async function callRoute(routes, routePath, { method = 'POST', body = {} } = {}) {
  const route = routes.find((entry) => entry.path === routePath)
  if (!route) throw new Error(`no route registered at ${routePath}`)
  const chunks = []
  const serialized = JSON.stringify(body)
  const req = {
    method,
    headers: { 'content-length': String(Buffer.byteLength(serialized)) },
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

const { context, routes, tools } = makeContext({ home, workspaceRoot: workspace })
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
  body: { sessionId, paths: ['report.docx', 'out/chart.png', '../escape.txt'] },
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
const cleanup = await callRoute(routes, '/__sespurge/cleanup', {
  body: { sessionId, paths: ['report.docx', 'out/chart.png'], deleteSession: true },
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
// forgotten with the session), so the two new files register as created.
fs.mkdirSync(path.join(home, 'sessions', '--tmp--', sessionId), { recursive: true })
fs.writeFileSync(path.join(home, 'sessions', '--tmp--', sessionId, 'session.v4.jsonl.zstd'), 'log')
context.emit('session/disposed', session)
fs.writeFileSync(path.join(workspace, 'a.txt'), 'a')
fs.writeFileSync(path.join(workspace, 'b.txt'), 'b')
context.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } })
await new Promise((resolve) => setTimeout(resolve, 400))
const second = await callRoute(routes, '/__sespurge/purge', { body: { sessionId, paths: ['a.txt', 'b.txt'] } })
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

console.log('\nmodel tool')
check('one tool registered', tools.length === 1, `got ${tools.length}`)
if (tools[0]) {
  const listed = await tools[0].execute({ sessionId, mode: 'list' })
  check('tool lists the session directory and baseline', listed.includes(workspace) && /baseline captured/.test(listed), listed)
  const purgedByTool = await tools[0].execute({ sessionId, mode: 'purge', paths: ['a.txt'] })
  check('tool purges a named path', /moved into trash: 1/.test(purgedByTool), purgedByTool)
  check('tool purge moved the file', !fs.existsSync(path.join(workspace, 'a.txt')))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
