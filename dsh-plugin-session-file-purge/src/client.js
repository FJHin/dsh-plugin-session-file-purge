// dsh-plugin-session-file-purge — Client half.
//
// Adds a cleanup step to session deletion and a trash panel to take it back:
//
//   header trash button / sidebar row menu
//     -> dialog step 1: which session, and whether to also clean up files
//     -> dialog step 2: the files the session produced, "created" checked and
//        "changed" unchecked, each one selectable, with a select-all/clear pair
//     -> confirm: the Host moves the selection into its trash directory and
//        then deletes the session; the dialog ends on a restore button
//   trash panel: every trashed purge, with restore and delete-for-good
//
// The bundle is a CommonJS-ish module written the way the client module system
// loads plugin bundles: one `window.__ModuleLoader__.load({ id, factory })`
// call whose factory receives the module table as `require`.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-file-purge',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React
    const { Modal, IconTrashOutline16, IconFolderOpenOutline16, FileTypeIcon } = (() => {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      return {
        Modal: primitives.Modal,
        IconTrashOutline16: primitives.IconTrashOutlineRegular,
        IconFolderOpenOutline16: primitives.IconFolderOpenOutlineRegular,
        FileTypeIcon: primitives.FileTypeIcon,
      }
    })()

    const NS = 'session-file-purge'
    const OVERLAY_SLOT = 'shell.overlay'
    const HEADER_SLOT = 'conversation.session.header.actions'
    const EVENT = 'sespurge:flow'
    const TRASH_EVENT = 'sespurge:trash'
    const HEADER_ROW_ID = 'session-file-purge'
    const DIALOG_ID = 'session-file-purge-dialog'
    const TRASH_ID = 'session-file-purge-trash'
    const SIDEBAR_ATTR = 'data-sespurge'

    let __locale = null
    let __sessionsSvc = null

    // --- copy ------------------------------------------------------------------

    const zhDict = {
      'menu.deleteWithFiles': '删除会话（含产生的文件）…',
      'menu.purgeFiles': '清理本会话产生的文件…',
      'menu.trash': '打开文件回收站…',
      'button.title': '删除会话（可一并清理产生的文件）',
      'button.titleRunning': '删除会话（运行中，可一并清理产生的文件）',
      'dialog.title': '删除会话',
      'dialog.session': '会话：',
      'dialog.sessionId': '会话 ID：',
      'dialog.untitled': '（无标题）',
      'dialog.deleteDesc': '删除后该会话的日志、投影缓存与工作区记账都会被移除。',
      'dialog.runningDesc': '该会话正在运行；继续删除会先停止它。',
      'dialog.notFound': '没有在会话列表中找到该会话，可能已被删除或正在刷新。',
      'dialog.scanning': '正在对比会话开始时的目录快照…',
      'dialog.filesTitle': '本次会话产生或改动的文件',
      'dialog.filesDesc': '勾选的文件会被移动到回收站（不是直接删除），随后再删除会话。',
      'dialog.added': '新建',
      'dialog.modified': '改动',
      'dialog.selectAll': '全选',
      'dialog.selectNone': '全不选',
      'dialog.selectAdded': '只选新建',
      'dialog.selectNothing': '不清理文件，只删除会话',
      'dialog.bytes': '合计',
      'dialog.noFiles': '没有发现本次会话新建或改动的文件。',
      'dialog.noBaseline': '这个会话没有基线快照（插件是在它开始之后才安装的），无法判断哪些文件是它产生的。你仍然可以只删除会话。',
      'dialog.truncated': '扫描达到上限，列表可能不完整。',
      'dialog.removedNote': '本次会话还删除了 {n} 个原有文件（这些文件已不在目录中，不参与清理）。',
      'dialog.modifiedWarn': '「改动」类文件在会话开始前就存在，勾选会把它们整体移入回收站。',
      'dialog.confirm': '移入回收站并删除会话',
      'dialog.confirmKeep': '移入回收站（保留会话）',
      'dialog.cancel': '取消',
      'dialog.working': '正在处理…',
      'dialog.busyFiles': '正在移动文件…',
      'dialog.busyDelete': '正在删除会话…',
      'dialog.doneTitle': '已删除会话',
      'dialog.donePurged': '已移入回收站的会话',
      'dialog.doneFiles': '已移入回收站 {n} 个文件（{bytes}）',
      'dialog.doneNoFiles': '没有移动文件',
      'dialog.doneTrash': '回收站位置：',
      'dialog.doneFailed': '{n} 个文件未能移动',
      'dialog.restore': '撤销：把文件放回去',
      'dialog.restored': '已放回 {n} 个文件',
      'dialog.restoredRenamed': '为避免覆盖，{n} 个文件以新名称放回（原名处已有文件）。',
      'dialog.linksNote': '{n} 个符号链接/目录联接被跳过：插件只会列出并移动真实文件，不会跟随或移动链接。',
      'dialog.openTrash': '打开回收站',
      'dialog.close': '关闭',
      'trash.title': '文件回收站',
      'trash.desc': '删除会话时移入的文件都存在这里，可以放回原处。清空回收站会永久删除这些文件。',
      'trash.empty': '回收站是空的。',
      'trash.root': '回收站目录：',
      'trash.entryCount': '{n} 个文件',
      'trash.restoreAll': '全部放回',
      'trash.restore': '放回',
      'trash.drop': '永久删除',
      'trash.dropConfirm': '永久删除这一批文件？此操作不可撤销。',
      'trash.select': '选择这一批',
      'trash.selectAll': '全选',
      'trash.selectedCount': '已选 {n} 个批次',
      'trash.dropSelected': '永久删除选中',
      'trash.dropSelectedConfirm': '永久删除选中的 {n} 个批次？此操作不可撤销。',
      'trash.droppedMany': '已永久删除 {n} 个批次。',
      'trash.dropNothing': '先勾选要删除的批次。',
      'trash.missing': '（清单缺失）',
      'trash.loading': '正在读取…',
      'trash.close': '关闭',
      'trash.restoredSome': '已放回 {n} 个文件，其余未能放回（原位置可能已有同名文件）。',
    }

    const enDict = {
      'menu.deleteWithFiles': 'Delete session (with its files)…',
      'menu.purgeFiles': 'Clean up files this session made…',
      'menu.trash': 'Open file trash…',
      'button.title': 'Delete session and optionally clean up the files it produced',
      'button.titleRunning': 'Delete session (running; can clean up its files too)',
      'dialog.title': 'Delete session',
      'dialog.session': 'Session: ',
      'dialog.sessionId': 'Session id: ',
      'dialog.untitled': '(untitled)',
      'dialog.deleteDesc': 'Deleting removes this session log, its projection cache row and its workspace accounting.',
      'dialog.runningDesc': 'This session is running; deleting it stops it first.',
      'dialog.notFound': 'That session is not in the list — it may already be deleted, or the list is refreshing.',
      'dialog.scanning': 'Comparing the working directory against the snapshot taken when the session started…',
      'dialog.filesTitle': 'Files this session created or changed',
      'dialog.filesDesc': 'Checked files are moved into the trash (not deleted), and then the session is deleted.',
      'dialog.added': 'created',
      'dialog.modified': 'changed',
      'dialog.selectAll': 'All',
      'dialog.selectNone': 'None',
      'dialog.selectAdded': 'Created only',
      'dialog.selectNothing': 'Delete the session without cleaning up files',
      'dialog.bytes': 'total',
      'dialog.noFiles': 'No files were created or changed by this session.',
      'dialog.noBaseline': 'This session has no baseline snapshot (the plugin was installed after it started), so its files cannot be identified. You can still delete the session alone.',
      'dialog.truncated': 'The scan hit its budget; the list may be incomplete.',
      'dialog.removedNote': 'This session also removed {n} pre-existing files (they are gone already and are not part of the cleanup).',
      'dialog.modifiedWarn': '"Changed" files existed before the session; checking them moves them into the trash whole.',
      'dialog.confirm': 'Move to trash and delete session',
      'dialog.confirmKeep': 'Move to trash (keep session)',
      'dialog.cancel': 'Cancel',
      'dialog.working': 'Working…',
      'dialog.busyFiles': 'Moving files…',
      'dialog.busyDelete': 'Deleting the session…',
      'dialog.doneTitle': 'Session deleted',
      'dialog.donePurged': 'Files moved to trash',
      'dialog.doneFiles': 'Moved {n} files ({bytes}) into the trash',
      'dialog.doneNoFiles': 'No files were moved',
      'dialog.doneTrash': 'Trash location: ',
      'dialog.doneFailed': '{n} files could not be moved',
      'dialog.restore': 'Undo: put the files back',
      'dialog.restored': 'Put {n} files back',
      'dialog.restoredRenamed': 'To avoid overwriting, {n} files went back under a new name (the original path was taken).',
      'dialog.linksNote': '{n} symbolic links/junctions were skipped: only real files are listed and moved, links are never followed or moved.',
      'dialog.openTrash': 'Open trash',
      'dialog.close': 'Close',
      'trash.title': 'File trash',
      'trash.desc': 'Files moved here when sessions were deleted can be put back. Emptying the trash deletes them for good.',
      'trash.empty': 'The trash is empty.',
      'trash.root': 'Trash directory: ',
      'trash.entryCount': '{n} files',
      'trash.restoreAll': 'Restore all',
      'trash.restore': 'Restore',
      'trash.drop': 'Delete for good',
      'trash.dropConfirm': 'Delete this batch for good? This cannot be undone.',
      'trash.select': 'Select this batch',
      'trash.selectAll': 'Select all',
      'trash.selectedCount': '{n} selected',
      'trash.dropSelected': 'Delete selected for good',
      'trash.dropSelectedConfirm': 'Delete the {n} selected batches for good? This cannot be undone.',
      'trash.droppedMany': 'Deleted {n} batches for good.',
      'trash.dropNothing': 'Check the batches to delete first.',
      'trash.missing': '(manifest missing)',
      'trash.loading': 'Loading…',
      'trash.close': 'Close',
      'trash.restoredSome': 'Put {n} files back; the rest could not be restored (a file may already exist at the original path).',
    }

    function localeFallbackLang() {
      const tag = (typeof navigator !== 'undefined' && navigator.language) || ''
      return String(tag).toLowerCase().split('-')[0] === 'en' ? 'en' : 'zh'
    }

    function __t(key, vars) {
      let text
      if (__locale && typeof __locale.translate === 'function') {
        const translated = __locale.translate(NS, key)
        if (typeof translated === 'string' && translated !== key) text = translated
      }
      if (text === undefined) text = (localeFallbackLang() === 'en' ? enDict : zhDict)[key] || key
      if (vars) for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value))
      return text
    }

    function useLocaleRevision() {
      const [, setRev] = useState(0)
      useEffect(() => {
        if (!__locale || typeof __locale.subscribe !== 'function') return undefined
        return __locale.subscribe(() => setRev((value) => value + 1))
      }, [])
    }

    // --- target resolution -----------------------------------------------------

    function normalizeTitle(value) {
      return String(value || '').trim().replace(/\s+/g, ' ')
    }

    /** '标题 (1)' -> '标题' — the display suffix a forked session carries. */
    function stripForkSuffix(value) {
      return normalizeTitle(value).replace(/\s*\(\d+\)\s*$/, '')
    }

    /** The sidebar dispatches a title (its DOM carries no id); the header dispatches an id. */
    function resolveTargetFromStore(detail) {
      if (detail.sessionId) {
        return { sessionId: detail.sessionId, title: detail.title || null, running: detail.running === true }
      }
      const want = normalizeTitle(detail.title)
      if (!want) return null
      const wantBase = stripForkSuffix(want)
      const svc = __sessionsSvc
      if (svc && svc.list) {
        try {
          const snapshot = svc.list.getSnapshot()
          const byId = (snapshot && snapshot.byId) || {}
          const ids = Object.keys(byId)
          for (const id of ids) {
            const session = byId[id]
            if (session && normalizeTitle(session.title) === want) {
              return { sessionId: id, title: session.title, running: session.running === true }
            }
          }
          if (wantBase) {
            for (const id of ids) {
              const session = byId[id]
              if (session && stripForkSuffix(session.title) === wantBase) {
                return { sessionId: id, title: session.title, running: session.running === true }
              }
            }
          }
          for (const id of ids) {
            const session = byId[id]
            if (session && normalizeTitle(session.title).includes(want)) {
              return { sessionId: id, title: session.title, running: session.running === true }
            }
          }
        } catch {
          /* fall through to the host list */
        }
      }
      return { sessionId: null, title: detail.title, running: false, unresolved: true }
    }

    async function resolveTargetFromHost(detail) {
      const direct = resolveTargetFromStore(detail)
      if (direct && direct.sessionId) return direct
      try {
        const response = await fetch('/__sespurge/session/list')
        const data = await response.json()
        const sessions = (data && data.value && data.value.sessions) || []
        const want = normalizeTitle(detail.title)
        const wantBase = stripForkSuffix(want)
        const byTitle = sessions.find((session) => normalizeTitle(session.title) === want)
        const byBase = !byTitle && wantBase ? sessions.find((session) => stripForkSuffix(session.title) === wantBase) : null
        const found = byTitle || byBase
        if (found) return { sessionId: found.sessionId, title: found.title, running: found.running === true }
      } catch {
        /* the dialog then reports that the session could not be resolved */
      }
      return direct || { sessionId: null, title: detail.title, running: false, unresolved: true }
    }

    // --- small helpers ---------------------------------------------------------

    function formatBytes(value) {
      const bytes = Number(value) || 0
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
      return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    function fileNameOf(relative) {
      const parts = String(relative).split('/')
      return parts[parts.length - 1] || relative
    }

    async function postJson(url, body) {
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
      } catch (reason) {
        throw new Error(`cannot reach the plugin host route ${url}: ${String((reason && reason.message) || reason)}`)
      }
      let data = {}
      try {
        data = await response.json()
      } catch {
        /* keep {} */
      }
      if (!response.ok || !data.ok) {
        const detail = (data && data.error) || `HTTP ${response.status}`
        // A 404 or a 405 here means the host half of this plugin never registered
        // its routes: the client bundle is served from disk, so the UI can be
        // live while the Host side is missing. Say so instead of leaving a bare
        // status code in the dialog.
        const missingHost = response.status === 404 || response.status === 405
        // 401/403 comes from the harness, not from this plugin: the window carries
        // no browser session for the Host (the app restarted, the session expired,
        // or the page was opened outside the launcher), and the Host answers only
        // requests its own connection service admitted.
        const refused = response.status === 401 || response.status === 403
        const hint = missingHost
          ? `${detail} — host plugin routes are missing; restart the app (a page reload is not enough)`
          : refused
            ? `${detail} — this window is not authenticated for the plugin routes; reopen the app window`
            : detail
        throw new Error(hint)
      }
      return data.value
    }

    // --- styles ----------------------------------------------------------------

    const btnStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 28,
      height: 28,
      padding: 0,
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #8a8f98)',
      cursor: 'pointer',
    }
    const metaStyle = { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, #8a8f98)', wordBreak: 'break-all' }
    const warnStyle = { ...metaStyle, color: 'var(--dsw-alias-state-warning-primary, #d9a400)' }
    const errStyle = { ...metaStyle, color: 'var(--dsw-alias-state-error-primary, #e5484d)' }
    const optStyle = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, lineHeight: '20px', cursor: 'pointer' }
    const cancelBtnStyle = {
      padding: '6px 12px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
      font: 'inherit',
      fontSize: 13,
      cursor: 'pointer',
    }
    const dangerBtnStyle = {
      ...cancelBtnStyle,
      border: '1px solid transparent',
      background: 'var(--dsw-alias-state-error-primary, #e5484d)',
      color: '#fff',
    }
    const ghostBtnStyle = {
      ...cancelBtnStyle,
      padding: '3px 8px',
      fontSize: 12,
    }
    const listStyle = {
      maxHeight: 260,
      overflowY: 'auto',
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
      borderRadius: 8,
      padding: '4px 8px',
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '2px 0',
      fontSize: 12.5,
      lineHeight: '18px',
      minWidth: 0,
    }
    const badgeStyle = {
      flex: 'none',
      fontSize: 11,
      lineHeight: '16px',
      padding: '0 6px',
      borderRadius: 999,
      border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
      color: 'var(--dsw-alias-label-secondary, #8a8f98)',
    }
    const pathStyle = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
    const sizeStyle = { flex: 'none', color: 'var(--dsw-alias-label-secondary, #8a8f98)', fontVariantNumeric: 'tabular-nums' }

    // --- the delete dialog -----------------------------------------------------

    function DeleteWithFilesDialog(props) {
      const t = (props && props.t) || __t
      useLocaleRevision()
      const [target, setTarget] = useState(null)
      const [step, setStep] = useState('intro')
      const [plan, setPlan] = useState(null)
      const [selected, setSelected] = useState(() => new Set())
      const [busy, setBusy] = useState(false)
      const [busyLabel, setBusyLabel] = useState(null)
      const [error, setError] = useState(null)
      const [outcome, setOutcome] = useState(null)

      const scan = useCallback(async (which) => {
        const subject = which || target
        if (!subject || !subject.sessionId) return
        setTarget(subject)
        setPlan(null)
        setSelected(new Set())
        setOutcome(null)
        setError(null)
        setBusy(true)
        setStep('scanning')
        try {
          const result = await postJson('/__sespurge/plan', { sessionId: subject.sessionId })
          setPlan(result)
          const next = new Set()
          for (const file of [...result.added, ...result.modified]) if (file.checked) next.add(file.path)
          setSelected(next)
          setStep('files')
        } catch (reason) {
          setError(String((reason && reason.message) || reason))
          setStep('intro')
        } finally {
          setBusy(false)
        }
      }, [target])

      const autoScan = useCallback((subject) => scan(subject), [scan])

      useEffect(() => {
        const handler = (event) => {
          const detail = (event && event.detail) || {}
          setOutcome(null)
          setError(null)
          setPlan(null)
          setSelected(new Set())
          setBusy(false)
          setStep('intro')
          if (!detail.sessionId && !detail.title) return
          const immediate = resolveTargetFromStore(detail)
          if (immediate && immediate.sessionId) {
            setTarget(immediate)
            if (detail.keepSession === true) queueMicrotask(() => { void autoScan(immediate) })
            return
          }
          setTarget(immediate || { sessionId: null, title: detail.title, running: false, unresolved: true })
          resolveTargetFromHost(detail).then((resolved) => {
            setTarget(resolved)
            if (detail.keepSession === true && resolved.sessionId) void autoScan(resolved)
          }, () => setTarget(immediate))
        }
        window.addEventListener(EVENT, handler)
        return () => window.removeEventListener(EVENT, handler)
      }, [autoScan])

      const close = useCallback(() => {
        if (busy) return
        setTarget(null)
        setPlan(null)
        setOutcome(null)
        setError(null)
        setStep('intro')
      }, [busy])

      const selectionList = useMemo(() => [...selected], [selected])

      const totals = useMemo(() => {
        if (!plan) return { bytes: 0, count: 0 }
        let bytes = 0
        let count = 0
        for (const file of [...plan.added, ...plan.modified]) {
          if (!selected.has(file.path)) continue
          bytes += file.size || 0
          count += 1
        }
        return { bytes, count }
      }, [plan, selected])

      const start = useCallback(() => scan(null), [scan])

      const runCleanup = useCallback(async (deleteSession) => {
        if (!target || !target.sessionId || busy) return
        setBusy(true)
        setError(null)
        setBusyLabel(deleteSession ? t('dialog.busyDelete') : t('dialog.busyFiles'))
        try {
          const result = await postJson('/__sespurge/cleanup', {
            sessionId: target.sessionId,
            paths: selectionList,
            // The digest of the preview the user is looking at: the host refuses a
            // selection whose list no longer matches, and a path that was not in it.
            planId: plan && plan.planId,
            deleteSession,
          })
          setOutcome({ ...result, deleteSession })
          setStep('done')
          if (deleteSession) refreshSessionList(target.sessionId)
        } catch (reason) {
          setError(String((reason && reason.message) || reason))
        } finally {
          setBusy(false)
          setBusyLabel(null)
        }
      }, [target, busy, selectionList, plan])

      const restoreOutcome = useCallback(async () => {
        const trashId = outcome && outcome.purged && outcome.purged.trashId
        if (!trashId) return
        setBusy(true)
        try {
          const result = await postJson('/__sespurge/trash/restore', { id: trashId })
          setOutcome({ ...outcome, restored: result })
        } catch (reason) {
          setError(String((reason && reason.message) || reason))
        } finally {
          setBusy(false)
        }
      }, [outcome])

      if (!target) return null

      const name = target.title || t('dialog.untitled')
      const description = target.unresolved
        ? t('dialog.notFound')
        : target.running
          ? t('dialog.runningDesc')
          : t('dialog.deleteDesc')

      const body = []
      body.push(
        React.createElement('div', { key: 'meta', style: metaStyle },
          t('dialog.session'), name,
          target.sessionId ? React.createElement(React.Fragment, null, React.createElement('br'), t('dialog.sessionId'), target.sessionId) : null),
      )
      if (target.running) body.push(React.createElement('div', { key: 'warn', style: warnStyle }, t('dialog.runningDesc')))
      if (error) body.push(React.createElement('div', { key: 'err', role: 'alert', style: errStyle }, error))

      const fileGroups = () => {
        if (!plan) return null
        const groups = []
        const group = (label, files, kind) => {
          if (files.length === 0) return null
          return React.createElement('div', { key: kind, style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              React.createElement('strong', { style: { fontSize: 12.5 } }, `${label} · ${files.length}`),
              React.createElement('button', {
                type: 'button',
                style: ghostBtnStyle,
                disabled: busy,
                onClick: () => setSelected((current) => {
                  const next = new Set(current)
                  for (const file of files) next.add(file.path)
                  return next
                }),
              }, t('dialog.selectAll')),
              React.createElement('button', {
                type: 'button',
                style: ghostBtnStyle,
                disabled: busy,
                onClick: () => setSelected((current) => {
                  const next = new Set(current)
                  for (const file of files) next.delete(file.path)
                  return next
                }),
              }, t('dialog.selectNone')),
            ),
            React.createElement('div', { style: listStyle },
              files.slice(0, 2000).map((file) =>
                React.createElement('label', { key: `${kind}:${file.path}`, style: rowStyle },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: selected.has(file.path),
                    disabled: busy,
                    onChange: (event) => setSelected((current) => {
                      const next = new Set(current)
                      if (event.target.checked) next.add(file.path)
                      else next.delete(file.path)
                      return next
                    }),
                  }),
                  React.createElement('span', { style: badgeStyle }, t(kind === 'added' ? 'dialog.added' : 'dialog.modified')),
                  React.createElement('span', { style: pathStyle, title: file.path }, file.path),
                  React.createElement('span', { style: sizeStyle }, formatBytes(file.size)),
                ),
              ),
            ),
          )
        }
        const added = group(t('dialog.added'), plan.added, 'added')
        const modified = group(t('dialog.modified'), plan.modified, 'modified')
        if (added) groups.push(added)
        if (modified) groups.push(modified)
        return React.createElement('div', { key: 'files', style: { display: 'flex', flexDirection: 'column', gap: 10 } }, groups)
      }

      if (step === 'scanning') {
        body.push(React.createElement('div', { key: 'scan', style: metaStyle }, t('dialog.scanning')))
      }
      if (step === 'files' && plan) {
        body.push(React.createElement('div', { key: 'files-title', style: { fontSize: 13, fontWeight: 600 } }, t('dialog.filesTitle')))
        body.push(React.createElement('div', { key: 'files-desc', style: metaStyle }, t('dialog.filesDesc')))
        if (plan.baseline === null) {
          body.push(React.createElement('div', { key: 'nobase', style: warnStyle }, t('dialog.noBaseline')))
        } else if (plan.added.length + plan.modified.length === 0) {
          body.push(React.createElement('div', { key: 'nofiles', style: metaStyle }, t('dialog.noFiles')))
        } else {
          if (plan.modified.length > 0) body.push(React.createElement('div', { key: 'modwarn', style: warnStyle }, t('dialog.modifiedWarn')))
          body.push(fileGroups())
          if (plan.truncated) body.push(React.createElement('div', { key: 'trunc', style: warnStyle }, t('dialog.truncated')))
        }
        if (plan.links && plan.links.length > 0) {
          body.push(React.createElement('div', { key: 'links', style: metaStyle }, t('dialog.linksNote', { n: plan.links.length })))
        }
        if (plan.removedCount > 0) {
          body.push(React.createElement('div', { key: 'removed', style: metaStyle }, t('dialog.removedNote', { n: plan.removedCount })))
        }
        body.push(React.createElement('div', { key: 'totals', style: metaStyle },
          `${t('dialog.bytes')}: ${totals.count} · ${formatBytes(totals.bytes)}`))
        body.push(React.createElement('label', { key: 'none', style: optStyle },
          React.createElement('button', {
            type: 'button',
            style: ghostBtnStyle,
            disabled: busy,
            onClick: () => setSelected(new Set()),
          }, t('dialog.selectNothing')),
        ))
      }
      if (step === 'done' && outcome) {
        const purged = outcome.purged
        body.push(React.createElement('div', { key: 'done-title', style: { fontSize: 13, fontWeight: 600 } },
          outcome.deleteSession ? t('dialog.doneTitle') : t('dialog.donePurged')))
        body.push(React.createElement('div', { key: 'done-files', style: metaStyle },
          purged && purged.moved.length > 0
            ? t('dialog.doneFiles', { n: purged.moved.length, bytes: formatBytes(purged.bytes) })
            : t('dialog.doneNoFiles')))
        if (purged && purged.failed.length > 0) {
          body.push(React.createElement('div', { key: 'done-failed', style: errStyle }, t('dialog.doneFailed', { n: purged.failed.length })))
        }
        if (purged && purged.trashDir) {
          body.push(React.createElement('div', { key: 'done-dir', style: metaStyle }, t('dialog.doneTrash'), purged.trashDir))
        }
        if (outcome.restored) {
          body.push(React.createElement('div', { key: 'restored', style: metaStyle }, t('dialog.restored', { n: outcome.restored.restored.length })))
          if (outcome.restored.renamed && outcome.restored.renamed.length > 0) {
            body.push(React.createElement('div', { key: 'restored-renamed', style: metaStyle }, t('dialog.restoredRenamed', { n: outcome.restored.renamed.length })))
          }
        }
        if (error) body.push(React.createElement('div', { key: 'err2', role: 'alert', style: errStyle }, error))
      }

      const footer = []
      if (step === 'done') {
        const purged = outcome && outcome.purged
        if (purged && purged.trashId && !(outcome.restored && outcome.restored.remaining === 0)) {
          footer.push(React.createElement('button', {
            key: 'restore',
            type: 'button',
            disabled: busy,
            onClick: restoreOutcome,
            style: cancelBtnStyle,
          }, t('dialog.restore')))
        }
        footer.push(React.createElement('button', {
          key: 'trash',
          type: 'button',
          disabled: busy,
          onClick: () => window.dispatchEvent(new CustomEvent(TRASH_EVENT, { detail: {} })),
          style: cancelBtnStyle,
        }, t('dialog.openTrash')))
        footer.push(React.createElement('button', {
          key: 'close',
          type: 'button',
          disabled: busy,
          onClick: close,
          style: dangerBtnStyle,
        }, t('dialog.close')))
      } else {
        footer.push(React.createElement('button', {
          key: 'cancel',
          type: 'button',
          disabled: busy,
          onClick: close,
          style: { ...cancelBtnStyle, ...(busy ? { opacity: 0.5, cursor: 'default' } : {}) },
        }, t('dialog.cancel')))
        if (step === 'intro') {
          footer.push(React.createElement('button', {
            key: 'go',
            type: 'button',
            disabled: busy || !target.sessionId,
            onClick: start,
            style: { ...dangerBtnStyle, ...(busy || !target.sessionId ? { opacity: 0.5, cursor: 'default' } : {}) },
          }, busy ? t('dialog.working') : t('dialog.confirm')))
        } else if (step === 'files') {
          footer.push(React.createElement('button', {
            key: 'keep',
            type: 'button',
            disabled: busy || selected.size === 0,
            onClick: () => runCleanup(false),
            style: { ...cancelBtnStyle, ...(busy || selected.size === 0 ? { opacity: 0.5, cursor: 'default' } : {}) },
          }, t('dialog.confirmKeep')))
          footer.push(React.createElement('button', {
            key: 'go',
            type: 'button',
            disabled: busy,
            onClick: () => runCleanup(true),
            style: { ...dangerBtnStyle, ...(busy ? { opacity: 0.5, cursor: 'default' } : {}) },
          }, busy ? (busyLabel || t('dialog.working')) : t('dialog.confirm')))
        }
      }

      return React.createElement(Modal, {
        open: true,
        onClose: close,
        title: t('dialog.title'),
        closeLabel: t('dialog.cancel'),
        description,
        footer,
      }, body)
    }

    // --- the trash panel -------------------------------------------------------

    function TrashPanel(props) {
      const t = (props && props.t) || __t
      useLocaleRevision()
      const [open, setOpen] = useState(false)
      const [state, setState] = useState({ loading: false, entries: [], trashRoot: null, error: null })
      // Checked batches, kept as a plain array of ids: a reload re-checks the list
      // and drops whatever the host no longer reports, so a stale checkbox can
      // never name a batch that is already gone.
      const [selected, setSelected] = useState([])
      const [notice, setNotice] = useState(null)

      const load = useCallback(async () => {
        setState({ loading: true, entries: [], trashRoot: null, error: null })
        try {
          const response = await fetch('/__sespurge/trash')
          const data = await response.json()
          if (!data.ok) throw new Error(data.error || 'failed')
          const entries = data.value.entries || []
          setState({ loading: false, entries, trashRoot: data.value.trashRoot, error: null })
          const listed = new Set(entries.map((entry) => entry.id))
          setSelected((current) => current.filter((id) => listed.has(id)))
        } catch (reason) {
          setState({ loading: false, entries: [], trashRoot: null, error: String((reason && reason.message) || reason) })
          setSelected([])
        }
      }, [])

      useEffect(() => {
        const handler = () => setOpen(true)
        window.addEventListener(TRASH_EVENT, handler)
        return () => window.removeEventListener(TRASH_EVENT, handler)
      }, [])

      // The panel reads the Host whenever it is open, so a panel opened by any
      // route (event, remount) always shows the current trash.
      useEffect(() => {
        if (open) void load()
      }, [open, load])

      const restore = useCallback(async (id) => {
        try {
          await postJson('/__sespurge/trash/restore', { id })
        } catch (reason) {
          setState((current) => ({ ...current, error: String((reason && reason.message) || reason) }))
        }
        await load()
      }, [load])

      const toggle = useCallback((id) => {
        setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]))
      }, [])

      // One deleter for the row button, the selection and "all of it": the ids are
      // always explicit, so the panel can only ever drop batches it just listed.
      const dropMany = useCallback(async (ids, confirmKey) => {
        const wanted = (Array.isArray(ids) ? ids : [ids]).filter((id) => typeof id === 'string' && id !== '')
        if (wanted.length === 0) {
          setNotice(t('trash.dropNothing'))
          return
        }
        if (typeof window.confirm === 'function' && !window.confirm(t(confirmKey, { n: wanted.length }))) return
        setNotice(null)
        try {
          const result = await postJson('/__sespurge/trash/drop', { ids: wanted })
          const gone = result && Array.isArray(result.dropped) ? result.dropped : wanted
          const missed = result && Array.isArray(result.failed) ? result.failed : []
          setSelected((current) => current.filter((id) => !gone.includes(id)))
          if (missed.length > 0) {
            setState((current) => ({
              ...current,
              error: missed.map((row) => `${row.id}: ${row.error}`).join('; '),
            }))
          } else {
            setNotice(t('trash.droppedMany', { n: gone.length }))
          }
        } catch (reason) {
          setState((current) => ({ ...current, error: String((reason && reason.message) || reason) }))
        }
        await load()
      }, [load, t])

      const drop = useCallback((id) => dropMany([id], 'trash.dropConfirm'), [dropMany])

      const toggleAll = useCallback(() => {
        const ids = (state.entries || []).map((entry) => entry.id)
        setSelected((current) => (ids.length > 0 && current.length === ids.length ? [] : ids))
      }, [state.entries])

      const dropSelected = useCallback(() => dropMany(selected, 'trash.dropSelectedConfirm'), [dropMany, selected])

      if (!open) return null

      const allSelected = state.entries.length > 0 && selected.length === state.entries.length
      // The select-all row sits above the batches: tick it, then one button takes
      // the whole selection out for good (the empty trash case has no toolbar).
      const toolbar = state.entries.length > 0
        ? React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          React.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' } },
            React.createElement('input', {
              type: 'checkbox',
              checked: allSelected,
              'aria-label': t('trash.selectAll'),
              onChange: toggleAll,
            }),
            t('trash.selectAll')),
          React.createElement('span', { style: metaStyle }, t('trash.selectedCount', { n: selected.length })),
          React.createElement('button', {
            type: 'button',
            'aria-label': t('trash.dropSelected'),
            disabled: selected.length === 0,
            onClick: dropSelected,
            style: {
              ...ghostBtnStyle,
              color: 'var(--dsw-alias-state-error-primary, #e5484d)',
              ...(selected.length === 0 ? { opacity: 0.5, cursor: 'default' } : {}),
            },
          }, t('trash.dropSelected')))
        : null
      const rows = (state.entries || []).map((entry) =>
        React.createElement('div', {
          key: entry.id,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '10px 12px',
            border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
            borderRadius: 8,
          },
        },
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
          React.createElement('input', {
            type: 'checkbox',
            checked: selected.includes(entry.id),
            'aria-label': t('trash.select'),
            onChange: () => toggle(entry.id),
          }),
          React.createElement('strong', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            entry.sessionId || entry.id),
          React.createElement('span', { style: metaStyle }, t('trash.entryCount', { n: entry.fileCount })),
          React.createElement('span', { style: metaStyle }, formatBytes(entry.bytes)),
        ),
        React.createElement('div', { style: metaStyle }, `${entry.at} · ${entry.root}`),
        entry.missing ? React.createElement('div', { style: warnStyle }, t('trash.missing')) : null,
        React.createElement('div', { style: { display: 'flex', gap: 8 } },
          React.createElement('button', {
            type: 'button',
            style: ghostBtnStyle,
            disabled: entry.missing,
            onClick: () => restore(entry.id),
          }, t('trash.restoreAll')),
          React.createElement('button', {
            type: 'button',
            style: { ...ghostBtnStyle, color: 'var(--dsw-alias-state-error-primary, #e5484d)' },
            onClick: () => drop(entry.id),
          }, t('trash.drop')),
        )),
      )

      return React.createElement('div', {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 3000,
          background: 'rgba(0,0,0,.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
        },
        onClick: (event) => {
          if (event.target === event.currentTarget) setOpen(false)
        },
      },
      React.createElement('div', {
        role: 'dialog',
        'aria-modal': 'true',
        style: {
          width: 'min(680px, 92vw)',
          maxHeight: '80vh',
          overflowY: 'auto',
          background: 'var(--dsw-alias-bg-base, #1c1c1e)',
          color: 'var(--dsw-alias-label-primary, inherit)',
          border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.3))',
          borderRadius: 12,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        },
      },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('strong', { style: { flex: 1, fontSize: 14 } }, t('trash.title')),
        React.createElement('button', { type: 'button', style: ghostBtnStyle, onClick: () => setOpen(false) }, t('trash.close'))),
      React.createElement('div', { style: metaStyle }, t('trash.desc')),
      state.trashRoot ? React.createElement('div', { style: metaStyle }, t('trash.root'), state.trashRoot) : null,
      state.error ? React.createElement('div', { role: 'alert', style: errStyle }, state.error) : null,
      notice ? React.createElement('div', { role: 'status', style: metaStyle }, notice) : null,
      toolbar,
      state.loading
        ? React.createElement('div', { style: metaStyle }, t('trash.loading'))
        : rows.length > 0
          ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, rows)
          : React.createElement('div', { style: metaStyle }, t('trash.empty')),
      ),
      )
    }

    // --- header button ---------------------------------------------------------

    function PurgeHeaderButton(props) {
      const { sessionId, useSessions } = props
      const t = (props && props.t) || __t
      useLocaleRevision()
      const sessions = useSessions ? useSessions((state) => state) : undefined
      const summary = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
      const running = summary ? summary.running === true : false

      const open = useCallback(() => {
        window.dispatchEvent(new CustomEvent(EVENT, {
          detail: { sessionId, title: (summary && summary.title) || null, running },
        }))
      }, [sessionId, summary, running])

      return React.createElement('button', {
        type: 'button',
        title: running ? t('button.titleRunning') : t('button.title'),
        'aria-label': t('button.title'),
        style: btnStyle,
        onClick: open,
      }, React.createElement(IconTrashOutline16, { size: 16 }))
    }

    // --- sidebar row menu injection --------------------------------------------

    const TRASH_PATH = 'M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z'

    const MENU_ITEM_CSS = [
      'display:flex',
      'align-items:center',
      'gap:8px',
      'width:100%',
      'padding:6px 12px',
      'border:none',
      'background:transparent',
      'font:inherit',
      'font-size:13px',
      'line-height:20px',
      'text-align:left',
      'border-radius:6px',
      'cursor:pointer',
    ].join(';')

    function findOpenSessionRow() {
      const rows = document.querySelectorAll('[class*=sessionRow]')
      for (let index = 0; index < rows.length; index += 1) {
        if (String(rows[index].className || '').indexOf('menuOpen') >= 0) return rows[index]
      }
      return null
    }

    function rowTitle(row) {
      const titleEl = row.querySelector('[class*=title]')
      return titleEl ? String(titleEl.innerText || '').trim() : ''
    }

    function menuItem(kind, label, danger) {
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.setAttribute('data-sespurge', kind)
      item.style.cssText = `${MENU_ITEM_CSS};color:${danger ? 'var(--dsw-alias-state-error-primary,#e5484d)' : 'var(--dsw-alias-label-primary,inherit)'}`
      item.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex:none"><path d="${TRASH_PATH}" fill="currentColor"/></svg><span></span>`
      item.querySelector('span').textContent = label
      item.addEventListener('mouseenter', () => { item.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))' })
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent' })
      return item
    }

    function ensureSidebarItems() {
      const menu = document.querySelector('[role=menu]')
      if (!menu) return
      if (menu.querySelector(`[${SIDEBAR_ATTR}]`)) return
      const row = findOpenSessionRow()
      if (!row) return
      const title = rowTitle(row)
      if (!title) return

      const separator = document.createElement('div')
      separator.style.cssText = 'height:1px;margin:4px 8px;background:var(--dsw-alias-border-l1,rgba(128,128,128,.2))'

      const deleteItem = menuItem('delete', __t('menu.deleteWithFiles'), true)
      deleteItem.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent(EVENT, { detail: { title } }))
      })
      const purgeItem = menuItem('purge', __t('menu.purgeFiles'), false)
      purgeItem.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent(EVENT, { detail: { title, keepSession: true } }))
      })
      const trashItem = menuItem('trash', __t('menu.trash'), false)
      trashItem.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent(TRASH_EVENT, { detail: {} }))
      })

      menu.appendChild(separator)
      menu.appendChild(deleteItem)
      menu.appendChild(purgeItem)
      menu.appendChild(trashItem)
    }

    function refreshSidebarLabels() {
      const labels = { delete: 'menu.deleteWithFiles', purge: 'menu.purgeFiles', trash: 'menu.trash' }
      const items = document.querySelectorAll(`[${SIDEBAR_ATTR}]`)
      for (let index = 0; index < items.length; index += 1) {
        const span = items[index].querySelector('span')
        const kind = items[index].getAttribute(SIDEBAR_ATTR)
        if (span && labels[kind]) span.textContent = __t(labels[kind])
      }
    }

    function installSidebarItems() {
      if (window.__sespurgeSidebarInstalled) return
      window.__sespurgeSidebarInstalled = true
      try {
        ensureSidebarItems()
      } catch {
        /* never break the sidebar */
      }
      const observer = new MutationObserver(() => {
        try {
          ensureSidebarItems()
        } catch {
          /* never break the sidebar */
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
    }

    // --- in-place session list refresh after a delete --------------------------

    function refreshSessionList(deletedSessionId) {
      const svc = __sessionsSvc
      if (!svc || !svc.list) return
      let deletedCurrent = false
      try {
        deletedCurrent = svc.list.getSnapshot().current === deletedSessionId
      } catch {
        /* ignore */
      }
      const refresh =
        typeof svc.refresh === 'function'
          ? () => svc.refresh()
          : typeof svc.refreshList === 'function'
            ? () => svc.refreshList()
            : null
      if (refresh === null) return
      Promise.resolve(refresh()).then(() => {
        if (!deletedCurrent) return
        try {
          const snapshot = svc.list.getSnapshot()
          const next = ((snapshot && snapshot.ids) || []).find((id) => id !== deletedSessionId)
          if (next && typeof svc.open === 'function') svc.open(next)
        } catch {
          /* ignore */
        }
      }).catch(() => {})
    }

    // --- apply -----------------------------------------------------------------

    function adoptLocale(locale, ctx) {
      if (!locale) return
      __locale = locale
      try {
        if (typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: zhDict, en: enDict }))
        }
      } catch {
        /* namespace already registered */
      }
    }

    function apply(ctx) {
      __sessionsSvc = ctx.get('sessions')
      if (!__sessionsSvc) {
        ctx.inject(['sessions'], (sub) => {
          __sessionsSvc = sub.sessions
        })
      }
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        ctx.inject(['locale'], (sub) => {
          adoptLocale(sub.locale, ctx)
          refreshSidebarLabels()
        })
      }
      ctx.on('locale/change', refreshSidebarLabels)

      ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
        name: HEADER_SLOT,
        id: HEADER_ROW_ID,
        order: 31,
        ...(__locale ? { locale: NS } : {}),
      }, PurgeHeaderButton))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: DIALOG_ID,
        order: 101,
        ...(__locale ? { locale: NS } : {}),
      }, DeleteWithFilesDialog))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: TRASH_ID,
        order: 102,
        ...(__locale ? { locale: NS } : {}),
      }, TrashPanel))
      installSidebarItems()
    }

    return { apply, inject: ['slots'] }
  },
})
