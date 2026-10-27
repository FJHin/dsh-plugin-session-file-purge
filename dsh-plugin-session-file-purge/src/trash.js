// Trash handling for dsh-plugin-session-file-purge.
//
// Nothing is ever deleted outright: a purge moves its files into a dated
// directory under the harness home and writes a manifest beside them, so a
// mistaken selection can be undone from the UI (or by hand) later. The manifest
// records the session's workspace root, which is what makes a restore possible
// even after the session itself is gone.
//
// Three rules here are not negotiable. A link is never moved: the trash would then
// hold a copy of whatever the link pointed at instead of the link. A restore never
// overwrites: when something already sits at the original path, the file comes back
// under a free name beside it and the caller reports both names. And neither
// direction may reach through a link on the way — a parent directory that has since
// become a link turns "restore my report" into "write into somebody else's folder",
// so the ancestors are checked before every move and every restore.
import fs from 'node:fs'
import path from 'node:path'

import { parentHazard, staysPut, symlinkHazard } from './scan.js'

/** How many alternative names a restore may try before giving up. */
const RESTORE_NAME_ATTEMPTS = 200

/** Format a timestamp as `YYYYMMDD-HHmmss`, used as a trash directory name. */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** A short, filesystem-safe token derived from a session id. */
function shortId(sessionId) {
  const cleaned = String(sessionId || 'unknown').replace(/[^0-9a-zA-Z-]/g, '')
  return cleaned.replace(/^session-/, '').slice(0, 8) || 'unknown'
}

/**
 * The trash index: a small array of entry summaries kept beside the trash
 * directories. It is a convenience for the UI; every entry stays restorable by
 * hand from its manifest even if the index is lost.
 */
export class TrashIndex {
  /**
   * @param root - absolute trash root directory.
   */
  constructor(root) {
    this.root = root
    this.file = path.join(root, 'index.json')
    this.entries = this.read()
  }

  /** @returns the parsed index, or an empty list when absent or unreadable. */
  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /** Persist the index, creating the trash root if needed. */
  write() {
    try {
      fs.mkdirSync(this.root, { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2), 'utf8')
    } catch {
      /* an unwritable index must never fail a purge that already moved files */
    }
  }

  /**
   * Record one purge.
   * @param entry - the manifest of the purge just performed.
   */
  add(entry) {
    this.entries.unshift({
      id: entry.id,
      sessionId: entry.sessionId,
      at: entry.at,
      root: entry.root,
      fileCount: entry.files.length,
      bytes: entry.bytes,
      dir: entry.dir,
    })
    this.entries = this.entries.slice(0, 50)
    this.write()
  }

  /**
   * Forget one entry (after a restore or a manual delete).
   * @param id - the trash entry id.
   */
  remove(id) {
    this.entries = this.entries.filter((entry) => entry.id !== id)
    this.write()
  }

  /**
   * Read one manifest from disk.
   * @param id - the trash entry id.
   * @returns the manifest, or null when it is missing or unreadable.
   */
  manifest(id) {
    if (typeof id !== 'string' || id.includes('/') || id.includes('\\') || id.includes('..')) return null
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, id, 'manifest.json'), 'utf8'))
    } catch {
      return null
    }
  }
}

/** Does anything (a file, a directory, a link) already sit at this path? */
function occupied(target) {
  try {
    fs.lstatSync(target)
    return true
  } catch {
    return false
  }
}

/** A trash directory name that is not taken yet. */
function freshEntryId(trashRoot, sessionId) {
  const base = `${stamp()}-${shortId(sessionId)}`
  if (!occupied(path.join(trashRoot, base))) return base
  for (let n = 2; n < RESTORE_NAME_ATTEMPTS; n += 1) {
    const candidate = `${base}-${n}`
    if (!occupied(path.join(trashRoot, candidate))) return candidate
  }
  return `${base}-${Date.now()}`
}

/**
 * Turn `report.docx` into `report (restored).docx` and, if that is taken too,
 * `report (restored 2).docx` … so a restore never lands on top of something.
 * @param root - the workspace the file came from.
 * @param relative - its original relative path.
 * @returns the free destination, or null when every candidate is taken.
 */
function freeRestorePath(root, relative) {
  const absolute = path.join(root, relative)
  if (!occupied(absolute)) return { absolute, relative, renamed: false }
  const directory = path.dirname(relative)
  const base = path.basename(relative)
  const extension = path.extname(base)
  const stem = extension === '' ? base : base.slice(0, -extension.length)
  for (let n = 1; n < RESTORE_NAME_ATTEMPTS; n += 1) {
    const suffix = n === 1 ? ' (restored)' : ` (restored ${n})`
    const name = `${stem}${suffix}${extension}`
    const candidate = directory === '.' || directory === '' ? name : path.join(directory, name)
    const candidateAbsolute = path.join(root, candidate)
    if (!occupied(candidateAbsolute)) {
      return { absolute: candidateAbsolute, relative: candidate.split(path.sep).join('/'), renamed: true }
    }
  }
  return null
}

/**
 * Move a list of absolute files into the trash, preserving their path relative
 * to the workspace root.
 * @param options - trash root, session id, workspace root, files and directories.
 * @returns the manifest written for this purge.
 */
export function moveToTrash({ trashRoot, sessionId, root, files, directories = [], note = null }) {
  const id = freshEntryId(trashRoot, sessionId)
  const dir = path.join(trashRoot, id)
  const payloadRoot = path.join(dir, 'files')
  fs.mkdirSync(payloadRoot, { recursive: true })

  const moved = []
  const failed = []
  let bytes = 0

  for (const file of files) {
    const absolute = file.absolute
    const relative = file.relative
    const destination = path.join(payloadRoot, relative)
    const parent = parentHazard(root, relative)
    if (parent !== null) {
      failed.push({ path: relative, error: parent })
      continue
    }
    let stat
    try {
      // lstat, not stat: what matters is the entry itself, never what it links to.
      stat = fs.lstatSync(absolute)
    } catch (error) {
      failed.push({ path: relative, error: String((error && error.message) || error) })
      continue
    }
    if (stat.isSymbolicLink()) {
      // Moving a link would break it; copying it would drag its target into the
      // trash. Neither is what the dialog promised, so the link stays where it is.
      failed.push({ path: relative, error: 'refusing to move a symbolic link' })
      continue
    }
    if (!stat.isFile()) {
      failed.push({ path: relative, error: 'not a regular file' })
      continue
    }
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.renameSync(absolute, destination)
      moved.push({ path: relative, bytes: stat.size })
      bytes += stat.size
    } catch (error) {
      // A cross-device or locked file is copied instead of moved; when even that
      // fails the file stays where it is and is reported rather than lost.
      try {
        const again = fs.lstatSync(absolute)
        if (again.isSymbolicLink() || !again.isFile()) throw error
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.copyFileSync(absolute, destination)
        fs.rmSync(absolute, { force: true })
        moved.push({ path: relative, bytes: again.size })
        bytes += again.size
      } catch (copyError) {
        failed.push({ path: relative, error: String((copyError && copyError.message) || copyError) })
      }
    }
  }

  const emptied = []
  for (const relative of directories) {
    const absolute = path.join(root, relative)
    try {
      if (fs.lstatSync(absolute).isSymbolicLink()) continue
      if (fs.readdirSync(absolute).length === 0) {
        fs.rmdirSync(absolute)
        emptied.push(relative)
      }
    } catch {
      /* not empty or already gone */
    }
  }

  const manifest = {
    version: 1,
    id,
    sessionId,
    at: new Date().toISOString(),
    root,
    dir,
    note,
    files: moved,
    failed,
    bytes,
    emptiedDirectories: emptied,
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return manifest
}

/**
 * Put a trashed file back where it came from — beside it if the original path is
 * taken, never on top of whatever is there now.
 * @param manifest - the manifest of the trash entry.
 * @param relative - the file's path relative to the manifest's root.
 * @returns the relative path it landed on, the absolute path, and whether it was renamed.
 */
export function restoreFile(manifest, relative) {
  // Covers the whole chain: an occupied leaf is fine (it is renamed beside), but a
  // link anywhere above it is not — the copy would land on the link's target.
  const hazard = symlinkHazard(manifest.root, relative)
  if (hazard !== null) throw new Error(`the original location refuses a restore: ${hazard}`)

  const source = path.join(manifest.dir, 'files', relative)
  let sourceStat
  try {
    sourceStat = fs.lstatSync(source)
  } catch {
    throw new Error('the trashed copy is missing')
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) throw new Error('the trashed copy is not a regular file')

  let target = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    target = freeRestorePath(manifest.root, relative)
    if (target === null) throw new Error('no free name is available beside the original path')
    try {
      fs.mkdirSync(path.dirname(target.absolute), { recursive: true })
      // The directory may have been created *through* a link that appeared between
      // the check above and this mkdir; only the resolved path can tell, so look again.
      if (!staysPut(path.dirname(target.absolute))) {
        throw new Error('the original location refuses a restore: a symbolic link or junction is in the way')
      }
      // COPYFILE_EXCL turns a race with another writer into an error rather than
      // an overwrite: a restore must never replace a file the user already has.
      fs.copyFileSync(source, target.absolute, fs.constants.COPYFILE_EXCL)
      break
    } catch (error) {
      if (error && error.code === 'EEXIST' && attempt < 4) {
        target = null
        continue
      }
      throw error
    }
  }
  if (target === null) throw new Error('the file could not be restored')
  try {
    fs.utimesSync(target.absolute, sourceStat.atime, sourceStat.mtime)
  } catch {
    /* the timestamps are a courtesy, not the promise */
  }
  fs.rmSync(source, { force: true })
  return { relative: target.relative, absolute: target.absolute, renamed: target.renamed }
}

/**
 * Remove a trash entry from disk for good.
 * @param manifest - the manifest of the trash entry.
 */
export function dropTrashEntry(manifest) {
  fs.rmSync(manifest.dir, { recursive: true, force: true })
}
