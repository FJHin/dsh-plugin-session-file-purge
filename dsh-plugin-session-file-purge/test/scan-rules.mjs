// Scan-rule test: the walk's ignore rules and the path guard are the two places
// where a mistake is expensive (a purge that lists files it should not, or that
// accepts a path outside the session directory). Both are pure functions over a
// temporary tree, so they are tested directly rather than through the HTTP flow.
//
// usage: node test/scan-rules.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureBaseline, diffAgainstBaseline, ignoredEntry, normalizeKey, parentHazard, resolveInside, staysPut, symlinkHazard, walkFiles } from '../src/scan.js'

const here = path.dirname(fileURLToPath(import.meta.url))
void here

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

console.log('\nignore rules')
check('node_modules is skipped as a directory', ignoredEntry('node_modules', true))
check('a dot-directory of the VCS is skipped', ignoredEntry('.git', true) && ignoredEntry('.svn', true))
check('a build cache is skipped', ignoredEntry('.next', true) && ignoredEntry('__pycache__', true))
check('a directory named like an ignored file is not skipped', ignoredEntry('report.docx', true) === false)
check('an OS metadata file is skipped', ignoredEntry('.DS_Store', false) && ignoredEntry('Thumbs.db', false))
check('an editor lock file is skipped by prefix', ignoredEntry('~$report.docx', false))
check('a temp file is skipped by suffix', ignoredEntry('build.tmp', false) && ignoredEntry('x.swp', false))
check('ordinary files are kept', ignoredEntry('report.docx', false) === false && ignoredEntry('src', false) === false)

console.log('\npath normalization')
check('separators become forward slashes', normalizeKey(`a${path.sep}b${path.sep}c.txt`) === 'a/b/c.txt')

console.log('\npath guard')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sespurge-root-'))
check('a plain relative path resolves inside', resolveInside(root, 'a.txt') !== null)
check('a nested relative path resolves inside', resolveInside(root, path.join('out', 'chart.png')) !== null)
check('an escaping path is refused', resolveInside(root, '../escape.txt') === null)
check('a deep escaping path is refused', resolveInside(root, '../../etc/passwd') === null)
check('an absolute path is refused', resolveInside(root, path.resolve(root, 'a.txt')) === null)
check('an empty path is refused', resolveInside(root, '') === null)
check('a non-string is refused', resolveInside(root, null) === null)
check('a sibling directory sharing the prefix is refused', resolveInside(root, `..${path.sep}${path.basename(root)}-evil${path.sep}x`) === null)

console.log('\nwalk and diff over a real tree')
fs.mkdirSync(path.join(root, 'src'), { recursive: true })
fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true })
fs.mkdirSync(path.join(root, '.git'), { recursive: true })
fs.mkdirSync(path.join(root, '__pycache__'), { recursive: true })
fs.writeFileSync(path.join(root, 'src', 'keep.txt'), 'keep')
fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'x')
fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref')
fs.writeFileSync(path.join(root, '__pycache__', 'x.pyc'), 'x')
fs.writeFileSync(path.join(root, 'scratch.tmp'), 'x')

// `doomed.txt` is part of the baseline and is deleted after it, which is what the
// "removed" list reports: a file that existed in the snapshot and is gone now.
fs.writeFileSync(path.join(root, 'doomed.txt'), 'here for now')

const visited = []
await walkFiles({ root, visit: async (relative) => { visited.push(normalizeKey(relative)) } })
check('only real files are visited', visited.includes('src/keep.txt'), visited.join(','))
check('dependency trees are not walked', !visited.some((entry) => entry.startsWith('node_modules')))
check('VCS metadata is not walked', !visited.some((entry) => entry.startsWith('.git')))
check('bytecode caches are not walked', !visited.some((entry) => entry.startsWith('__pycache__')))
check('temp files are not visited', !visited.includes('scratch.tmp'))

const baseline = await captureBaseline({ root, budgetMs: 5000 })
check('the baseline records the kept file', baseline.files['src/keep.txt'] !== undefined)
check('the baseline records nothing ignored', Object.keys(baseline.files).length === 2, Object.keys(baseline.files).join(','))

fs.writeFileSync(path.join(root, 'new.txt'), 'new')
fs.appendFileSync(path.join(root, 'src', 'keep.txt'), 'more')
const diff = await diffAgainstBaseline({ baseline, budgetMs: 5000 })
check('a new file shows as added', diff.added.some((file) => file.path === 'new.txt'))
check('a changed file shows as modified', diff.modified.some((file) => file.path === 'src/keep.txt'))
check('an untouched file is in neither list', ![...diff.added, ...diff.modified, ...diff.removed].some((file) => file.path === 'doomed.txt'))

// A file that was in the baseline and is now gone is *removed*; a file created
// after the baseline and then deleted was never the session's to report.
fs.rmSync(path.join(root, 'doomed.txt'))
fs.rmSync(path.join(root, 'new.txt'))
const removed = await diffAgainstBaseline({ baseline, budgetMs: 5000 })
check(
  'a baseline file deleted afterwards is reported as removed',
  removed.removed.some((file) => file.path === 'doomed.txt'),
  `removed=${JSON.stringify(removed.removed)}`,
)
check(
  'a file created after the baseline and then deleted is not reported',
  !removed.removed.some((file) => file.path === 'new.txt'),
  `removed=${JSON.stringify(removed.removed)}`,
)

console.log('\nlinks')
// A link inside the working directory must not be followed: its target can live
// anywhere, and a purge that follows it would move content from outside the
// session's own tree. The walk reports links separately, and the guard refuses a
// path whose real location is not where its name says.
check('a plain file stays put', staysPut(path.join(root, 'src', 'keep.txt')) === true)
check('a path that does not exist yet stays put', staysPut(path.join(root, 'not-there-yet.txt')) === true)
check('a plain file has no hazard', symlinkHazard(root, 'src/keep.txt') === null)
check('a missing file has no hazard', symlinkHazard(root, 'gone.txt') === null)
check('a path outside the root is refused by the hazard check', symlinkHazard(root, '../escape.txt') === 'outside the session directory')
check('a real nested directory has no parent hazard', parentHazard(root, 'src/keep.txt') === null)
check('a directory that does not exist yet is not a parent hazard', parentHazard(root, path.join('fresh', 'dir', 'report.txt')) === null)
check('a path outside the root has a parent hazard', parentHazard(root, '../escape.txt') === 'outside the session directory')
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sespurge-outside-'))
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
// A junction is the only link Windows makes without developer mode; Node reports
// it as a plain directory, so only the real path reveals it.
let linked = null
try {
  fs.symlinkSync(outside, path.join(root, 'linked'), 'junction')
  linked = 'linked'
} catch {
  try {
    fs.symlinkSync(outside, path.join(root, 'linked'))
    linked = 'linked'
  } catch {
    linked = null
  }
}
if (linked === null) {
  console.log('  skip link cases: this machine cannot create a symbolic link')
} else {
  check('a link is not its own real path', staysPut(path.join(root, linked)) === false)
  check('the hazard check names the link', symlinkHazard(root, linked) === 'a symbolic link or junction is in the way')
  check('a file behind the link is refused too', symlinkHazard(root, path.join(linked, 'secret.txt')) === 'a symbolic link or junction is in the way')
  const used = []
  const reported = []
  await walkFiles({
    root,
    visit: async (relative) => { used.push(normalizeKey(relative)) },
    visitLink: async (relative) => { reported.push(normalizeKey(relative)) },
  })
  check('the walk reports the link instead of following it', reported.includes(linked), reported.join(','))
  check('nothing behind the link is walked', !used.some((entry) => entry.startsWith(`${linked}/`)) && !reported.some((entry) => entry.startsWith(`${linked}/`)), used.join(','))
  // The narrow case: the file itself is gone, so only the parents can reveal the
  // link. Resolving the leaf alone would say "fine" and the write would land on the
  // link's target, outside the working directory.
  check('a missing file behind the link has a parent hazard', parentHazard(root, path.join(linked, 'not-there-yet.txt')) === 'a symbolic link or junction is in the way')
  check('the hazard check refuses that missing file too', symlinkHazard(root, path.join(linked, 'not-there-yet.txt')) === 'a symbolic link or junction is in the way')
  check('a deeper missing path behind the link is refused', parentHazard(root, path.join(linked, 'deep', 'nested', 'x.txt')) === 'a symbolic link or junction is in the way')
  const withLink = await diffAgainstBaseline({ baseline, budgetMs: 5000 })
  check('the diff carries the links it saw', withLink.links.includes(linked), JSON.stringify(withLink.links))
}
fs.rmSync(outside, { recursive: true, force: true })

console.log('\nbudget truncation')
const tiny = await walkFiles({ root, maxEntries: 1, visit: async () => {} })
check('an entry budget marks the walk truncated', tiny.truncated === true && tiny.truncationReason === 'entries', JSON.stringify(tiny))
const expired = await walkFiles({ root, deadline: Date.now() - 1, visit: async () => {} })
check('an expired deadline marks the walk truncated', expired.truncated === true && expired.truncationReason === 'deadline', JSON.stringify(expired))

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1
