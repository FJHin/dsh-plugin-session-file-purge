// Live verification helper for a running harness: a read-only walk through this
// plugin's HTTP routes.
//
// It calls GET /__sespurge/ping, /session/list and /trash only — it never calls
// /plan, /purge, /cleanup or the trash mutations, so running it changes nothing.
// With `--plan <sessionId>` it additionally asks for one read-only plan (no files
// are touched; the route is documented as read-only).
//
// usage: node tools/verify-live.mjs [base-url] [--plan <sessionId>]
import process from 'node:process'

const args = process.argv.slice(2)
const planIndex = args.indexOf('--plan')
const planSession = planIndex >= 0 ? args[planIndex + 1] : null
const base = (args.find((arg) => arg.startsWith('http')) || 'http://127.0.0.1:19387').replace(/\/$/, '')

/**
 * GET one route and decode its envelope.
 * @param path - route path.
 * @returns the status and the decoded envelope.
 */
async function get(path) {
  const response = await fetch(base + path)
  const text = await response.text()
  try {
    return { status: response.status, json: JSON.parse(text) }
  } catch {
    return { status: response.status, json: null, text }
  }
}

/**
 * POST one read-only route.
 * @param path - route path.
 * @param body - the request body.
 * @returns the status and the decoded envelope.
 */
async function post(path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  try {
    return { status: response.status, json: JSON.parse(text) }
  } catch {
    return { status: response.status, json: null, text }
  }
}

function bytes(value) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(2)} MB`
}

const ping = await get('/__sespurge/ping')
if (ping.status !== 200 || !ping.json?.ok) {
  console.log(`ping            ${ping.status} — the host half is NOT registered (see ~/.dsh/session-file-purge/diagnostics.log)`)
  process.exit(1)
}
console.log(`ping            ok  plugin=${ping.json.value.plugin} pid=${ping.json.value.pid} via=${ping.json.value.via}`)

const list = await get('/__sespurge/session/list')
if (list.json?.ok) {
  const sessions = list.json.value.sessions || []
  console.log(`session/list    ok  ${sessions.length} sessions, ${sessions.filter((s) => s.hasBaseline).length} with a baseline, ${sessions.filter((s) => s.running).length} running`)
  for (const session of sessions.slice(0, 10)) {
    console.log(`  ${session.sessionId}  baseline=${String(session.hasBaseline).padEnd(5)}  running=${String(session.running).padEnd(5)}  ${(session.title || '').slice(0, 34)}`)
  }
  if (sessions.length > 10) console.log(`  … ${sessions.length - 10} more`)
} else {
  console.log(`session/list    ${list.status}  ${list.text?.slice(0, 120) || ''}`)
}

const trash = await get('/__sespurge/trash')
if (trash.json?.ok) {
  const entries = trash.json.value.entries || []
  const files = entries.reduce((sum, entry) => sum + entry.fileCount, 0)
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  console.log(`trash           ok  ${entries.length} batches, ${files} files, ${bytes(total)}  (${trash.json.value.trashRoot})`)
  for (const entry of entries) {
    console.log(`  ${entry.id}  files=${String(entry.fileCount).padEnd(4)} missing=${String(entry.missing).padEnd(5)} ${entry.at}  ${entry.root}`)
  }
} else {
  console.log(`trash           ${trash.status}  ${trash.text?.slice(0, 120) || ''}`)
}

if (planSession !== null) {
  const planned = await post('/__sespurge/plan', { sessionId: planSession })
  if (planned.json?.ok) {
    const plan = planned.json.value
    if (plan.baseline === null) {
      console.log(`plan ${planSession}  no baseline — this session started before the plugin was installed`)
    } else {
      console.log(`plan ${planSession}  root=${plan.root} baseline=${plan.baseline.capturedAt} created=${plan.added.length} changed=${plan.modified.length} truncated=${plan.truncated}`)
      for (const file of plan.added.slice(0, 10)) console.log(`  + ${file.path}  ${bytes(file.size)}`)
      for (const file of plan.modified.slice(0, 10)) console.log(`  ~ ${file.path}  ${bytes(file.size)}`)
      if (plan.added.length + plan.modified.length > 20) console.log('  … more')
    }
  } else {
    console.log(`plan            ${planned.status}  ${planned.json?.error || planned.text?.slice(0, 120)}`)
  }
} else {
  console.log('plan            skipped (pass --plan <sessionId> for one read-only plan)')
}
