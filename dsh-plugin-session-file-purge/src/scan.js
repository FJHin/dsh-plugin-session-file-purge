// Workspace scanning for dsh-plugin-session-file-purge.
//
// A session's generated files cannot be known from the harness: nothing in the
// runtime keeps a per-session file ledger, and a shell command that writes ten
// files leaves no trace of their paths. The only observation that covers every
// writer (file tools, shell, python, whatever) is the filesystem itself, so this
// module records a baseline of the session's working directory when the session
// starts and diffs the directory against that baseline when the user asks what
// to clean up.
//
// The walk is deliberately bounded and deliberately forgetful: build artifacts
// and dependency trees are skipped, and a directory too large to scan in the
// budget reports itself as truncated instead of pretending to be complete.
//
// Links are never followed. A symbolic link, and on Windows a junction, keeps its
// target somewhere else — possibly outside the work directory — so a path that
// looks like `out/link/report.log` may in truth be `D:\elsewhere\report.log`.
// The walk reports such entries instead of entering them, and every path that
// reaches the purge step is checked with realpath before anything moves.
import fs from 'node:fs'
import path from 'node:path'

/** Directories never descended into: dependency stores, VCS metadata, harness state. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  'bower_components',
  '.git',
  '.hg',
  '.svn',
  '.pnpm',
  '.yarn',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.gradle',
  '.idea',
  '.vscode',
  '$RECYCLE.BIN',
  'System Volume Information',
])

/** Files whose churn says nothing about the conversation. */
export const IGNORED_FILE_SUFFIXES = ['.tmp', '.temp', '.swp', '.swo']
export const IGNORED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
/** Office lock files (`~$report.docx`) are churn, never a product of the work. */
export const IGNORED_FILE_PREFIXES = ['~$']

/**
 * Should this directory entry be skipped entirely?
 * @param name - the entry's base name.
 * @param isDirectory - whether the entry is a directory.
 * @returns true when the walk must not enter or record it.
 */
export function ignoredEntry(name, isDirectory) {
  if (isDirectory) return IGNORED_DIRS.has(name)
  if (IGNORED_FILE_NAMES.has(name)) return true
  for (const prefix of IGNORED_FILE_PREFIXES) if (name.startsWith(prefix)) return true
  for (const suffix of IGNORED_FILE_SUFFIXES) if (name.endsWith(suffix)) return true
  return false
}

/**
 * Normalize one path for use as an object key: forward slashes, no leading `./`.
 * Windows keeps native separators in the workspace, so keys are normalized to
 * compare across platforms and displayed back with native separators.
 * @param relative - path relative to the scan root.
 * @returns the normalized key.
 */
export function normalizeKey(relative) {
  return relative.split(path.sep).join('/')
}

/** Compare two absolute paths the way the platform compares them. */
function samePath(left, right) {
  if (left === right) return true
  return process.platform === 'win32' && left.toLowerCase() === right.toLowerCase()
}

/**
 * Resolve a path to where it really is, or null when it cannot be resolved.
 *
 * The native resolver is tried first: on Windows the JavaScript one leaves a
 * junction spelled the way the caller wrote it, which would make a link look
 * like an ordinary directory. The JavaScript one stays as a fallback for the
 * places where the native call is unavailable (some network shares).
 * @param target - the absolute path to resolve.
 * @returns the real path, or null.
 */
function realOrNull(target) {
  if (typeof fs.realpathSync.native === 'function') {
    try {
      return fs.realpathSync.native(target)
    } catch {
      // fall through to the portable resolver
    }
  }
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

/**
 * Does this absolute path still live where its own name says it does? Only the
 * resolved path tells the truth: a link (or a junction) anywhere on the way moves
 * the answer somewhere else, and "somewhere else" is not the session's directory.
 * @param absolute - the absolute path to check.
 * @returns true when the real path equals the lexical one.
 */
export function staysPut(absolute) {
  const real = realOrNull(absolute)
  // A missing path has no target to follow; the caller reports it as missing.
  if (real === null) return true
  return samePath(real, path.resolve(absolute))
}

/**
 * Walk a directory tree, calling `visit` for every file, and stop when the entry
 * budget or the deadline is hit. Links are reported through `visitLink` and never
 * entered, and a directory that resolves outside `root` (a Windows junction can)
 * is reported the same way instead of being walked.
 * @param options - root, extra directories to skip, budget, deadline, visitors.
 * @returns the count of visited files, whether the walk was truncated, and why.
 */
export async function walkFiles({ root, skipDirs = [], maxEntries = 200_000, deadline = Number.POSITIVE_INFINITY, visit, visitLink }) {
  const skip = new Set(skipDirs.map((dir) => path.resolve(dir)))
  const realRoot = realOrNull(root)
  const insideRoot = (absolute) => {
    if (realRoot === null) return false
    const real = realOrNull(absolute)
    if (real === null) return false
    if (samePath(real, realRoot)) return true
    const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep
    return samePath(real.slice(0, Math.min(real.length, prefix.length)), prefix)
  }
  let visited = 0
  let truncated = false
  let truncationReason = null

  /** @returns true when the walk must stop. */
  const outOfBudget = () => {
    if (Date.now() > deadline) {
      truncated = true
      truncationReason = 'deadline'
      return true
    }
    if (visited >= maxEntries) {
      truncated = true
      truncationReason = 'entries'
      return true
    }
    return false
  }

  /**
   * Depth-first walk of one directory.
   * @param dir - absolute directory path.
   * @param relative - its path relative to the scan root.
   */
  async function step(dir, relative) {
    if (outOfBudget()) return
    let handle
    try {
      handle = await fs.promises.opendir(dir)
    } catch {
      return // unreadable directory: not this plugin's problem to report
    }
    try {
      for await (const entry of handle) {
        if (outOfBudget()) return
        const name = entry.name
        const childRelative = relative === '' ? name : `${relative}${path.sep}${name}`
        const childAbsolute = path.join(dir, name)
        if (entry.isSymbolicLink()) {
          // A link is not a file this session produced, and moving it would either
          // break the link or, through the copy fallback, smuggle its target here.
          if (typeof visitLink === 'function') await visitLink(childRelative)
          continue
        }
        if (entry.isDirectory()) {
          if (ignoredEntry(name, true)) continue
          if (skip.has(path.resolve(root, childRelative))) continue
          // Windows reports a junction as a directory. Descending would list files
          // that live outside the session's directory under a path that looks local.
          if (!insideRoot(childAbsolute)) {
            if (typeof visitLink === 'function') await visitLink(childRelative)
            continue
          }
          await step(childAbsolute, childRelative)
        } else if (entry.isFile()) {
          if (ignoredEntry(name, false)) continue
          visited += 1
          await visit(childRelative, entry)
        }
        // sockets and devices are left alone
      }
    } catch {
      /* iteration interrupted: keep whatever was already visited */
    }
  }

  await step(root, '')
  return { visited, truncated, truncationReason }
}

/**
 * Capture a baseline of every file under a root: size and modification time,
 * which is enough to tell new files from changed ones without reading content.
 * Links are left out on purpose, in both directions, so one never shows up as
 * added or as removed.
 * @param options - the root, its skip list, and the budget.
 * @returns a snapshot object ready to be serialized next to the session.
 */
export async function captureBaseline({ root, skipDirs = [], maxEntries = 200_000, budgetMs = 30_000 }) {
  const files = Object.create(null)
  const started = Date.now()
  const result = await walkFiles({
    root,
    skipDirs,
    maxEntries,
    deadline: started + budgetMs,
    visit: async (relative, entry) => {
      let stat
      try {
        stat = await fs.promises.lstat(path.join(root, relative))
      } catch {
        return
      }
      if (stat.isSymbolicLink() || !stat.isFile()) return
      files[normalizeKey(relative)] = { s: stat.size, m: Math.floor(stat.mtimeMs), d: 0 }
    },
  })
  return {
    version: 1,
    root,
    capturedAt: new Date().toISOString(),
    fileCount: Object.keys(files).length,
    truncated: result.truncated,
    truncationReason: result.truncationReason,
    files,
  }
}

/**
 * Compare the current directory against a baseline.
 * @param options - the baseline, its skip list and the budget.
 * @returns added, modified and removed relative paths, the links seen, plus truncation state.
 */
export async function diffAgainstBaseline({ baseline, skipDirs = [], maxEntries = 200_000, budgetMs = 20_000 }) {
  const root = baseline.root
  const before = baseline.files || {}
  const added = []
  const modified = []
  const links = []
  const current = new Set()
  const started = Date.now()

  const result = await walkFiles({
    root,
    skipDirs,
    maxEntries,
    deadline: started + budgetMs,
    visitLink: async (relative) => {
      links.push(normalizeKey(relative))
    },
    visit: async (relative, entry) => {
      const key = normalizeKey(relative)
      current.add(key)
      const previous = before[key]
      let stat
      try {
        stat = await fs.promises.lstat(path.join(root, relative))
      } catch {
        return
      }
      if (stat.isSymbolicLink() || !stat.isFile()) return
      if (previous === undefined) {
        added.push({ path: key, size: stat.size, mtime: Math.floor(stat.mtimeMs) })
        return
      }
      if (previous.s !== stat.size || previous.m !== Math.floor(stat.mtimeMs)) {
        modified.push({
          path: key,
          size: stat.size,
          mtime: Math.floor(stat.mtimeMs),
          previousSize: previous.s,
          previousMtime: previous.m,
        })
      }
    },
  })

  const removed = []
  for (const key of Object.keys(before)) if (!current.has(key)) removed.push({ path: key })

  return {
    root,
    added,
    modified,
    removed,
    links: links.sort(),
    truncated: result.truncated,
    truncationReason: result.truncationReason,
    truncatedByBaseline: baseline.truncated === true,
  }
}

/**
 * Resolve a candidate path from a client request to an absolute path that is
 * provably inside the scan root. Every path coming from the client (or from a
 * model tool call) passes through here, so a crafted `../../` entry cannot make
 * the purge step touch anything outside the session's own directory.
 * @param root - the absolute workspace root the session ran in.
 * @param candidate - a relative path as reported in a plan.
 * @returns the absolute path, or null when the candidate escapes the root.
 */
export function resolveInside(root, candidate) {
  if (typeof candidate !== 'string' || candidate === '') return null
  if (path.isAbsolute(candidate)) return null
  const rootResolved = path.resolve(root)
  const absolute = path.resolve(rootResolved, candidate)
  const normalizedRoot = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep
  if (!absolute.startsWith(normalizedRoot)) return null
  return absolute
}

// Removing the folders a purge emptied lives in index.js (`removeEmptiedDirectories`),
// next to the move it must follow; this module only observes the filesystem.

/**
 * Refuse a path that is, or passes through, a link. This is the check the purge
 * step (and a restore destination) runs right before touching the disk, so a
 * candidate whose real location is outside the session's directory cannot be
 * moved or written even when its spelling looks local.
 * @param root - the session's working directory.
 * @param candidate - a relative path from a plan.
 * @returns null when the path is safe, otherwise the reason it is refused.
 */
export function symlinkHazard(root, candidate) {
  const absolute = resolveInside(root, candidate)
  if (absolute === null) return 'outside the session directory'
  if (!staysPut(absolute)) return 'a symbolic link or junction is in the way'
  let stat
  try {
    stat = fs.lstatSync(absolute)
  } catch {
    return null // missing: the caller reports that separately
  }
  if (stat.isSymbolicLink()) return 'is a symbolic link'
  return null
}
