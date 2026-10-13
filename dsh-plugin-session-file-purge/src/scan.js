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

/**
 * Walk a directory tree, calling `visit` for every file, and stop when the entry
 * budget or the deadline is hit.
 * @param options - root, optional extra directories to skip, budget and deadline.
 * @returns the count of visited files, whether the walk was truncated, and why.
 */
export async function walkFiles({ root, skipDirs = [], maxEntries = 200_000, deadline = Number.POSITIVE_INFINITY, visit }) {
  const skip = new Set(skipDirs.map((dir) => path.resolve(dir)))
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
        if (entry.isDirectory()) {
          if (ignoredEntry(name, true)) continue
          if (skip.has(path.resolve(root, childRelative))) continue
          await step(path.join(dir, name), childRelative)
        } else if (entry.isFile()) {
          if (ignoredEntry(name, false)) continue
          visited += 1
          await visit(childRelative, entry)
        }
        // symlinks, sockets and devices are left alone
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
        stat = await fs.promises.stat(path.join(root, relative))
      } catch {
        return
      }
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
 * @returns added, modified and removed relative paths, plus truncation state.
 */
export async function diffAgainstBaseline({ baseline, skipDirs = [], maxEntries = 200_000, budgetMs = 20_000 }) {
  const root = baseline.root
  const before = baseline.files || {}
  const added = []
  const modified = []
  const current = new Set()
  const started = Date.now()

  const result = await walkFiles({
    root,
    skipDirs,
    maxEntries,
    deadline: started + budgetMs,
    visit: async (relative, entry) => {
      const key = normalizeKey(relative)
      current.add(key)
      const previous = before[key]
      let stat
      try {
        stat = await fs.promises.stat(path.join(root, relative))
      } catch {
        return
      }
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
