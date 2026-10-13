// Startup diagnostics for dsh-plugin-session-file-purge.
//
// A plugin bundle that boots has no terminal to complain to: the desktop host
// logs warnings into a session nobody is watching. This module appends one line
// per lifecycle step to a file under the plugin's own directory so a load that
// silently did nothing can be read afterwards.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Absolute path of the diagnostics log, beside the baselines and the trash. */
export function diagnosticsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'session-file-purge', 'diagnostics.log')
}

/**
 * Append one diagnostic line. Never throws: a plugin that cannot write its log
 * must still boot.
 * @param event - short event name, e.g. 'apply' or 'http-register'.
 * @param detail - optional extra text.
 */
export function diagnose(event, detail) {
  try {
    const file = diagnosticsPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = `${new Date().toISOString()}\t${event}${detail === undefined ? '' : `\t${detail}`}\n`
    fs.appendFileSync(file, line, 'utf8')
  } catch {
    /* diagnostics must never break the plugin */
  }
}
