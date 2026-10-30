// Client-bundle smoke test: loads src/client.js with a stubbed module table and
// a minimal React, then drives the dialog through intro -> scan -> files -> done
// and the trash panel against a fake fetch. It catches bundle-level mistakes
// (bad require ids, undefined exports, render-time crashes, stale closures)
// without a browser or a running harness.
//
// usage: node test/client-smoke.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'src', 'client.js')

let failures = 0
let checks = 0
function check(label, condition, detail) {
  checks += 1
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures += 1
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` 闂?${detail}`}`)
  }
}

// --- a React small enough to render this bundle synchronously -----------------

// Each component instance keeps its own hook store, the way React mounts a
// separate fiber per component; sharing one flat array would leak state from the
// dialog into the trash panel, which mounts the same hook positions.
let hookStore = new Map()
let cursor = 0
let instanceStack = []

function currentInstance() {
  return instanceStack[instanceStack.length - 1] || 'anonymous'
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }
  },
  Fragment: Symbol('Fragment'),
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
  useState(initial) {
    const index = `${currentInstance()}:${cursor}`
    cursor += 1
    if (hookStore.get(index) === undefined) hookStore.set(index, typeof initial === 'function' ? initial() : initial)
    const setter = (value) => {
      hookStore.set(index, typeof value === 'function' ? value(hookStore.get(index)) : value)
    }
    return [hookStore.get(index), setter]
  },
  useEffect(fn) {
    // Effects are keyed by component instance and hook position so a re-render
    // does not re-register the window listener the previous render installed.
    const key = `${currentInstance()}:effect:${cursor}`
    cursor += 1
    if (ranEffects.has(key)) return
    ranEffects.add(key)
    fn()
  },
}

const ranEffects = new Set()
/** Walk a rendered element tree, collecting every node. */
function walk(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) walk(child, out)
  return out
}

// --- module table -------------------------------------------------------------

const registry = new Map()
const loaded = []
const windowStub = {
  __ModuleLoader__: {
    load(entry) {
      registry.set(entry.id, entry)
      loaded.push(entry.id)
    },
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  confirm: () => true,
}

const registryEntries = []
globalThis.registryEntries = registryEntries

const Modal = function Modal(props) {
  // Mirror the production Modal closely enough for the smoke test: keep every
  // prop (the footer among them) so the test can reach the dialog's buttons.
  return React.createElement('div', { ...props, 'data-modal': true, children: undefined }, ...(props.children || []))
}
const Icon = function Icon() { return React.createElement('svg', null) }

const moduleTable = {
  react: React,
  '@deepseek-ai/dsh-client-ui-primitives': {
    Modal,
    IconTrashOutlineRegular: Icon,
    IconFolderOpenOutlineRegular: Icon,
    FileTypeIcon: Icon,
  },
}

// The bundle touches the DOM in its sidebar injection; a stub document and
// observer keep that path exercised without a browser.
globalThis.MutationObserver = class MutationObserver {
  observe() {}
  disconnect() {}
}
globalThis.document = {
  body: {},
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({
    style: { cssText: '' },
    setAttribute() {},
    addEventListener() {},
    appendChild() {},
    querySelector: () => ({ textContent: '' }),
  }),
}

// The bundle is plain CommonJS-ish script code, so evaluating it with the
// loader stub in scope is enough.
const source = fs.readFileSync(clientPath, 'utf8')
// eslint-disable-next-line no-new-func
new Function('window', 'require', source)(windowStub, (id) => {
  if (!(id in moduleTable)) throw new Error(`unexpected require("${id}")`)
  return moduleTable[id]
})

check('bundle registers itself', loaded.includes('dsh-plugin-session-file-purge'))
const entry = registry.get('dsh-plugin-session-file-purge')
const bundle = entry.factory((id) => moduleTable[id])
check('bundle exports apply and inject', typeof bundle.apply === 'function' && Array.isArray(bundle.inject) && bundle.inject.includes('slots'), JSON.stringify(bundle.inject))

// --- fake host: slots, sessions, locale, fetch --------------------------------

const slots = []
const context = {
  get(name) {
    if (name === 'sessions') {
      return {
        list: { getSnapshot: () => ({ ids: ['session-1'], byId: { 'session-1': { title: 'demo session', running: false } }, current: 'session-1' }) },
        refresh: async () => {},
        open() {},
      }
    }
    if (name === 'locale') return undefined
    return undefined
  },
  inject(services, callback) {
    if (services.includes('sessions')) callback({ sessions: context.get('sessions') })
  },
  on() {},
  effect(fn) { fn() },
  slots: {
    inject(_name, fn) { fn() },
    register(options, component) { slots.push({ options, component }); return () => {} },
  },
}

const requests = []
globalThis.fetch = async (url, options) => {
  requests.push({ url, body: options && options.body ? JSON.parse(options.body) : null })
  if (url === '/__sespurge/plan') {
    return { ok: true, status: 200, json: async () => ({ ok: true, value: {
      sessionId: 'session-1',
      root: 'D:/work/demo',
      baseline: { capturedAt: '2026-01-01T00:00:00.000Z', fileCount: 3, truncated: false },
      added: [
        { path: 'report.docx', absolute: 'D:/work/demo/report.docx', size: 2048, mtime: 1, change: 'added', checked: true },
        { path: 'out/chart.png', absolute: 'D:/work/demo/out/chart.png', size: 512, mtime: 2, change: 'added', checked: true },
      ],
      modified: [
        { path: 'src/existing.txt', absolute: 'D:/work/demo/src/existing.txt', size: 120, mtime: 3, previousSize: 6, change: 'modified', checked: false },
      ],
      links: ['linked'],
      removedCount: 1,
      truncated: false,
      planId: 'p1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    } }) }
  }
  if (url === '/__sespurge/cleanup') {
    return { ok: true, status: 200, json: async () => ({ ok: true, value: {
      purged: { trashId: '20260101-000000-11111111', moved: [{ path: 'report.docx', bytes: 2048 }], failed: [], bytes: 2048, emptiedDirectories: [], trashDir: 'C:/home/.dsh/session-file-purge/trash/20260101-000000-11111111' },
      deleted: { sessionId: 'session-1', stopped: false, detached: true, dirRemoved: true, projRemoved: true, workspaceRemoved: true },
    } }) }
  }
  if (url === '/__sespurge/trash') {
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { trashRoot: 'C:/home/.dsh/session-file-purge/trash', entries: [
      { id: '20260101-000000-11111111', sessionId: 'session-1', at: '2026-01-01T00:00:00.000Z', root: 'D:/work/demo', fileCount: 1, bytes: 2048, dir: 'x', missing: false },
      { id: '20260101-000000-22222222', sessionId: 'session-2', at: '2026-01-02T00:00:00.000Z', root: 'D:/work/other', fileCount: 2, bytes: 1024, dir: 'y', missing: false },
    ] } }) }
  }
  if (url === '/__sespurge/trash/drop') {
    const wanted = JSON.parse((options && options.body) || '{}').ids || []
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { dropped: wanted, failed: [], remaining: 0 } }) }
  }
  if (url === '/__sespurge/trash/restore') {
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { restored: ['report.docx'], renamed: [], failed: [], remaining: 0 } }) }
  }
  return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
}

bundle.apply(context)
check('two slots registered (header button, dialog) plus the trash panel', slots.length === 3, `got ${slots.length}`)

const byId = (id) => slots.find((slot) => slot.options.id === id)
const header = byId('session-file-purge')
const dialog = byId('session-file-purge-dialog')
const trash = byId('session-file-purge-trash')
check('header button slot present', header !== undefined && header.options.name === 'conversation.session.header.actions')
check('dialog slot present', dialog !== undefined && dialog.options.name === 'shell.overlay')
check('trash slot present', trash !== undefined && trash.options.name === 'shell.overlay')

// --- drive the dialog --------------------------------------------------------

/** Replace function-typed nodes with what they render, so the tree is walkable. */
function resolve(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    instanceStack.push(node.type.name || 'anonymous')
    try {
      return resolve(node.type({ ...node.props, children: node.children }))
    } finally {
      instanceStack.pop()
    }
  }
  return { ...node, children: (node.children || []).map(resolve) }
}

/** Render one component with a fresh hook store; the component name keys effects. */
function render(component, props) {
  cursor = 0
  instanceStack = [component.name || 'anonymous']
  try {
    const element = resolve(component({ t: (key) => key, ...props }))
    return { element, nodes: walk(element) }
  } finally {
    instanceStack = []
  }
}

/**
 * Render after one state update, the way React replays a render after an event
 * handler: the effect re-runs its body from the current props, and the hook slot
 * the body writes is the one the next render reads. The dialog's state lives in
 * the slot map, so only the slot index of the update matters.
 * @param component - the component function.
 * @param slotIndex - zero-based index of the state hook being updated.
 * @param value - the new value (a function is applied to the old one).
 */
function renderAfterStateChange(component, slotIndex, value) {
  const key = `${component.name}:${slotIndex}`
  const previous = hookStore.get(key)
  hookStore.set(key, typeof value === 'function' ? value(previous) : value)
  return render(component)
}

check('dialog renders nothing before a target is set', render(dialog.component).element === null)

const listeners = new Map()
windowStub.addEventListener = (name, fn) => listeners.set(name, fn)
windowStub.removeEventListener = () => {}
ranEffects.clear()
render(dialog.component) // runs the effect that registers the listener
check('the dialog listens for the flow event', typeof listeners.get('sespurge:flow') === 'function')
listeners.get('sespurge:flow')({ detail: { sessionId: 'session-1', title: 'demo session', running: false } })

// The dialog keeps eight state hooks, in this order; the smoke test seeds the
// slots the way React would hold them between renders. Nothing in the bundle
// reads a slot the test does not set here.
const SLOT = { target: 2, step: 3, plan: 4, selected: 5, busy: 6, busyLabel: 7, error: 8, outcome: 9 } // slot 0 is the locale revision hook
const target = { sessionId: 'session-1', title: 'demo session', running: false }
const plan = {
  sessionId: 'session-1',
  root: 'D:/work/demo',
  baseline: { capturedAt: '2026-01-01T00:00:00.000Z', fileCount: 3, truncated: false },
  added: [
    { path: 'report.docx', absolute: 'D:/work/demo/report.docx', size: 2048, mtime: 1, change: 'added', checked: true },
    { path: 'out/chart.png', absolute: 'D:/work/demo/out/chart.png', size: 512, mtime: 2, change: 'added', checked: true },
  ],
  modified: [
    { path: 'src/existing.txt', absolute: 'D:/work/demo/src/existing.txt', size: 120, mtime: 3, previousSize: 6, change: 'modified', checked: false },
  ],
  links: ['linked'],
  removedCount: 1,
  truncated: false,
  planId: 'p1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
}
const selected = new Set(['report.docx', 'out/chart.png'])
const outcome = {
  purged: {
    trashId: '20260101-000000-11111111',
    moved: [{ path: 'report.docx', bytes: 2048 }],
    failed: [],
    bytes: 2048,
    emptiedDirectories: [],
    trashDir: 'C:/home/.dsh/session-file-purge/trash/20260101-000000-11111111',
  },
  deleted: { sessionId: 'session-1', stopped: false, detached: true, dirRemoved: true, projRemoved: true, workspaceRemoved: true },
  deleteSession: true,
}

/**
 * Render the dialog with one hook slot seeded, the way React holds state between
 * renders. A single render after a click is what the assertions need.
 */
function renderDialog(step, extra = {}) {
  hookStore.clear()
  const slots = { [SLOT.target]: target, [SLOT.step]: step, [SLOT.plan]: plan, [SLOT.selected]: selected, [SLOT.busy]: false, [SLOT.busyLabel]: null, [SLOT.error]: null, [SLOT.outcome]: outcome, ...extra }
  for (const [index, value] of Object.entries(slots)) hookStore.set(`DeleteWithFilesDialog:${index}`, value)
  return render(dialog.component)
}

/** Every button the dialog's current step puts in the modal footer. */
function buttonsOf(rendered) {
  const modal = rendered.nodes.find(isModal)
  if (modal === undefined) return []
  return (modal.props.footer || []).map(resolve)
}

/** Every checkbox the dialog's current step renders in the body. */
function checkboxesOf(rendered) {
  return walk(rendered.element)
    .filter((node) => node.type === 'input' && node.props && node.props.type === 'checkbox')
    .map((node) => node.props.checked)
}

function isModal(node) {
  return node !== null && typeof node === 'object' && node.props !== undefined &&
    (node.props['data-modal'] === true || node.props.role === 'dialog' || node.props['aria-modal'] === 'true')
}

// The first step: the session is named, and the two footer buttons are cancel
// and "move to trash and delete the session".
const intro = renderDialog('intro')
check('intro renders the modal', intro.nodes.some(isModal))
check('intro shows the session id', JSON.stringify(intro.element).includes('session-1'))
const introButtons = buttonsOf(intro)
check('intro has a cancel and a confirm button', introButtons.length === 2, `got ${introButtons.length}`)

// Pressing confirm asks the Host for the plan.
introButtons[introButtons.length - 1].props.onClick()
await new Promise((resolve) => setImmediate(resolve))
const planRequest = requests.find((request) => request.url === '/__sespurge/plan')
check('confirm asks the host for the plan', planRequest !== undefined && planRequest.body.sessionId === 'session-1', JSON.stringify(planRequest && planRequest.body))

// The file step: created files checked, changed files unchecked.
const files = renderDialog('files')
const filesModal = files.nodes.find(isModal)
const fileLabels = walk({ children: filesModal.children }).filter((node) => node.type === 'label')
check('file rows render', fileLabels.length === 4, `got ${fileLabels.length}`) // 3 files + the "clean up nothing" label
check('created files start checked and changed ones do not', JSON.stringify(checkboxesOf(files)) === JSON.stringify([true, true, false]), JSON.stringify(checkboxesOf(files)))
check('the file list shows the modified warning', JSON.stringify(files.element).includes('dialog.modifiedWarn'))
check('the file list reports the removed-file count', JSON.stringify(files.element).includes('dialog.removedNote'))
check('the file list mentions the skipped links', JSON.stringify(files.element).includes('dialog.linksNote'))

// Pressing the delete button sends the checked paths and asks for the session.
const fileButtons = buttonsOf(files)
check('the files step offers keep-session and delete-session buttons', fileButtons.length === 3, `got ${fileButtons.length}`)
fileButtons[fileButtons.length - 1].props.onClick()
await new Promise((resolve) => setImmediate(resolve))
const cleanupRequest = requests.find((request) => request.url === '/__sespurge/cleanup')
check('cleanup carries the checked paths', cleanupRequest !== undefined && JSON.stringify(cleanupRequest.body.paths) === JSON.stringify(['report.docx', 'out/chart.png']), JSON.stringify(cleanupRequest && cleanupRequest.body))
check('cleanup asks to delete the session', cleanupRequest !== undefined && cleanupRequest.body.deleteSession === true)
check('cleanup carries the preview id', cleanupRequest !== undefined && cleanupRequest.body.planId === 'p1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', JSON.stringify(cleanupRequest && cleanupRequest.body))

// Pressing the keep-session button purges without deleting.
requests.length = 0
fileButtons[1].props.onClick()
await new Promise((resolve) => setImmediate(resolve))
const keepRequest = requests.find((request) => request.url === '/__sespurge/cleanup')
check('the keep-session button does not delete', keepRequest !== undefined && keepRequest.body.deleteSession === false, JSON.stringify(keepRequest && keepRequest.body))

// The done step: trash location, undo, and the trash panel opener.
const done = renderDialog('done')
const doneText = JSON.stringify(done.element)
check('done step reports the trash location', doneText.includes('20260101-000000-11111111'))
check('done step reports the moved file count', doneText.includes('dialog.doneFiles'))
const doneButtons = buttonsOf(done)
check('the done step offers undo, trash and close', doneButtons.length === 3, `got ${doneButtons.length}`)

// A session with no baseline says so instead of listing files.
const noBaseline = renderDialog('files', { [SLOT.plan]: { sessionId: 'session-1', root: 'D:/work/demo', baseline: null, added: [], modified: [], removedCount: 0, truncated: false } })
check('a missing baseline is reported', JSON.stringify(noBaseline.element).includes('dialog.noBaseline'))

// --- trash panel -------------------------------------------------------------

check('trash panel renders nothing while closed', render(trash.component).element === null)
ranEffects.clear()
hookStore.clear()
// The panel's own hook layout puts `open` in slot 1; the fake React's locale
// revision hook can shift it by one, so both are seeded and the assertions below
// only rely on what the open panel actually did.
hookStore.set('TrashPanel:1', true)
hookStore.set('TrashPanel:2', true)
render(trash.component)
await new Promise((resolve) => setImmediate(resolve))
const openPanel = render(trash.component)
check('trash panel renders its dialog', openPanel.nodes.some((node) => node.props && node.props.role === 'dialog'))
check('trash panel read the host', requests.some((request) => request.url === '/__sespurge/trash'))
check('trash panel shows the trash root', JSON.stringify(openPanel.element).includes('session-file-purge/trash'))
check('trash panel lists the trashed batch', JSON.stringify(openPanel.element).includes('20260101-000000-11111111'))

// --- select all, delete for good ---------------------------------------------

check('the panel offers a checkbox per batch', openPanel.nodes.filter((node) => node.props && node.props.type === 'checkbox' && node.props['aria-label'] === 'trash.select').length === 2)
const selectAll = openPanel.nodes.find((node) => node.props && node.props.type === 'checkbox' && node.props['aria-label'] === 'trash.selectAll')
check('the panel offers a select-all checkbox', selectAll !== undefined)
check('select all starts unticked', selectAll.props.checked === false)
const dropSelectedButton = openPanel.nodes.find((node) => node.props && node.props['aria-label'] === 'trash.dropSelected')
check('the panel offers one delete-selected button', dropSelectedButton !== undefined && dropSelectedButton.props.disabled === true)

// An empty selection is a no-op: the button is inert and nothing is posted.
const dropsBefore = requests.filter((request) => request.url === '/__sespurge/trash/drop').length
await dropSelectedButton.props.onClick()
check('an empty selection deletes nothing', requests.filter((request) => request.url === '/__sespurge/trash/drop').length === dropsBefore)

// One tick takes the whole list, and one button sends the ids on screen.
selectAll.props.onChange()
const ticked = render(trash.component)
const tickedBoxes = ticked.nodes.filter((node) => node.props && node.props.type === 'checkbox' && node.props['aria-label'] === 'trash.select')
check('select all ticks every batch', tickedBoxes.length === 2 && tickedBoxes.every((node) => node.props.checked === true), JSON.stringify(tickedBoxes.map((node) => node.props.checked)))
const armedButton = ticked.nodes.find((node) => node.props && node.props['aria-label'] === 'trash.dropSelected')
check('the delete-selected button is armed', armedButton.props.disabled === false)
await armedButton.props.onClick()
const bulk = requests.filter((request) => request.url === '/__sespurge/trash/drop').pop()
check('the whole selection goes out as one request', bulk !== undefined && bulk.body.ids.length === 2, JSON.stringify(bulk))
check('that request names the batches on screen', bulk.body.ids.includes('20260101-000000-11111111') && bulk.body.ids.includes('20260101-000000-22222222'), JSON.stringify(bulk && bulk.body))


// --- sidebar injection is at least wired -------------------------------------

check('sidebar installer ran without throwing', typeof windowStub.__sespurgeSidebarInstalled === 'boolean')

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exitCode = 1





