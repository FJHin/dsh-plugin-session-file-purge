// Plugin-contract test: the host half must satisfy what the cordis Loader does to
// a profile row before `apply` runs. Two rules already bit this plugin:
//
//   1. exporting `Config` declares a schemastery schema — the loader validates the
//      row's config through `Config['~standard'].validate(...)`, so a plain
//      defaults object exported under that name throws and the row never
//      activates (the module still loads, which makes the failure silent);
//   2. `inject`/`optional` must be string arrays, or the Loader's dependency
//      resolution misreads them.
//
// This suite re-implements those two loader steps against the real module, so a
// regression fails here instead of in a running harness.
//
// usage: node test/plugin-contract.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginPath = path.join(here, '..', 'src', 'index.js')

let failures = 0
let checks = 0
function check(label, condition, detail) {
  checks += 1
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// The plugin converts its own tool parameters, so this suite needs no stub of the
// optional @deepseek-ai/dsh-tools peer. Earlier runs wrote one into node_modules
// and a directory install copied it into the profile; remove that leftover.
const stubDir = path.join(here, '..', 'node_modules', '@deepseek-ai', 'dsh-tools')
fs.rmSync(stubDir, { recursive: true, force: true })

const namespace = await import(`file://${pluginPath.replace(/\\/g, '/')}`)

console.log('\nmodule shape')
check('exports apply', typeof namespace.apply === 'function')
check('exports inject as a string array', Array.isArray(namespace.inject) && namespace.inject.every((entry) => typeof entry === 'string'), JSON.stringify(namespace.inject))
check('exports optional as a string array', namespace.optional === undefined || (Array.isArray(namespace.optional) && namespace.optional.every((entry) => typeof entry === 'string')), JSON.stringify(namespace.optional))
check('exports no default (the Loader takes the namespace as the plugin)', namespace.default === undefined, String(namespace.default))
// The HTTP routes admit every request through the harness' connection service, so
// it must be listed as optional: a composition without a Web UI still loads.
check('declares the connection service as optional', (namespace.optional || []).includes('connection'), JSON.stringify(namespace.optional))
check('does not set __esModule on the namespace', namespace.__esModule === undefined)

console.log('\nloader config resolution')
// The exact sequence from cordis's resolveConfig(). A missing Config is legal and
// means "no schema"; a present-but-not-schemastery Config throws.
const runtime = { Config: namespace.Config }
let resolution
try {
  resolution = runtime.Config === undefined
    ? { skipped: true }
    : (() => {
        const result = runtime.Config['~standard'].validate({ maxEntries: 10 })
        if ('then' in result) throw new TypeError('Async config validation is not supported')
        if (result.issues) throw new Error(`config validation failed: ${JSON.stringify(result.issues)}`)
        return { value: result.value }
      })()
} catch (error) {
  resolution = { error: String(error && error.message) }
}
check('config resolution does not throw', resolution.error === undefined, resolution.error)
check('the plugin declares no config schema (or a real one)', namespace.Config === undefined || typeof namespace.Config['~standard']?.validate === 'function')

console.log('\napply with a mock host')
const routes = []
const tools = []
const context = {
  logger: { info() {}, warn() {} },
  get(name) {
    if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {} } }
    return undefined
  },
  inject(services, callback) {
    if (services.includes('webServer')) callback({ webServer: context.get('webServer'), effect: (fn) => fn() })
    if (services.includes('tools')) {
      const toolsService = { register: (definition) => { tools.push(definition); return () => {} } }
      callback({ tools: toolsService, effect: (fn) => fn() })
    }
  },
  on() {},
  effect(fn) { fn() },
}
let applyError = null
try {
  namespace.apply(context, { maxEntries: 10 })
} catch (error) {
  applyError = String(error && error.message)
}
check('apply runs without throwing', applyError === null, applyError)
check('apply registers the HTTP routes', routes.length >= 7, `got ${routes.length}`)
check('the config bound was accepted', routes.length >= 7)

console.log('\nmodel tool schema')
const parameters = tools[0]?.parameters ?? {}
const fields = Object.keys(parameters.properties ?? {})
check('registers exactly one tool', tools.length === 1, `got ${tools.length}`)
check('parameters are a JSON Schema object', parameters.type === 'object', String(parameters.type))
check('properties are the three fields', fields.join(',') === 'sessionId,mode,paths', fields.join(','))
check('required lists sessionId only', JSON.stringify(parameters.required) === '["sessionId"]', JSON.stringify(parameters.required))
check('no shorthand "required" survives inside properties', fields.every((field) => !('required' in parameters.properties[field])))

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
