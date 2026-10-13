// Test runner: the plugin-contract, host-side harness and client-bundle smoke
// suites are all plain node scripts, so this just runs them in order and reports
// the tally.
//
// usage: node tools/run-tests.mjs
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const tests = [
  '../test/plugin-contract.mjs',
  '../test/bundle-install.mjs',
  '../test/scan-rules.mjs',
  '../test/harness.mjs',
  '../test/client-smoke.mjs',
]

let failed = 0
for (const relative of tests) {
  const file = path.join(here, relative)
  console.log(`\n=== ${path.basename(file)} ===`)
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' })
  if ((result.status ?? 1) !== 0) failed += 1
}

console.log(failed === 0 ? '\nall suites passed' : `\n${failed} suite(s) failed`)
process.exit(failed === 0 ? 0 : 1)
