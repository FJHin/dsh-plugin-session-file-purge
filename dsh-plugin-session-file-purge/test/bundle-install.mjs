// Bundle-install contract: what the DSH launcher does to an installed bundle
// before any plugin code runs.
//
//  1. `dsh.profile.bundles` names the package; `resolveBundleDir` finds it in the
//     profile's node_modules;
//  2. its manifest must declare `dsh.bundle.patch`, resolved relative to the
//     package directory;
//  3. that patch file inserts a row whose `name` the loader imports **as a module
//     specifier**, from the profile directory.
//
// All four names therefore have to agree: the package name, the bundles entry,
// the patch row name, and the node_modules directory. Getting this wrong is not
// loud — the bundle is skipped and the profile starts without it — so it is
// tested by reproducing the layout in a temporary directory and importing the row
// name the way the loader would.
//
// usage: node test/bundle-install.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(here, '..')

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

const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))

console.log('\nmanifest')
check('the package declares a name', typeof manifest.name === 'string' && manifest.name.length > 0, manifest.name)
check('the package is not private (it is meant to be published)', manifest.private !== true)
check('the package declares dsh.bundle.patch', typeof manifest.dsh?.bundle?.patch === 'string', JSON.stringify(manifest.dsh?.bundle))
check('the package declares a web client bundle', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client))
check('the client bundle is exported as ./client', manifest.exports?.['./client'] !== undefined, JSON.stringify(manifest.exports))
check('the bundle patch is listed in files (so npm pack ships it)', (manifest.files || []).includes('cordis.patch.yml'))
check('the declared peer range accepts the current runtime line', /0\.\d+\.\d+/.test(manifest.peerDependencies?.['@deepseek-ai/dsh-tools'] || ''), manifest.peerDependencies?.['@deepseek-ai/dsh-tools'])
check('the optional peer is declared optional', manifest.peerDependenciesMeta?.['@deepseek-ai/dsh-tools']?.optional === true)

// The market and the loader both read this: `engines.dsh` is the version range the
// author claims, `dsh.manifestVersion` the manifest format it is written in.
check('the package declares a DSH compatibility range', typeof manifest.engines?.dsh === 'string' && manifest.engines.dsh.trim().length > 0, JSON.stringify(manifest.engines))
check('the DSH range is a plain semver range', /^[\s]*[><=^~0-9vx*]/.test(manifest.engines?.dsh || '') && !/workspace:/.test(manifest.engines?.dsh || ''), manifest.engines?.dsh)
check('the DSH range spans a release line, not one exact build', /[<>^~]/.test(manifest.engines?.dsh || ''), manifest.engines?.dsh)
check('the package declares the manifest format', manifest.dsh?.manifestVersion === 1, String(manifest.dsh?.manifestVersion))
check('the version is strict semver', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version || ''), manifest.version)

console.log('\nbundle patch')
const patchPath = path.join(packageDir, manifest.dsh.bundle.patch)
check('the declared patch file exists', fs.existsSync(patchPath), patchPath)
const patchText = fs.readFileSync(patchPath, 'utf8')
const rowIds = [...patchText.matchAll(/^\s*-\s*id:\s*(\S+)\s*$/gm)].map((match) => match[1])
const rowNames = [...patchText.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((match) => match[1])
check('the patch inserts exactly one row', rowIds.length === 1 && rowNames.length === 1, `ids=${JSON.stringify(rowIds)} names=${JSON.stringify(rowNames)}`)
check('the row name equals the package name', rowNames[0] === manifest.name, `row=${rowNames[0]} package=${manifest.name}`)
check('the row has an id for profile patches to target', typeof rowIds[0] === 'string' && rowIds[0].length > 0, rowIds[0])

console.log('\nsimulated installed layout')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sespurge-profile-'))
const modulesDir = path.join(home, 'node_modules')
fs.mkdirSync(modulesDir, { recursive: true })

// A real launcher resolves the peer from the dsh installation's runtime
// resolution, which this test does not have; a stub in the same node_modules
// stands in, exactly as the other suites do.
const stubDir = path.join(modulesDir, '@deepseek-ai', 'dsh-tools')
fs.mkdirSync(stubDir, { recursive: true })
fs.writeFileSync(path.join(stubDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-stub', type: 'module', main: 'index.js' }))
fs.writeFileSync(path.join(stubDir, 'index.js'), 'export const defineTool = (definition) => definition\n')

// The launcher reads dsh.profile.bundles and resolves each name in node_modules;
// installing by name (npm/github) creates exactly this directory. A copy stands in
// for a link so the check also proves nothing outside src/ is needed to import.
const installedDir = path.join(modulesDir, manifest.name)
fs.cpSync(packageDir, installedDir, {
  recursive: true,
  filter: (source) => !source.includes(`${path.sep}node_modules`) && !source.includes(`${path.sep}.research`),
})
const profileManifest = {
  name: 'test-profile',
  private: true,
  dsh: { profile: { bundles: [manifest.name] } },
  dependencies: { [manifest.name]: 'file:.' },
}
fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify(profileManifest, null, 2))

// Step 1: resolveBundleDir — the bundles entry must resolve to a directory whose
// own manifest carries the same name.
const require = createRequire(path.join(home, 'package.json'))
const resolvedManifestPath = require.resolve(`${manifest.name}/package.json`)
const resolvedManifest = JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf8'))
check('the bundles entry resolves in the profile', fs.existsSync(resolvedManifestPath), resolvedManifestPath)
check('the resolved package carries the same name', resolvedManifest.name === manifest.name, resolvedManifest.name)
check('the resolved package still declares a bundle patch', typeof resolvedManifest.dsh?.bundle?.patch === 'string')

// Step 2: bundlePatchPaths — read the patch from the resolved directory.
const resolvedPatch = path.join(path.dirname(resolvedManifestPath), resolvedManifest.dsh.bundle.patch)
check('the patch resolves inside the installed package', fs.existsSync(resolvedPatch), resolvedPatch)

// Step 3: the loader imports the row's name as a module specifier from the
// profile directory. This is the step that fails when the row name and the
// installed package name disagree.
let imported = null
let importError = null
try {
  imported = await import(pathToFileURL(require.resolve(rowNames[0])).href)
} catch (error) {
  importError = `${error.code || ''} ${error.message}`.trim()
}
check('the row name resolves as a module from the profile', importError === null, importError)
check('the imported host half exports apply', typeof imported?.apply === 'function')
check('the imported host half exports inject', Array.isArray(imported?.inject))
check('the imported host half exports name', typeof imported?.name === 'string', imported?.name)

// Step 4: the client half the client-module scanner would read.
const clientRel = resolvedManifest.exports['./client']
const clientPath = path.join(path.dirname(resolvedManifestPath), clientRel)
check('the exported client bundle exists in the installed package', fs.existsSync(clientPath), clientPath)
const clientText = fs.readFileSync(clientPath, 'utf8')
check('the client bundle registers itself under the package id', clientText.includes(`id: '${manifest.name}'`), clientText.slice(0, 120))

// Step 5: nothing in the import graph may reach outside the package, or an
// installed copy would need files that npm does not ship.
const sources = ['src/index.js', 'src/scan.js', 'src/trash.js', 'src/diagnostics.js', 'src/client.js']
const externalImports = new Set()
for (const source of sources) {
  const text = fs.readFileSync(path.join(packageDir, source), 'utf8')
  for (const match of text.matchAll(/from\s+'([^']+)'|require\('([^']+)'\)/g)) {
    const specifier = match[1] || match[2]
    if (specifier.startsWith('.')) continue
    externalImports.add(specifier)
  }
}
const allowed = new Set(['node:fs', 'node:os', 'node:path', 'react', '@deepseek-ai/dsh-client-ui-primitives'])
const unexpected = [...externalImports].filter((specifier) => !allowed.has(specifier))
check('no unexpected external import appears in the sources', unexpected.length === 0, unexpected.join(', '))
check('the host half does not import the optional dsh-tools peer at runtime', [...externalImports].every((s) => !s.startsWith('@deepseek-ai/dsh-tools')), [...externalImports].join(', '))

fs.rmSync(home, { recursive: true, force: true })

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
