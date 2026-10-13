// Trash handling for dsh-plugin-session-file-purge.
//
// Nothing is ever deleted outright: a purge moves its files into a dated
// directory under the harness home and writes a manifest beside them, so a
// mistaken selection can be undone from the UI (or by hand) later. The manifest
// records the session's workspace root, which is what makes a restore possible
// even after the session itself is gone.
import fs from 'node:fs'
import path from 'node:path'

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

/**
 * Move a list of absolute files into the trash, preserving their path relative
 * to the workspace root.
 * @param options - trash root, session id, workspace root, files and directories.
 * @returns the manifest written for this purge.
 */
export function moveToTrash({ trashRoot, sessionId, root, files, directories = [], note = null }) {
  const id = `${stamp()}-${shortId(sessionId)}`
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
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      const stat = fs.statSync(absolute)
      fs.renameSync(absolute, destination)
      moved.push({ path: relative, bytes: stat.size })
      bytes += stat.size
    } catch (error) {
      // A cross-device or locked file is copied instead of moved; when even that
      // fails the file stays where it is and is reported rather than lost.
      try {
        const stat = fs.statSync(absolute)
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.copyFileSync(absolute, destination)
        fs.rmSync(absolute, { force: true })
        moved.push({ path: relative, bytes: stat.size })
        bytes += stat.size
      } catch (copyError) {
        failed.push({ path: relative, error: String((copyError && copyError.message) || copyError) })
      }
    }
  }

  const emptied = []
  for (const relative of directories) {
    const absolute = path.join(root, relative)
    try {
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
 * Put a trashed file back where it came from.
 * @param manifest - the manifest of the trash entry.
 * @param relative - the file's path relative to the manifest's root.
 * @returns where it was restored to.
 */
export function restoreFile(manifest, relative) {
  const source = path.join(manifest.dir, 'files', relative)
  const destination = path.join(manifest.root, relative)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  try {
    fs.renameSync(source, destination)
  } catch {
    fs.copyFileSync(source, destination)
    fs.rmSync(source, { force: true })
  }
  return destination
}

/**
 * Remove a trash entry from disk for good.
 * @param manifest - the manifest of the trash entry.
 */
export function dropTrashEntry(manifest) {
  fs.rmSync(manifest.dir, { recursive: true, force: true })
}
