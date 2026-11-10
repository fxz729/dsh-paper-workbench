// dsh-paper-reader — BROWSER half（全部走官方 seam 组合，零自绘聊天）。
//
// 布局组合（用户习惯：中间论文、最右对话）：
//   [侧栏: 专题→论文→会话 树]  [中间: PDF 阅读器]  [最右: 原生 dsh 对话]
//   - 保留原生 main/conversation 树；唯一工作 PDF 使用原生 rightbar.session 裸根，
//     多工作页签保留官方 pane/tab 导航并去掉外壳留白。AppFrame 的 rightbar 列放第 2 轨，
//     center 列进入第 3 轨（原生对话），iframe 始终由同一个全局 surface 持有。
//     工作台在宽屏实际激活时独占布局；其余仅可见阅读页签宽屏用独立自有 CSS。
//     原生 frame/panel 的 inline style 与 layout 服务保持原样，离开时移除自有样式。
//   - sidebar.workspaces single slot 按 priority -1000 接管（lowest renders）——但**按需**：
//     「论文伴读模式」默认关闭，侧栏主导航开关行点击才注册（再点注销，
//     还原官方工作区列表），localStorage 记忆。安装后官方侧栏原样，只多一行开关。
//   - 选中即问：阅读器内选中 → /api/ask 注入当前会话 → 原生对话区实时流出。
//
// 加载机制：package.json 声明 dsh.client.inject + exports["./client"]；require 解析
// 官方客户端包，不要用裸 import。

/**
 * 失败文案组装（**纯函数**：入参 `err` + i18n 的 `t`，返回 `{ text, recovery }`）。
 * 放在 `load()` **之外**的文件顶层：Node 里执行本文件即可直接取用（测试用 harness 追加导出），
 * 不需要给模块对象加任何测试钩子。
 *
 * 为什么必须在这里组装（评审 F-B）：clear 失败会返回 409 `file-busy` 且带 `rollbackFailed` ——
 * 那些文件**真的还在 `.trash/` 里**，而 `listPapers` 只看常规文件，于是文献树里该篇看起来
 * 「消失」了。若只 toast 一句「文件被占用，关闭后重试」，用户永远不知道该去回收站恢复。
 * 规则：
 *   · `rollbackFailed` 非空 ⇒ 点名文件 + 给出回收站**相对**路径（`trashRel`，绝不用绝对路径）与恢复方法；
 *   · 未回滚非空时**不得**声称「文献库未改变」（F-C：那句是服务端内层文案，只对失败那一篇成立）；
 *   · 没有回滚失败 ⇒ 只给简洁文案，不吓唬用户。
 */
function paperWorkspaceRows(paths, workspaces) {
  const canonical = value => {
    const path = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
    return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path
  }
  const exact = new Set(paths.map(canonical))
  return workspaces.filter(w => exact.has(canonical(w.path))).flatMap(w => [
    `workspace:${w.workspaceId}`, `overflow:${w.workspaceId}`, ...(w.sessionIds || []).map(id => `session:${id}`),
  ])
}

function clearFailureText(err, t) {
  const files = Array.isArray(err && err.rollbackFailed) ? err.rollbackFailed.filter((x) => typeof x === 'string') : []
  const where = err && typeof err.trashRel === 'string' && err.trashRel ? err.trashRel : '.trash'
  const base = err && err.code === 'file-busy' ? t('delBusyFile') : ((err && err.message) || String(err))
  if (files.length === 0) return { text: base, recovery: '' }
  return {
    text: t('clearPartialFailText').replace('{n}', String(files.length)).replace('{names}', files.join('、')),
    recovery: t('clearRecoveryHint').replace('{where}', where).replace('{names}', files.join('、')),
  }
}

// A modern preview is an immutable server plan, never a client-reconstructed file list.
function dprDeletePlanMatches(plan, target) {
  if (!plan || (!Object.hasOwn(plan, 'planId') && !plan.entityId && !plan.mode)) return true
  const mode = target.kind === 'paper' ? 'paper' : target.kind === 'topic-clear' ? 'clear-collection' : 'empty-collection'
  const id = target.kind === 'paper' ? target.paperId : target.collectionId
  return typeof plan.planId === 'string' && !!plan.planId.trim() && !!id && plan.entityId === id && plan.mode === mode &&
    Array.isArray(plan.affectedFiles) && plan.affectedFiles.every(file => typeof file === 'string')
}
function dprDeleteAffects(current, target) {
  if (!current) return false
  if (target.kind === 'paper') {
    if (current.paperId || target.paperId) return !!current.paperId && current.paperId === target.paperId
    return current.topic === target.topic && current.name === target.name
  }
  if (current.collectionId || target.collectionId) return !!current.collectionId && current.collectionId === target.collectionId
  return current.topic === target.topic
}

/**
 * 分屏「同步滚动」偏好 —— **纯函数**（文件顶层：Node 里执行本文件即可取用，测试 harness 追加导出）。
 * 与 `reader/index.html` 里的同键读写必须保持同一套编码，所以两边都只认 `'1'` / `'0'`。
 *
 * 键为什么长这样（`dpr.syncScroll`：无 topic/name、也不带 `dpr.variant.` 前缀）：
 *   ① 用户明确要求**全局**（所有论文共用一个值，不按篇记）；
 *   ② `migrateLsKeys`（改名搬家）只搬 `dpr.variant.` / `dpr.sessionN.` 两个前缀 ⇒ 这个键既不会被搬
 *      也不会被删，论文/专题改名**不可能**让偏好丢失（全局键本来就没有「跟着某篇走」的身份）。
 *      反例：若塞进 `dpr.variant.<topic>/<name>`（按篇），改名搬家会搬它，而「全局」语义就破了。
 *   ③ 缺省 = 开：与改造前「分屏两列被 rAF 强行同步」的既有行为一致（老用户升级后观感不变）。
 */
const DPR_SYNC_SCROLL_KEY = 'dpr.syncScroll'
/** 只认显式的 '0' 为关；缺失 / 脏值 / 隐私模式都算开（与 reader 的 readSyncPref 逐字同义）。 */
function dprSyncScrollFromRaw(raw) { return raw !== '0' }
function dprSyncScrollRaw(on) { return on ? '1' : '0' }

// Destructive library requests keep the old reader identity locked until either
// navigation consumes this saved lease or the request fails/stays on this reader.
function createDprReaderSaveLease(getFrame) {
  let lease = null
  const currentBridge = () => getFrame()?.contentWindow?.DprInk
  return {
    async run(action) {
      if (lease) throw new Error('Ink save/library operation already in progress')
      const held = { frame: getFrame(), bridge: currentBridge(), promise: null, consumed: false }
      lease = held
      try {
        held.promise = Promise.resolve(held.bridge?.beforeNavigate?.())
        await held.promise
        return await action()
      } finally {
        if (lease === held) lease = null
        if (!held.consumed && held.frame === getFrame() && held.bridge === currentBridge()) held.bridge?.didNavigate?.()
      }
    },
    beforeNavigate() {
      if (lease && lease.frame === getFrame() && lease.bridge === currentBridge()) {
        lease.consumed = true
        return lease.promise
      }
      return currentBridge()?.beforeNavigate?.()
    },
  }
}

function dprReaderSource(paper) {
  return paper ? `/paper-reader/?topic=${encodeURIComponent(paper.topic)}&name=${encodeURIComponent(paper.name)}${paper.paperId ? '&paperId=' + encodeURIComponent(paper.paperId) : ''}${paper.page ? '&page=' + paper.page : ''}${paper.q ? '&q=' + encodeURIComponent(paper.q) : ''}` : null
}

function dprSamePaper(a, b) {
  if (!a || !b) return a === b
  return a.paperId && b.paperId ? a.paperId === b.paperId : a.topic === b.topic && a.name === b.name
}
function dprReaderNeedsNavigation(current, next) {
  return !dprSamePaper(current, next) || (current?.page || 0) !== (next?.page || 0) || (current?.q || '') !== (next?.q || '')
}
function dprSyncReaderIdentity(frame, paper, origin) {
  if (!paper?.paperId || !frame?.contentWindow) return
  const ref = { paperId: paper.paperId, collectionId: paper.collectionId, topic: paper.topic, name: paper.name, locationRevision: paper.locationRevision }
  try {
    const url = new URL(frame.contentWindow.location.href)
    if (url.origin === origin) {
      url.searchParams.set('paperId', paper.paperId)
      url.searchParams.set('topic', paper.topic); url.searchParams.set('name', paper.name)
      frame.contentWindow.history.replaceState(null, '', url.href)
    }
    frame.contentWindow.postMessage({ type: 'dpr:reader-identity', ref }, origin)
  } catch { /* reader bootstrap/onLoad will retry after its same-origin document is ready */ }
}
function dprLibraryModel(tree, legacy = {}) {
  if (!Array.isArray(tree?.collections)) return { ...legacy, collections: (legacy.topics || []).map(topic => ({ name: topic, topic, parentId: null, papers: (legacy.papers || []).filter(p => p.topic === topic) })) }
  const enriched = new Map((legacy.papers || []).filter(p => p.paperId).map(p => [p.paperId, p]))
  const collections = tree.collections.map(c => ({ ...c, topic: (c.segments || [c.name]).join('/'), papers: (c.papers || []).map(p => ({ ...enriched.get(p.paperId), ...p, collectionId: p.collectionId || c.collectionId, topic: (p.segments || c.segments || [c.name]).join('/') })) }))
  return { ...legacy, hasTree: true, collections, topics: collections.map(c => c.topic), papers: collections.flatMap(c => c.papers) }
}

function dprDockReaderSource(ref, workspaceSessionId) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(ref?.paperId || '')) throw new Error('文献身份无效')
  if (typeof workspaceSessionId !== 'string' || !workspaceSessionId || workspaceSessionId.length > 256 || /[\u0000-\u001f]/.test(workspaceSessionId) || workspaceSessionId.startsWith('dpr-')) throw new Error('请选择普通工作区会话')
  const variant = ['orig', 'zh', 'dual'].includes(ref.variant) ? ref.variant : 'orig'
  return '/paper-reader/?' + new URLSearchParams({ paperId: ref.paperId, variant, dock: '1', workspaceSessionId })
}

// The native close hook is synchronous. Throw to retain the tab, save for real, then
// re-enter closeIn with a single-use permit bound to this mounted frame's lifetime.
function createDprDockReading(sidebarRight, reportError = () => {}) {
  const mounted = new Map(), key = (sessionId, tabId) => JSON.stringify([sessionId, tabId]); let disposed = false, placementTimer = null
  const place = held => {
    if (!held.pageFrame) return
    const anchor = held.getAnchor?.(), rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null
    const shown = held.visible && sidebarRight.mounted.getSnapshot() === held.sessionId && rect?.width > 1 && rect?.height > 1
    Object.assign(held.pageFrame.style, shown ? { display: 'block', left: Math.round(rect.left) + 'px', top: Math.round(rect.top) + 'px', width: Math.round(rect.width) + 'px', height: Math.round(rect.height) + 'px' } : { display: 'none' })
  }
  const current = held => !disposed && mounted.get(held.key) === held
  const frameOf = held => { const frame = held.getFrame(); return { frame, window: frame?.contentWindow, bridge: frame?.contentWindow?.DprInk } }
  const sameFrame = (held, captured) => { const now = frameOf(held); return current(held) && now.frame === captured.frame && now.window === captured.window && now.bridge === captured.bridge }
  const failure = error => { try { reportError(error?.message || String(error)) } catch { /* UI reporting is not admission. */ } }
  function flush(held) {
    if (held.saving) return held.saving
    const captured = frameOf(held)
    if (!current(held) || typeof captured.bridge?.beforeNavigate !== 'function') throw new Error('阅读器尚未就绪，请稍后保存再关闭')
    const result = captured.bridge.beforeNavigate()
    held.saving = Promise.resolve(result).then(() => {
      if (!sameFrame(held, captured)) throw new Error('阅读页已变化，请重新确认')
      return captured
    }).finally(() => {
      held.saving = null
      if (sameFrame(held, captured)) captured.bridge.didNavigate?.()
    })
    return held.saving
  }
  const unregister = sidebarRight.registerCloseHandler('dpr-dock-reader', (sessionId, tab) => {
    const held = mounted.get(key(sessionId, tab.id))
    if (!held) throw new Error('阅读器尚未就绪，请保存后重试')
    if (held.permit && sameFrame(held, held.permit)) { held.permit = null; return }
    if (!held.closing) {
      held.closing = flush(held).then(captured => {
        if (!sameFrame(held, captured)) return
        held.permit = captured
        try {
          sidebarRight.closeIn(sessionId, tab.id)
          if (current(held) && held.pageFrame) { held.pageFrame.remove(); mounted.delete(held.key) }
        } finally { held.permit = null }
      }).catch(failure).finally(() => { held.closing = null })
    }
    throw new Error('墨迹正在保存，保存成功后关闭')
  })
  return {
    frame(sessionId, tabId) { return mounted.get(key(sessionId, tabId))?.getFrame() },
    mountPage(sessionId, tabId, ref, src, getAnchor) {
      if (disposed) throw new Error('阅读器已关闭')
      const id = key(sessionId, tabId)
      let held = mounted.get(id)
      if (held && held.ref.paperId !== ref.paperId) throw new Error('阅读页身份已变化')
      if (!held) {
        const frame = window.document.createElement('iframe')
        frame.setAttribute('data-dpr-dock-frame', ''); frame.setAttribute('data-dpr-dock-tab', tabId); frame.setAttribute('title', '论文 PDF'); frame.src = src
        Object.assign(frame.style, { position: 'fixed', display: 'none', border: '0', minWidth: '0', minHeight: '0', zIndex: '24', background: 'var(--dsw-alias-bg-base,#fff)' })
        held = { key: id, sessionId, tabId, ref: { ...ref }, getFrame: () => frame, pageFrame: frame, saving: null, closing: null, permit: null, visible: false }
        mounted.set(id, held); window.document.body.appendChild(frame)
      }
      const binding = {}; held.binding = binding; held.getAnchor = getAnchor; place(held)
      if (placementTimer === null) placementTimer = window.setInterval(() => { for (const page of mounted.values()) place(page) }, 150)
      return () => {
        if (!current(held) || held.binding !== binding) return
        try { Promise.resolve(flush(held)).catch(failure) } catch (error) { failure(error) }
        held.visible = false; held.getAnchor = null; place(held)
      }
    },
    mount(sessionId, tabId, ref, getFrame) {
      const id = key(sessionId, tabId), held = { key: id, sessionId, tabId, ref: { ...ref }, getFrame, saving: null, closing: null, permit: null, visible: false }
      mounted.set(id, held)
      return () => { if (mounted.get(id) === held) mounted.delete(id) }
    },
    async visible(sessionId, tabId, visible) {
      const held = mounted.get(key(sessionId, tabId)); if (!held) return
      const leaving = held.visible && !visible; held.visible = !!visible
      if (leaving && !held.closing) { try { await flush(held) } catch (error) { failure(error) } }
      place(held)
    },
    async save(sessionId, tabId) {
      const held = mounted.get(key(sessionId, tabId)); if (!held) throw new Error('阅读器尚未就绪，请稍后重试')
      await flush(held)
    },
    async openPaper(ref, sessionId) {
      dprDockReaderSource(ref, sessionId)
      if (disposed || sidebarRight.mounted.getSnapshot() !== sessionId) throw new Error('当前会话已变化，请重新打开文献')
      const existing = [...mounted.values()].find(held => held.sessionId === sessionId && held.ref.paperId === ref.paperId)
      for (const held of mounted.values()) if (held !== existing && held.sessionId === sessionId && held.visible) await flush(held)
      if (disposed || sidebarRight.mounted.getSnapshot() !== sessionId) throw new Error('当前会话已变化，请重新打开文献')
      if (existing && current(existing)) {
        if (ref.variant) {
          const reader = frameOf(existing).window?.dpr
          if (typeof reader?.openPaper !== 'function') throw new Error('阅读器尚未就绪，请稍后重试')
          await reader.openPaper(ref.topic, ref.name, undefined, undefined, ref.paperId)
          if (!current(existing) || sidebarRight.mounted.getSnapshot() !== sessionId) return
        }
        sidebarRight.focus(existing.tabId); return
      }
      sidebarRight.openTab('dpr-dock-reader', { params: { paperId: ref.paperId, collectionId: ref.collectionId, name: ref.name, topic: ref.topic, variant: ref.variant || 'orig', workspaceSessionId: sessionId } })
    },
    dispose() { disposed = true; unregister(); if (placementTimer !== null) window.clearInterval(placementTimer); for (const held of mounted.values()) held.pageFrame?.remove(); mounted.clear() },
  }
}

function dprSessionPaper(sid) {
  const match = typeof sid === 'string' && sid.match(/^dpr-v2-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(\d+)$/i)
  return match ? { paperId: match[1], n: Number(match[2]) } : null
}

// Share one real snapshot/CAS flush across rapid requests; only the newest may commit.
function createDprReaderNavigation({ beforeNavigate, commit, onError, needsNavigation = () => true, resume = () => {} }) {
  let token = 0, flushing = null, disposed = false
  return {
    async navigate(next) {
      const request = ++token
      try {
        let locked = !!flushing
        if (!flushing && needsNavigation(next)) {
          locked = true
          flushing = Promise.resolve(beforeNavigate()).finally(() => { flushing = null })
        }
        if (flushing) await flushing
        if (disposed || request !== token) return false
        // A → B(pending save) → A cancels B but must unlock the retained A editor.
        if (locked && !needsNavigation(next)) resume()
        commit(next)
        return true
      } catch (error) {
        if (!disposed && request === token) onError(error)
        return false
      }
    },
    async afterDelete(next, isDeleted) {
      if (disposed || typeof isDeleted !== 'function' || !isDeleted()) return false
      const request = ++token
      // The committed Gate already saved this deleted identity; join any older save without starting another.
      if (flushing) await flushing.catch(() => {})
      if (disposed || request !== token || !isDeleted()) return false
      commit(next)
      return true
    },
    dispose() { disposed = true; token++ },
  }
}

// Layout ownership is local and reversible. Native-workbench's marker survives narrow
// mode, so its 1200px media contract is part of the ownership test.
function dprVisibleElement(el, win) {
  if (!el?.isConnected || !el.getClientRects().length) return false
  for (let node = el; node; node = node.parentElement) {
    const css = win.getComputedStyle(node)
    if (node.hidden || css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || css.opacity === '0') return false
  }
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && rect.left < win.innerWidth && rect.left + rect.width > 0 &&
    rect.top + rect.height > 0 && rect.top < (win.innerHeight || Infinity)
}

function dprConversationColumn(frame) {
  return frame && Array.from(frame.children).find(el => !el.hasAttribute('data-rightbar-col') &&
    (el.matches('[data-slot="main.conversation"]') || el.querySelector('[data-slot="main.conversation"]')))
}

function dprReaderAnchor(doc, win, sessionId, tabId) {
  return Array.from(doc.querySelectorAll('[data-dpr-tab]')).find(el =>
    el.getAttribute('data-dpr-visible') !== 'false' &&
    (!sessionId || el.getAttribute('data-dpr-session') === sessionId) &&
    (!tabId || el.getAttribute('data-dpr-tab-id') === tabId) && dprVisibleElement(el, win)) || null
}

function dprWorkbenchOwner(doc, win) {
  if (win.innerWidth < 1200) return false
  return Array.from(doc.querySelectorAll('[data-nwl-active]')).some(el => dprVisibleElement(el, win)) ||
    Array.from(doc.querySelectorAll('[data-dsh-workbench-frame]')).some(el => !el.hasAttribute('data-dsh-workbench-editor-collapsed') && dprVisibleElement(el, win))
}

// Desktop 0.2.2 exposes this single/session slot and the public sidebar screen/target APIs.
// Keep native pane navigation whenever another working tab exists; the iframe stays global.
// Retained mainView sessions are committed SDK navigation; sidebar list changes are not.
function createDprReadingContext(services, getPaper, isReaderSession = id => typeof id === 'string' && id.startsWith('dpr-')) {
  const snapshot = source => { try { return source?.getSnapshot?.() } catch { return undefined } }
  return {
    update() {
      const sessions = snapshot(services.uiWorkspace?.sessions?.list)
      const sessionId = sessions?.current !== undefined ? sessions.current :
        Object.values(sessions?.byId || {}).find(row => (row.retainedBy?.mainView || 0) > 0)?.id ?? snapshot(services.sidebarRight?.mounted) ?? services.sidebarRight?.binding?.sessionId
      const rows = snapshot(services.workspaces?.list || services.uiWorkspace?.workspaces?.list)?.items || []
      const workspaceId = rows.find(row => Array.isArray(row.sessionIds) && row.sessionIds.includes(sessionId))?.workspaceId
      const paper = getPaper(), enabled = !!paper && (!workspaceId || isReaderSession(sessionId))
      const paperKey = paper?.paperId || JSON.stringify([paper?.topic, paper?.name])
      return { enabled, sessionId, workspaceId, viewKey: enabled ? 'paper:' + paperKey : workspaceId ? 'workspace:' + workspaceId : null }
    },
    subscribe(callback) {
      const sources = new Set([services.uiWorkspace?.sessions?.list, services.workspaces?.list || services.uiWorkspace?.workspaces?.list, services.sidebarRight?.mounted])
      const disposers = []; for (const source of sources) if (typeof source?.subscribe === 'function') disposers.push(source.subscribe(callback))
      return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose() }
    },
  }
}

function createDprBareReaderSeat(doc, win, services, component) {
  let available = false, registration = null, stopped = false, last = { enabled: false }
  const release = () => { const dispose = registration; registration = null; dispose?.() }
  function update(options) {
    last = options
    let adopt = false
    if (!stopped && available && options.enabled && win.innerWidth >= 1200 && !dprWorkbenchOwner(doc, win) &&
      !Array.from(doc.querySelectorAll('[data-rightbar-fullscreen]')).some(el => dprVisibleElement(el, win))) {
      try {
        const sr = services.sidebarRight, screen = sr.screen(), target = sr.commandTarget(null)
        const tabs = sr.tabsIn(screen.sessionId).filter(tab => tab.kind !== 'guide')
        adopt = screen.surface.layout.expanded === true && screen.surface.layout.mode !== 'fullscreen' && target?.sessionId === screen.sessionId && target.host === 'dock' &&
          tabs.length === 1 && tabs[0].kind === 'dpr-reader' && tabs[0].id === target.tabId
      } catch { /* Unsupported/cold native seats retain the official pane. */ }
    }
    if (adopt && !registration) registration = services.slots.register({
      name: 'rightbar.session', id: 'dpr-bare-reader', priority: -1000,
      inject: () => ({ layoutService: services.layout, isReaderExpanded: sessionId => {
        try { const screen = services.sidebarRight.screen(); return screen?.sessionId === sessionId && screen.surface.layout.expanded === true && screen.surface.layout.mode !== 'fullscreen' } catch { return false }
      } }),
    }, component)
    else if (!adopt) release()
    return !!registration
  }
  const capable = typeof services.slots?.inject === 'function' && typeof services.slots?.register === 'function' &&
    typeof services.layout?.openRightbar === 'function' && ['screen', 'commandTarget', 'tabsIn'].every(key => typeof services.sidebarRight?.[key] === 'function')
  const detach = capable ? services.slots.inject('rightbar.session', () => {
    available = true; update(last)
    return () => { available = false; release() }
  }) : null
  return { update, dispose() { stopped = true; release(); if (typeof detach === 'function') detach() } }
}

function dprReaderControlsBottom(frame) {
  let bottom = 88
  try {
    for (const node of frame?.contentDocument?.querySelectorAll('#bar, .dpr-ink-toolbar') || []) {
      const rect = node.getBoundingClientRect()
      if (rect.height > 0 && Number.isFinite(rect.bottom)) bottom = Math.max(bottom, Math.ceil(rect.bottom))
    }
  } catch { /* A loading/unavailable frame uses a conservative toolbar clearance. */ }
  return bottom
}

function createDprClientInteractions(doc, win, actions) {
  const frames = new Map()
  const keydown = e => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || String(e.key).toLowerCase() !== 'd') return
    e.preventDefault(); e.stopImmediatePropagation()
    if (e.repeat) return
    if (!actions.toggleChat()) actions.toggleDock()
  }
  const outside = e => actions.outside?.(e)
  const scan = () => {
    const current = new Set(doc.querySelectorAll('iframe'))
    for (const [frame, row] of frames) if (!current.has(frame)) { row.dispose(); frames.delete(frame) }
    for (const frame of current) if (!frames.has(frame)) {
      let inner
      const detach = () => { inner?.removeEventListener('keydown', keydown, true); inner?.removeEventListener('pointerdown', outside, true); inner?.removeEventListener('focusin', outside, true) }
      const load = () => {
        detach(); inner = null
        try { inner = frame.contentDocument; inner?.addEventListener('keydown', keydown, true); inner?.addEventListener('pointerdown', outside, true); inner?.addEventListener('focusin', outside, true) } catch { /* Cross-origin frames cannot be inspected. */ }
      }
      frames.set(frame, { dispose() { detach(); frame.removeEventListener('load', load) } })
      frame.addEventListener('load', load); load()
    }
  }
  doc.addEventListener('keydown', keydown, true); doc.addEventListener('pointerdown', outside, true); doc.addEventListener('focusin', outside, true)
  const observer = win.MutationObserver ? new win.MutationObserver(scan) : null
  observer?.observe(doc.documentElement, { childList: true, subtree: true }); scan()
  return () => {
    observer?.disconnect(); for (const row of frames.values()) row.dispose(); frames.clear()
    doc.removeEventListener('keydown', keydown, true); doc.removeEventListener('pointerdown', outside, true); doc.removeEventListener('focusin', outside, true)
  }
}

function createDprReadingLayout(doc, win, labels = {}) {
  let held = null, css = null, resizer = null, toggle = null, collapsed = false, createdResizer = false, width = 440, drag = null, disposed = false
  let lastOptions = {}, viewKey = null, storage
  const presentations = new Map(), presentationKey = 'dpr.reading.presentation.v1'
  try {
    storage = win.sessionStorage
    const raw = storage?.getItem(presentationKey)
    const saved = raw && raw.length <= 1048576 ? JSON.parse(raw) : null
    if (saved?.version === 1 && saved.views && typeof saved.views === 'object' && !Array.isArray(saved.views)) for (const [key, value] of Object.entries(saved.views).slice(-64)) {
      if (key.startsWith('paper:') && key.length <= 8192 && Number.isInteger(value?.width) && value.width >= 300 && value.width <= 800 && typeof value.collapsed === 'boolean') presentations.set(key, { width: value.width, collapsed: value.collapsed })
    }
  } catch { /* Opaque windows still retain state in this controller. */ }
  const savePresentation = () => {
    if (!viewKey?.startsWith('paper:')) return
    const prior = presentations.get(viewKey); if (prior?.width === width && prior.collapsed === collapsed) return
    presentations.delete(viewKey); presentations.set(viewKey, { width, collapsed }); if (presentations.size > 64) presentations.delete(presentations.keys().next().value)
    try { storage?.setItem(presentationKey, JSON.stringify({ version: 1, views: Object.fromEntries(presentations) })) } catch { /* UI preferences never block reading. */ }
  }
  const attributes = [], listeners = []
  const mark = (el, key, value = '') => {
    let entry = attributes.find(row => row.el === el && row.key === key)
    if (!entry) { entry = { el, key, old: el.getAttribute(key) }; attributes.push(entry) }
    entry.value = String(value); if (el.getAttribute(key) !== entry.value) el.setAttribute(key, entry.value)
  }
  const listen = (type, callback) => { resizer.addEventListener(type, callback, true); listeners.push([resizer, type, callback]) }
  const release = () => {
    savePresentation()
    if (drag !== null) { try { resizer?.releasePointerCapture?.(drag) } catch { /* Native capture may already have ended. */ } }
    for (const [el, type, callback] of listeners.splice(0)) el.removeEventListener(type, callback, true)
    for (const { el, key, old, value } of attributes.splice(0)) {
      if (el.getAttribute(key) !== value) continue
      if (old === null) el.removeAttribute(key); else el.setAttribute(key, old)
    }
    css?.remove(); toggle?.remove(); if (createdResizer) resizer?.remove()
    css = resizer = toggle = held = drag = null; createdResizer = false
  }
  const setWidth = value => { width = Math.max(300, Math.min(800, Math.round(value))); update(lastOptions) }
  function update(options) {
    lastOptions = options
    if (typeof options.viewKey === 'string' && options.viewKey !== viewKey) {
      savePresentation(); viewKey = options.viewKey
      const saved = presentations.get(viewKey); width = saved?.width ?? 440; collapsed = saved?.collapsed ?? viewKey.startsWith('paper:')
    }
    const anchor = dprReaderAnchor(doc, win, options.sessionId, options.tabId)
    const col = anchor?.closest('[data-rightbar-col]'), frame = col?.parentElement
    // Only direct semantic siblings form a supported frame; never guess by DOM order.
    const main = dprConversationColumn(frame)
    const panel = anchor?.hasAttribute('data-dpr-root') ? anchor : anchor?.closest('[data-sidebar-right-panel]')
    const native = dprWorkbenchOwner(doc, win)
    const owner = disposed || !options.enabled || win.innerWidth < 1200 || !frame || !main || !panel ||
      frame.hasAttribute('data-rightbar-fullscreen') || frame.hasAttribute('data-rightbar-collapsed') ? 'none' : native ? 'native' : 'reader'
    if (owner !== 'reader') { release(); return { owner, anchor, frame, panel } }
    if (held?.frame !== frame || held?.main !== main || held?.col !== col || held?.panel !== panel) {
      release(); held = { frame, main, col, panel }
      mark(frame, 'data-dpr-layout-frame'); mark(main, 'data-dpr-layout-chat')
      mark(col, 'data-dpr-layout-preview'); mark(panel, 'data-dpr-layout-panel')
      css = doc.createElement('style'); css.setAttribute('data-dpr-layout-style', ''); doc.head.appendChild(css)
      toggle = doc.createElement('button'); toggle.setAttribute('type', 'button'); toggle.setAttribute('data-dpr-chat-toggle', '')
      toggle.textContent = '◧'; toggle.addEventListener('click', () => { collapsed = !collapsed; update(lastOptions) })
      ;(frame.querySelector('[data-shell-overlay]') || frame).appendChild(toggle)
      resizer = frame.querySelector('[data-side="rightbar"]'); createdResizer = !resizer
      if (!resizer) { resizer = doc.createElement('div'); frame.appendChild(resizer) }
      mark(resizer, 'data-dpr-chat-resizer'); mark(resizer, 'role', 'separator'); mark(resizer, 'tabindex', '0')
      mark(resizer, 'aria-orientation', 'vertical'); mark(resizer, 'aria-label', labels.resize || '调整聊天侧栏宽度')
      listen('pointerdown', e => {
        if (e.button !== 0) return
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation?.(); drag = e.pointerId; resizer.setPointerCapture(e.pointerId)
      })
      listen('pointermove', e => {
        if (drag === e.pointerId) { e.stopPropagation(); e.stopImmediatePropagation?.(); setWidth(frame.getBoundingClientRect().right - e.clientX) }
      })
      const end = e => { if (drag === e.pointerId) { drag = null; resizer.releasePointerCapture?.(e.pointerId) } }
      listen('pointerup', end); listen('pointercancel', end)
      listen('lostpointercapture', () => { drag = null })
      listen('keydown', e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
        e.preventDefault(); e.stopPropagation()
        setWidth(e.key === 'Home' ? 300 : e.key === 'End' ? 800 : width + (e.key === 'ArrowLeft' ? 20 : -20))
      })
    }
    const rect = frame.getBoundingClientRect()
    // Native inline tracks remain the source of sidebar geometry even while our CSS wins.
    const sidebar = parseFloat(frame.style.gridTemplateColumns || win.getComputedStyle(frame).gridTemplateColumns) || 0
    const chatWidth = Math.min(width, Math.round(rect.width * .42))
    const controlsBottom = Number.isFinite(options.controlsBottom) ? options.controlsBottom : 88
    const toggleTop = Math.max(8, Math.round(anchor.getBoundingClientRect().top - rect.top + controlsBottom + 8))
    const title = collapsed ? (labels.show || '展开聊天侧栏') : (labels.hide || '收起聊天侧栏')
    toggle.setAttribute('title', title); toggle.setAttribute('aria-label', title); toggle.setAttribute('aria-expanded', String(!collapsed))
    mark(resizer, 'aria-valuemin', '300'); mark(resizer, 'aria-valuemax', '800'); mark(resizer, 'aria-valuenow', String(width))
    const f = '[data-dpr-layout-frame]', p = f + ' > [data-dpr-layout-preview]', m = f + ' > [data-dpr-layout-chat]'
    const rules = `@media(min-width:1200px){
      ${f}{grid-template-columns:${sidebar}px minmax(0,1fr) ${collapsed ? '0px' : chatWidth + 'px'}!important;}
      ${m}{grid-column:3;grid-row:1;min-width:0;${collapsed ? 'display:none!important;' : ''}}
      ${p}{grid-column:${collapsed ? '2 / 4' : '2'};grid-row:1;position:relative!important;min-width:0;inset:auto!important;overflow:hidden;}
      ${p} [data-dpr-layout-panel]{position:absolute!important;inset:0!important;width:100%!important;max-width:100%!important;min-width:100%!important;height:100%!important;transition:none!important;}
      ${p} [data-dpr-layout-panel] > div,${p} [data-dockkit-host="dock"]{padding:0!important;margin:0!important;border-radius:0!important;box-shadow:none!important;}
      ${p} [data-dockkit-pane]{border-radius:0!important;box-shadow:none!important;}
      ${m} [data-dpr-pad="1"]{margin-left:80px!important;}
      ${f} [data-dpr-chat-toggle]{position:absolute;right:${collapsed ? 8 : chatWidth + 8}px;top:${toggleTop}px;z-index:45;width:28px;height:28px;padding:0;border:1px solid var(--dsw-alias-border-l1,#ccd2d8);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#24292f);font-size:16px;cursor:pointer;pointer-events:auto;-webkit-app-region:no-drag;}
      ${f} [data-dpr-chat-toggle]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#1677ff);outline-offset:2px;}
      ${f} > [data-dpr-chat-resizer]{position:absolute!important;left:${Math.round(rect.width - chatWidth - 3)}px!important;top:0!important;bottom:0!important;width:6px;z-index:44;touch-action:none;cursor:col-resize;${collapsed ? 'display:none!important;' : ''}}
      [data-dpr-chat-resizer]:hover,[data-dpr-chat-resizer]:focus-visible{background:var(--dsw-alias-brand-primary,#1677ff);outline:none;}
    }`
    if (css.textContent !== rules) css.textContent = rules
    savePresentation()
    return { owner, anchor, frame, panel }
  }
  return { update, toggleChat() { if (update(lastOptions).owner !== 'reader') return false; collapsed = !collapsed; update(lastOptions); return true }, dispose() { disposed = true; release() } }
}

window.__ModuleLoader__.load({
  // 必须等于 npm 包名：浏览器端 loader 按包名期待注册（改名时漏改这里 →
  // "loaded without registering" 整页插件加载失败，实测）
  id: '@fxz729/dsh-paper-workbench',
  factory: (require) => {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { useState, useEffect, useCallback } = React
    const h = React.createElement

    const NS = 'dsh-paper-reader'
    const zh = {
      library: '文献库', menuRefresh: '刷新', sessionLoading: '正在加载…',
      collectionNote: '库备注', paperDetails: '文献摘要', newChild: '新建子库', closeDetails: '关闭',
      renamePreview: '改名预览', renameApply: '确认改名', deletePlanMismatch: '删除预览与当前目标不匹配，请重新预览', deleteCommitUnknown: '删除结果待核实，请刷新文献库后重新预览',
      empty: '文献库为空', hint: '新建专题或上传 PDF 开始', newTopic: '新建专题',
      cancel: '取消', ok: '确定', defaultTopic: '默认专题', uploadBtn: '上传 PDF',
      uploadSummary: '上传完成：成功 {ok} 个，失败 {failed} 个', uploadFailedItem: '{name}：{reason}',
      newTopicFail: '新建专题失败',
      importFolder: '导入文件夹', importPreview: '文件夹导入预览', importTarget: '目标专题', importStart: '开始导入',
      importHint: '子目录 PDF 汇入同一专题；排除 -en/-zh/-dual 产物。仅复制上传，原目录不移动、不删除。',
      importCount: '{n} 个 PDF · 同名跳过 {conflicts} 个', importConflict: '同名，跳过', importReady: '待导入',
      importSummary: '导入完成：成功 {ok} 个，跳过 {skipped} 个，失败 {failed} 个', importBusy: '导入中…',
      importInvalid: '请输入有效的专题名（不能含路径或 ..）', importFail: '文件夹导入失败',
      importRestart: '当前后台尚未支持安全目录导入。请完全退出并重新打开 DSH 后再试；本次未上传任何文件。',
      revealFile: '定位文件', openFolder: '打开文件夹', copyPath: '复制路径', pathCopied: '路径已复制', copyPathHint: '无法自动复制，文本已选中，请按 Ctrl+C（Mac：⌘C）复制。',
      openOriginal: '打开原文', openTranslation: '打开译文', enqueuePaper: '加入翻译队列', enqueueTopic: '专题批量翻译', queueRequested: '已提交翻译队列请求', libraryActionFail: '文献库操作失败',
      rename: '重命名', renameTopic: '重命名专题', renamePaper: '重命名论文',
      renameFail: '重命名失败', delFail: '删除失败',
      upload: '上传 PDF 到此专题', newChat: '新建对话', session: '会话', pdfTab: '论文 PDF',
      history: '历史对话',
      sync: '对话还停在另一篇文献的会话里，点击切到当前文献',
      showChat: '展开聊天侧栏', hideChat: '收起聊天侧栏', resizeChat: '调整聊天侧栏宽度',
      inkNavigationFail: '墨迹保存失败，已保留当前文献，请重试',
      mode: '论文伴读', modeEnterTip: '进入论文伴读：左侧变为文献库树', modeExitTip: '退出论文伴读：恢复官方工作区列表', returnWorkspace: '返回工作区',
      settings: '论文伴读',
      setRerankTitle: '检索重排（Jev）',
      setRerankDesc: 'search_paper 检索的语义重排：关键词先捞候选，Jev 逐个判断「这段能否回答这个问题」再排序——大白话提问也能命中论文里的术语段落。不配则退回纯关键词排序。',
      setEmbedTitle: '嵌入模型检索（可选）',
      setEmbedDesc: 'search_paper 的语义召回：分块文本会发送到该 OpenAI 兼容 /embeddings 端点，用向量把「关键词一个字都没命中」的语义相近片段也捞进候选（与关键词结果融合，不替代）。留空即关闭，检索行为与现在完全一致。注意：分块文本（论文正文）会发往该端点。',
      setTranslateTitle: '翻译端点',
      setTranslateDesc: '「生成中文版」（babeldoc）用的 OpenAI 兼容端点，三项必填。保存前会先测连接。',
      setBaseUrl: '端点 URL', setModel: '模型', setKey: 'API Key',
      setSave: '测试并保存', setSaving: '测试连接中…', setClear: '清除自填配置',
      setSaved: '已保存，立即生效', setCleared: '已清除，回落到部署方默认',
      setKeyKeep: '留空沿用已保存的 ', setOptional: '可选',
      setEmbedBatchSize: '批大小（每次请求的分块数，端点限制更小时调低，如百炼部分模型 10/20）',
      setSourceFile: '当前来源：设置页', setSourceProfile: '当前来源：配置文件（部署方默认）',
      setSourceEnv: '当前来源：环境变量', setSourceNone: '未配置',
      setMineruTitle: 'MinerU 解析后端',
      setMineruDesc: 'PDF 转录的 MinerU 后端：本地 MinerU API（127.0.0.1:8000，扫描件/OCR 友好）或 mineru.net v4 云端。默认关闭（走本地 pdf.js）。保存前会先测试连接。',
      setMineruMode: '模式', setMineruModeOff: '关闭', setMineruModeLocal: '本地', setMineruModeCloud: '云端',
      setMineruLocalUrl: '本地服务地址', setMineruLocalKey: '本地 API Key', setMineruBackend: '本地解析后端',
      setMineruEffort: 'hybrid effort', setMineruParseMethod: '本地解析方式', setMineruCloudKey: '云端 token',
      setMineruTestConnection: '测试连接', setMineruHealthOk: '连接正常', setMineruHealthFail: '连接失败',
      // 激活门槛人话（上游评审第 7 条）：普通用户不知道 MinerU 是什么。① 什么时候需要它
      // （扫描版读不了 / 公式点不了）；② 配置后入口出现在哪（阅读器公式面板的「用 MinerU 重新转录」）。
      setMineruWhy: '扫描版论文读不了？公式点不了？——在这里配置后就能解析：本地 MinerU 或 mineru.net 云端 token，二选一；保存后阅读器公式面板里会出现「用 MinerU 重新转录」。',
      setMineruWhyLocal: '本地模式需要你自己跑一个 MinerU 服务（127.0.0.1:8000），适合有显卡、论文不外传的场景。',
      setMineruWhyCloud: '云端模式只要一个 mineru.net token，无需本地显卡；论文会上传到 mineru.net 解析。',
      setMineruOffHint: '当前为「关闭」：转录走本地 pdf.js——有文本层的普通 PDF 完全够用；扫描版（没有文本层）与公式引用才需要 MinerU（选本地或云端）。',
      // 分屏「同步滚动」（模式 B 的全局偏好）：与阅读器分屏控件旁的那个开关是**同一个值**
      // （键 dpr.syncScroll，见文件顶层的纯函数），任一处改动另一处立即跟着变。
      setSyncScrollTitle: '分屏同步滚动',
      setSyncScrollDesc: '阅读器里「分屏」对照（模式 B：原文 PDF ↔ 中文版 PDF 两列）时，两列是否一起滚动。关闭后两列各自独立滚动（适合对照着看不同页）；重新打开会自动把两列对齐回当前页，不会停在两页上。全局偏好：所有论文共用一个值，不按篇记；默认开。模式 A（babeldoc 的中英对照 PDF）只有一个滚动条，不受此项影响。',
      setSyncScrollLabel: '分屏两列同步滚动',
      setSyncScrollOnHint: '当前：开 —— 两列一起滚动（默认）',
      setSyncScrollOffHint: '当前：关 —— 两列各自独立滚动；再打开时会自动对齐回当前页',
      // 文献管理（删除/重命名）：契约见 docs/reader-ux-requirements.md §2.9。
      // 去重说明：rename/renameTopic/renamePaper/renameFail/delFail 只保留上面上游那组
      // （JS 对象字面量重复 key 不报错、后者静默胜出 → 必须手工去重，否则文案悄悄取自另一份）。
      newName: '新名称', renameDone: '已重命名',
      renameDetached: '注意：{n} 个历史会话不会删除，但不再显示在列表里',
      renameTargetExists: '已存在同名文献或专题',
      delPaper: '删除文献', delTopic: '删除专题',
      delConfirmTitle: '确认删除', delToTrash: '移入回收站',
      delConfirmBody: '将移入回收站（可恢复）：共 {files} 个文件、{size}',
      delNotDeleted: '不会删除：伴读会话历史、共享翻译环境',
      delTopicTypeName: '请输入专题名「{name}」以确认',
      delDone: '已移入回收站（{files} 个文件）',
      delBusySession: '该文献有正在运行的会话，请先结束后再操作',
      delBusyTranslate: '正在生成译文，请等待完成后再操作',
      delTopicNotEmpty: '专题内还有 {n} 篇文献，需批量清空或先逐篇删除',
      delTopicClearTitle: '清空「{topic}」并删除',
      delTopicClearBody: '共 {papers} 篇文献、{files} 个文件（{size}）：确认后逐篇移入回收站（可恢复），然后删除专题目录。有运行中会话或正在翻译的文献会被服务端先拦下。',
      delTopicClearConfirm: '清空并删除',
      delTopicClearFiles: '{n} 个文件',
      delTopicClearBlocked: '注意：以下文献正在翻译或有运行中会话，会被服务端拦下（先处理再清空）：{names}',
      delTopicClearPlanFail: '无法获取清空清单',
      delTopicClearHidden: '隐藏条目 {names} 也会进回收站（不销毁）',
      clearDone: '已清空「{topic}」：{papers} 篇 / {files} 个文件 → 已移入回收站',
      delBusyFile: '文件被占用（可能正在阅读器或其他程序中打开），关闭后重试',
      // F-B/F-C：回滚失败必须把「哪些文件、在哪个回收站、怎么恢复」说清楚；未回滚时不得声称「库未改变」
      clearPartialFailText: '操作未完成：{n} 个文件未能回滚，仍在回收站里（文献树里可能已看不到）：{names}',
      clearRecoveryHint: '恢复方法：把 {where}/ 里列出的这些文件移回原专题目录即可',
      delPlanFail: '无法获取删除清单',
      delBusy: '同一篇文献的另一个删除/重命名操作正在进行，请稍后重试',
      delSessionUnknown: '暂时无法确认该文献的伴读会话状态，为避免误删已取消本次操作；请稍后重试',
      eqTitle: '公式', eqPanelEmpty: '本论文未解析出公式',
      eqNeedMineru: '需要 MinerU 解析产物才能点击引用公式',
      eqTranscribe: '用 MinerU 重新转录', eqBadArtifact: 'MinerU 产物损坏，已忽略',
      eqCopy: '复制 LaTeX', eqCopied: '已复制公式 LaTeX',
      eqChip: '第 {page} 页 · 公式 {k}',
      eqTranslatedView: '译文视图没有公式位置信息，切回原文可点击',
      eqNoPosition: '无位置信息',
    }
    const en = {
      library: 'Library', menuRefresh: 'Refresh', sessionLoading: 'Loading…',
      collectionNote: 'Collection note', paperDetails: 'Paper summary', newChild: 'New subcollection', closeDetails: 'Close',
      renamePreview: 'Rename preview', renameApply: 'Confirm rename', deletePlanMismatch: 'Deletion preview does not match the selected target; please preview again', deleteCommitUnknown: 'Deletion outcome needs verification; refresh the library before previewing again',
      empty: 'Library is empty', hint: 'Create a topic or upload a PDF to start', newTopic: 'New topic',
      cancel: 'Cancel', ok: 'OK', defaultTopic: 'Default', uploadBtn: 'Upload PDF',
      uploadSummary: 'Upload complete: {ok} succeeded, {failed} failed', uploadFailedItem: '{name}: {reason}',
      newTopicFail: 'Failed to create topic',
      importFolder: 'Import folder', importPreview: 'Folder import preview', importTarget: 'Target topic', importStart: 'Start import',
      importHint: 'Nested PDFs go into one topic; -en/-zh/-dual outputs are excluded. Copies only: original files are never moved or deleted.',
      importCount: '{n} PDFs · {conflicts} name conflicts skipped', importConflict: 'Name conflict, skip', importReady: 'Ready',
      importSummary: 'Import complete: {ok} succeeded, {skipped} skipped, {failed} failed', importBusy: 'Importing…',
      importInvalid: 'Enter a valid topic name (no paths or ..)', importFail: 'Folder import failed',
      importRestart: 'The backend does not yet support safe folder import. Fully quit and reopen DSH, then try again. No files were uploaded.',
      revealFile: 'Reveal file', openFolder: 'Open folder', copyPath: 'Copy path', pathCopied: 'Path copied', copyPathHint: 'Automatic copy was denied. Text is selected: press Ctrl+C (Mac: ⌘C) to copy.',
      openOriginal: 'Open original', openTranslation: 'Open translation', enqueuePaper: 'Add to translation queue', enqueueTopic: 'Translate topic', queueRequested: 'Translation queue request submitted', libraryActionFail: 'Library action failed',
      rename: 'Rename', renameTopic: 'Rename topic', renamePaper: 'Rename paper',
      renameFail: 'Rename failed', delFail: 'Delete failed',
      upload: 'Upload PDF into this topic', newChat: 'New chat', session: 'Session', pdfTab: 'Paper PDF',
      history: 'Chat history',
      sync: 'Chat is still on another paper — click to switch to the current one',
      showChat: 'Show chat sidebar', hideChat: 'Collapse chat sidebar', resizeChat: 'Resize chat sidebar',
      inkNavigationFail: 'Ink save failed; current paper retained. Please retry',
      mode: 'Paper Reading', modeEnterTip: 'Enter paper-reading mode: sidebar becomes the library tree', modeExitTip: 'Exit paper-reading mode: restore the official workspace list', returnWorkspace: 'Back to workspaces',
      settings: 'Paper Reader',
      setRerankTitle: 'Search rerank (Jev)',
      setRerankDesc: 'Semantic rerank for search_paper: keyword search shortlists candidates, Jev judges "can this passage answer the question" and reorders — plain-language questions hit terminology passages. Without it, plain keyword ranking is used.',
      setEmbedTitle: 'Embedding search (optional)',
      setEmbedDesc: 'Semantic recall for search_paper: chunk texts are sent to this OpenAI-compatible /embeddings endpoint so passages that share no keywords but are semantically close still enter the candidate set (fused with keyword hits, never replacing them). Leave empty to keep it off — search behaviour stays exactly as today. Note: chunk texts (paper body) are sent to this endpoint.',
      setTranslateTitle: 'Translate endpoint',
      setTranslateDesc: 'OpenAI-compatible endpoint for "Generate Chinese version" (babeldoc). All three fields required. Connection is tested before saving.',
      setBaseUrl: 'Endpoint URL', setModel: 'Model', setKey: 'API Key',
      setSave: 'Test & save', setSaving: 'Testing…', setClear: 'Clear my config',
      setSaved: 'Saved, effective immediately', setCleared: 'Cleared, falling back to deployment defaults',
      setKeyKeep: 'Leave empty to keep saved ', setOptional: 'optional',
      setEmbedBatchSize: 'Batch size (chunks per request; lower it when the endpoint caps inputs, e.g. 10/20 on some Bailian models)',
      setSourceFile: 'Source: settings page', setSourceProfile: 'Source: config file (deployment default)',
      setSourceEnv: 'Source: environment variable', setSourceNone: 'Not configured',
      setMineruTitle: 'MinerU parser',
      setMineruDesc: 'MinerU backend for PDF transcription: local MinerU API (127.0.0.1:8000, scan/OCR friendly) or mineru.net v4 cloud. Off by default (local pdf.js). Connection is tested before saving.',
      setMineruMode: 'Mode', setMineruModeOff: 'Off', setMineruModeLocal: 'Local', setMineruModeCloud: 'Cloud',
      setMineruLocalUrl: 'Local service URL', setMineruLocalKey: 'Local API key', setMineruBackend: 'Local backend',
      setMineruEffort: 'hybrid effort', setMineruParseMethod: 'Parse method', setMineruCloudKey: 'Cloud token',
      setMineruTestConnection: 'Test connection', setMineruHealthOk: 'Connection OK', setMineruHealthFail: 'Connection failed',
      setMineruWhy: 'Scanned PDFs unreadable? Formulas not clickable? Configure a parser here: either a local MinerU API or a mineru.net cloud token. Once saved, the reader adds a "Re-parse with MinerU" button in the formula panel.',
      setMineruWhyLocal: 'Local mode expects your own MinerU service (127.0.0.1:8000) — for GPUs and papers that should stay on your machine.',
      setMineruWhyCloud: 'Cloud mode needs only a mineru.net token and no local GPU; the paper is uploaded to mineru.net for parsing.',
      setMineruOffHint: 'Currently Off: transcription uses local pdf.js — fine for PDFs that already have a text layer; scanned PDFs (no text layer) and formula citing need MinerU (local or cloud).',
      setSyncScrollTitle: 'Split-view sync scrolling',
      setSyncScrollDesc: 'In the reader split view (mode B: the original PDF next to the translated -zh.pdf) — should the two columns scroll together? Off: each column scrolls independently (handy to compare different pages); turning it back on realigns both columns to the current page instead of leaving them on different pages. Global preference: one value for every paper, never per paper; on by default. Mode A (babeldoc dual PDF) has a single scrollbar and is unaffected.',
      setSyncScrollLabel: 'Scroll the two split columns together',
      setSyncScrollOnHint: 'Currently: on — the two columns scroll together (default)',
      setSyncScrollOffHint: 'Currently: off — the two columns scroll independently; turning it on realigns them to the current page',
      newName: 'New name', renameDone: 'Renamed',
      renameDetached: 'Note: {n} past chats are kept but no longer listed',
      renameTargetExists: 'A paper or topic with that name already exists',
      delPaper: 'Delete paper', delTopic: 'Delete topic',
      delConfirmTitle: 'Confirm deletion', delToTrash: 'Move to trash',
      delConfirmBody: 'Will be moved to trash (recoverable): {files} files, {size}',
      delNotDeleted: 'Not deleted: chat history, shared translation venv',
      delTopicTypeName: 'Type the topic name "{name}" to confirm',
      delDone: 'Moved to trash ({files} files)',
      delBusySession: 'A session is still running — end it first',
      delBusyTranslate: 'Translation in progress — try again later',
      delTopicNotEmpty: 'Topic still has {n} papers — use bulk clear, or delete them one by one',
      delTopicClearTitle: 'Clear \u201c{topic}\u201d and delete',
      delTopicClearBody: '{papers} papers, {files} files ({size}): after confirmation each paper is moved to the trash (recoverable), then the topic folder is removed. Papers with a running chat or an in-progress translation are blocked first.',
      delTopicClearConfirm: 'Clear & delete',
      delTopicClearFiles: '{n} files',
      delTopicClearBlocked: 'Heads up: these papers are translating or have running chats and will be blocked by the server — handle them first: {names}',
      delTopicClearPlanFail: 'Could not fetch the clear plan',
      delTopicClearHidden: 'Hidden entries {names} are moved to the trash too (never destroyed)',
      clearDone: 'Cleared \u201c{topic}\u201d: {papers} papers / {files} files \u2192 moved to trash',
      delBusyFile: 'File is in use (open in the reader or another program) — close it and retry',
      clearPartialFailText: 'The operation did not finish: {n} file(s) could not be rolled back and are still in the trash (the paper may look gone in the tree): {names}',
      clearRecoveryHint: 'To recover: move those files from {where}/ back into the original topic folder',
      delPlanFail: 'Could not fetch the deletion manifest',
      delBusy: 'Another delete/rename on this paper is in progress — try again later',
      delSessionUnknown: 'Could not confirm chat status — cancelled to avoid accidental deletion; try again later',
      eqTitle: 'Formulas', eqPanelEmpty: 'No formulas parsed for this paper',
      eqNeedMineru: 'MinerU output required to click-cite formulas',
      eqTranscribe: 'Re-parse with MinerU', eqBadArtifact: 'MinerU output is corrupt — ignored',
      eqCopy: 'Copy LaTeX', eqCopied: 'Formula LaTeX copied',
      eqChip: 'p.{page} · formula {k}',
      eqTranslatedView: 'No positions in the translated view — switch back to the original',
      eqNoPosition: 'No position info',
    }

    let t = (k) => k
    const setT = (fn) => { t = fn }

    /* ---------- 共享状态桥（树 / PDF 页签 / 阅读器 iframe 三方同步） ---------- */
    const sessionKey = (topic, name) => `dpr.sessionN.${topic}/${name}`
    function setCurrentPaper(topic, name, n, ref = {}) {
      jumpRequest++
      const paper = { topic, name, n, paperId: ref.paperId, collectionId: ref.collectionId, locationRevision: ref.locationRevision }
      localStorage.setItem('dpr.last', JSON.stringify(paper))
      localStorage.setItem(sessionKey(topic, name), String(n))
      window.dispatchEvent(new CustomEvent('dpr:paper', { detail: paper }))
    }

    /* ---------- 会话消息里的阅读器跳转链接 ----------
       agent 引用页码时给 [文字](http://<host>/paper-reader/?topic=..&name=..&page=N)
       （dsh 渲染器对 http(s) 链接加 target=_blank，capture 拦截是应用内跳转的唯一窗口）。
       同论文 → 阅读器 iframe 原地跳页：不重载文档，用户正在看中文版就落在中文版该页；
       跨论文/iframe 未就绪 → setCurrentPaper 换论文，页码经 pendingJumpPage 挂上 src，
       阅读器 bootstrap 直达目标页。 */
    let readerIframeEl = null
    const readerSaves = createDprReaderSaveLease(() => readerIframeEl)
    const withSavedReader = readerSaves.run
    const committedDeleteNotices = new WeakSet()
    let jumpRequest = 0
    let pendingJump = null // { page, q }：跨论文/iframe 未就绪时挂上 src，由阅读器 bootstrap 消费
    async function jumpToPaperPage(topic, name, page, q, paperId) {
      const request = ++jumpRequest
      // 阅读器页签若关着尽量展开（seat 未绑定时静默失败，跳转本身仍生效）
      try { clientApi?.sidebarRight?.openTab('dpr-reader', { revealIfOpened: true }) } catch {}
      const cur = JSON.parse(localStorage.getItem('dpr.last') || 'null')
      let tp = topic || cur?.topic, nm = name || cur?.name, ref
      if (!paperId && (!tp || !nm)) return
      try {
        ref = await api('/paper?' + new URLSearchParams(paperId ? { paperId } : { topic: tp, name: nm }))
        if (request !== jumpRequest) return
        tp = ref.topic || ref.segments?.join('/') || tp; nm = ref.name || nm
      } catch (err) { if (request === jumpRequest) toast(t('libraryActionFail') + ': ' + err.message); return }
      const win = readerIframeEl?.contentWindow
      if (cur && dprSamePaper(cur, { ...ref, topic: tp, name: nm }) && win?.dpr?.jumpPage) {
        win.dpr.jumpPage(page, q || undefined)
        return
      }
      pendingJump = { page, q }
      setCurrentPaper(tp, nm, dprSamePaper(cur, { ...ref, topic: tp, name: nm }) ? cur?.n : 0, ref)
    }

    async function api(path, opts) {
      const r = await fetch('/paper-reader/api' + path, opts)
      if (!r.ok) {
        const body = await r.json().catch(() => ({}))
        const err = new Error(body.error || body.reason || ('HTTP ' + r.status))
        // 机器可读码挂到 Error 上：调用方按 code 分支（别去匹配中文文案）
        err.code = body.code
        err.status = r.status
        if (body.papers) err.papers = body.papers
        if (body.entries) err.entries = body.entries
        for (const key of ['rollbackFailed', 'trashRel', 'clearEndpoint']) if (body[key] !== undefined) err[key] = body[key]
        throw err
      }
      return r.json()
    }

    /* ---------- 改名搬家：论文粒度的本地记忆键跟随新身份 ----------
       dpr.variant.<topic>/<name>（语言版本记忆）、dpr.sessionN.<topic>/<name>（会话序号）、
       dpr.last（上次打开）。论文改名精确搬单键；专题改名把该专题前缀的键整体搬。 */
    function migrateLsKeys(oldTopic, newTopic, oldName, newName) {
      try {
        if (oldName != null) {
          for (const base of ['dpr.variant.', 'dpr.sessionN.']) {
            const from = base + oldTopic + '/' + oldName
            const to = base + newTopic + '/' + newName
            const v = localStorage.getItem(from)
            if (v != null) { localStorage.setItem(to, v); localStorage.removeItem(from) }
          }
        } else {
          for (const base of ['dpr.variant.', 'dpr.sessionN.']) {
            const pre = base + oldTopic + '/'
            for (let i = localStorage.length - 1; i >= 0; i--) {
              const k = localStorage.key(i)
              if (k && k.startsWith(pre)) {
                localStorage.setItem(base + newTopic + '/' + k.slice(pre.length), localStorage.getItem(k))
                localStorage.removeItem(k)
              }
            }
          }
        }
        const last = JSON.parse(localStorage.getItem('dpr.last') || 'null')
        if (last && last.topic === oldTopic && (oldName == null || last.name === oldName)) {
          localStorage.setItem('dpr.last', JSON.stringify({ ...last, topic: newTopic, ...(oldName != null ? { name: newName } : {}) }))
        }
      } catch { /* 隐私模式等写不了就算了 */ }
    }

    /* 当前在屏（主视图）会话 id：0.1.x 是会话列表快照的 .current 字段；
       0.2.0 起快照没有该字段，官方以 retainedBy.mainView>0 标记主视图保留的会话
       （dsh-client-ui-workspace 自己的 current() 就是这么读的）—— 两代都取到。 */
    function currentSessionOf(snap) {
      if (!snap) return null
      if (snap.current !== undefined) return snap.current
      try {
        return Object.values(snap.byId ?? {}).find((row) => (row.retainedBy?.mainView ?? 0) > 0)?.id ?? null
      } catch { return null }
    }

    /* ---------- 轻提示（DOM 直挂，不进 React 树） ----------
       window.alert 桌面端（Electron）虽可用但阻塞且各壳表现不一，一律换掉。 */
    function toast(msg) {
      const el = document.createElement('div')
      el.setAttribute('data-dpr-toast', '')
      el.textContent = msg
      Object.assign(el.style, {
        position: 'fixed', left: '50%', bottom: '30px', transform: 'translateX(-50%)',
        zIndex: 80, maxWidth: '76vw', padding: '8px 14px', borderRadius: '8px',
        fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap', textAlign: 'center',
        background: 'var(--dsw-alias-bg-inverse, #24292f)', color: 'var(--dsw-alias-label-inverse, #f6f8fa)',
        boxShadow: '0 4px 16px rgba(0,0,0,.25)',
      })
      document.body.appendChild(el)
      setTimeout(() => el.remove(), 4000)
    }

    /* 会话切换只为 iframe 几何提供短暂提示；布局服务与原生汇报始终保持原样。 */
    const SWITCH_GUARD_MS = 1500
    let switching = false
    let switchTimer = 0
    let readingLayout = null
    function beginSwitchGuard() {
      switching = true
      clearTimeout(switchTimer)
      switchTimer = setTimeout(() => { switching = false }, SWITCH_GUARD_MS)
    }

    /* ---------- 阅读器悬浮层：一个跨会话永不重建的 iframe ----------
       rightbar 页签内容跟随会话 seat 重绑整体重建（TabSlot 以 tab.id 为 key，
       新会话的 rightbar 布局里没有旧 tab）——iframe 每次重载，滚动/缩放全丢
       （"新建对话整页都动"）。改为：PdfTab 只渲染占位锚点；真正的 iframe 由
       ReaderOverlay 常驻渲染（挂在 LibraryTree 下，不随会话变），fixed 覆盖在锚点矩形上，
       200ms 轮询跟随；锚点消失（关页签/收右栏/全屏）时隐藏但 iframe 存活。 */
    function ReaderOverlay() {
      const [cur, setCur] = useState(() => JSON.parse(localStorage.getItem('dpr.last') || 'null'))
      const [geo, setGeo] = useState({ visible: false, left: 0, top: 0, width: 0, height: 0 })
      const lastShownRef = React.useRef(0)
      const frameSource = React.useRef(dprReaderSource(cur))
      const displayedPaper = React.useRef(cur)
      useEffect(() => {
        let current = JSON.parse(localStorage.getItem('dpr.last') || 'null')
        const navigation = createDprReaderNavigation({
          beforeNavigate: () => readerSaves.beforeNavigate(),
          needsNavigation: next => dprReaderNeedsNavigation(current, next),
          resume: () => readerIframeEl?.contentWindow?.DprInk?.didNavigate?.(),
          commit: next => {
            const reload = dprReaderNeedsNavigation(current, next)
            if (reload) frameSource.current = dprReaderSource(next)
            else dprSyncReaderIdentity(readerIframeEl, next, window.location?.origin)
            current = next
            displayedPaper.current = next
            try {
              if (next) localStorage.setItem('dpr.last', JSON.stringify(next))
              else localStorage.removeItem('dpr.last')
            } catch { /* 隐私模式 */ }
            setCur(next)
            window.dispatchEvent(new CustomEvent('dpr:paper-displayed', { detail: { paper: next } }))
          },
          onError: error => {
            // setCurrentPaper has already published its preference; roll back only that key.
            try {
              if (current) localStorage.setItem('dpr.last', JSON.stringify(current))
              else localStorage.removeItem('dpr.last')
            } catch { /* 隐私模式 */ }
            window.dispatchEvent(new CustomEvent('dpr:paper-displayed', { detail: { paper: current, failed: true } }))
            toast(t('inkNavigationFail') + '：' + String(error?.message || error))
          },
        })
        const on = e => {
          const j = pendingJump
          pendingJump = null
          const detail = e.detail
          void navigation.navigate(detail.empty ? null : { topic: detail.topic, name: detail.name, n: detail.n, paperId: detail.paperId, collectionId: detail.collectionId, locationRevision: detail.locationRevision,
            page: detail.identityOnly ? current?.page : j?.page, q: detail.identityOnly ? current?.q : j?.q })
        }
        const canonical = e => {
          const data = e.data, ref = data?.ref
          if (e.origin !== window.location.origin || e.source !== readerIframeEl?.contentWindow || data?.type !== 'dpr:reader-canonical' || !ref?.paperId || ref.paperId !== data.paperId || !dprSamePaper(current, ref)) return
          if (typeof ref.topic !== 'string' || typeof ref.name !== 'string') return
          if (current.paperId === ref.paperId && current.topic === ref.topic && current.name === ref.name && current.locationRevision === ref.locationRevision) return
          void navigation.navigate({ ...current, paperId: ref.paperId, collectionId: ref.collectionId, topic: ref.topic, name: ref.name, locationRevision: ref.locationRevision })
          window.dispatchEvent(new Event('dpr:library-updated'))
        }
        const deleted = e => {
          const notice = e.detail
          if (!notice || !committedDeleteNotices.has(notice)) return
          committedDeleteNotices.delete(notice)
          const isDeleted = () => !!current?.paperId && notice.paperIds.includes(current.paperId) && dprDeleteAffects(current, notice.target)
          void navigation.afterDelete(notice.next, isDeleted)
        }
        window.addEventListener('dpr:paper', on)
        window.addEventListener('dpr:delete-committed', deleted)
        window.addEventListener('message', canonical)
        return () => { navigation.dispose(); window.removeEventListener('dpr:paper', on); window.removeEventListener('dpr:delete-committed', deleted); window.removeEventListener('message', canonical) }
      }, [])
      useEffect(() => {
        let alive = true
        const layout = createDprReadingLayout(document, window, {
          show: t('showChat'), hide: t('hideChat'), resize: t('resizeChat'),
        })
        readingLayout = layout
        const readingContext = createDprReadingContext(clientApi || {}, () => displayedPaper.current, id => !!parseDprSession(id))
        const tick = () => {
          if (!alive) return
          const reading = readingContext.update(), { sessionId } = reading
          clientApi?.readerSeat?.update({ enabled: reading.enabled })
          const result = layout.update({ ...reading, controlsBottom: dprReaderControlsBottom(readerIframeEl) })
          // The iframe survives all ownership and tab changes; only visible anchors position it.
          const anchor = result.anchor
          const frozen = result.owner === 'reader' && !!anchor && switching && lastShownRef.current && Date.now() - lastShownRef.current < 5000
          if (!frozen) {
            let next = null
            if (anchor) {
              const r = anchor.getBoundingClientRect()
              if (r.width > 50 && r.height > 50) next = { visible: true, left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
            }
            setGeo(prev => {
              if (next) {
                lastShownRef.current = Date.now()
                return prev.visible && prev.left === next.left && prev.top === next.top && prev.width === next.width && prev.height === next.height ? prev : next
              }
              return prev.visible ? { ...prev, visible: false } : prev
            })
          }
          // Fullscreen stacking belongs only to our iframe; native frame/panel styles stay untouched.
          if (readerIframeEl) {
            const layer = result.panel ? parseFloat(getComputedStyle(result.panel).getPropertyValue('--dsh-dockkit-dock-layer')) || 10 : 10
            const z = result.frame?.hasAttribute('data-rightbar-fullscreen') ? String(layer + 2) : '10'
            if (readerIframeEl.style.zIndex !== z) readerIframeEl.style.zIndex = z
          }
        }
        const stopContext = readingContext.subscribe(tick)
        tick()
        const timer = setInterval(tick, 200)
        window.addEventListener('resize', tick)
        window.addEventListener('dpr:layout', tick)
        document.addEventListener('fullscreenchange', tick)
        const observer = new MutationObserver(tick)
        observer.observe(document.body, { subtree: true, childList: true, attributes: true,
          attributeFilter: ['data-nwl-active', 'data-dsh-workbench-frame', 'data-dsh-workbench-editor-collapsed', 'data-rightbar-fullscreen', 'data-rightbar-collapsed', 'data-sidebar-collapsed', 'data-dpr-visible', 'hidden', 'style', 'class'] })
        return () => {
          alive = false; stopContext(); clearInterval(timer); observer.disconnect(); layout.dispose()
          window.removeEventListener('resize', tick); window.removeEventListener('dpr:layout', tick)
          document.removeEventListener('fullscreenchange', tick)
          if (readingLayout === layout) readingLayout = null
        }
      }, [])
      if (!cur) return null
      const src = frameSource.current
      return createPortal(
        h('iframe', {
          ref: (el) => { readerIframeEl = el },
          onLoad: () => dprSyncReaderIdentity(readerIframeEl, displayedPaper.current, window.location.origin),
          src, title: t('pdfTab'),
          'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'reader-overlay',
          style: {
            position: 'fixed', left: geo.left + 'px', top: geo.top + 'px',
            width: geo.width + 'px', height: geo.height + 'px', border: 'none',
            // 不用 display:none（布局归零会把 iframe 内滚动位置清零）；visibility 保留布局
            visibility: geo.visible ? 'visible' : 'hidden',
            pointerEvents: geo.visible ? 'auto' : 'none',
            // z-index 低于 overlayLayer(20) 与按钮组(45)：不挡拖拽手柄和弹层
            zIndex: 10, background: 'var(--dsw-alias-bg-layer-1, #f6f7f9)',
          },
        }),
        document.body,
      )
    }

    /* ---------- rightbar PDF 页签（只剩占位锚点 + 布局换位） ---------- */
    // Independent native rightbar pages. No companion session creation or global reader events.
    function DockLibraryTab(props) {
      const open = useCallback(paper => clientApi.dockReading.openPaper(paper, props.sessionId), [props.sessionId])
      return h(LibraryTree, { ...clientApi, wide: true, dockOpen: open })
    }

    function DockReaderTab(props) {
      const info = props.useTabInfo(), params = info.tab.navigation.params || {}, workspaceSessionId = props.sessionId
      const frameRef = React.useRef(null), anchorRef = React.useRef(null), initial = React.useRef(null), [error, setError] = useState(''), [canonical, setCanonical] = useState(null)
      if (!initial.current) {
        try {
          if (params.workspaceSessionId !== workspaceSessionId) throw new Error('工作区会话不匹配，请从库列表重新打开')
          initial.current = { ref: { paperId: params.paperId, collectionId: params.collectionId, name: params.name, topic: params.topic, variant: params.variant }, src: dprDockReaderSource(params, workspaceSessionId) }
        } catch (cause) { initial.current = { error: cause.message } }
      }
      useEffect(() => {
        if (initial.current.error) return
        const detach = clientApi.dockReading.mountPage(workspaceSessionId, info.tab.id, initial.current.ref, initial.current.src, () => anchorRef.current)
        frameRef.current = clientApi.dockReading.frame(workspaceSessionId, info.tab.id)
        return () => { detach(); frameRef.current = null }
      }, [workspaceSessionId, info.tab.id])
      useEffect(() => { void clientApi.dockReading.visible(workspaceSessionId, info.tab.id, info.tab.visible) }, [workspaceSessionId, info.tab.id, info.tab.visible])
      useEffect(() => {
        const message = event => {
          const data = event.data, ref = data?.ref
          if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow || data?.type !== 'dpr:reader-canonical' || !ref?.paperId || ref.paperId !== initial.current.ref?.paperId || data.paperId !== ref.paperId) return
          if (typeof ref.name === 'string' && typeof ref.topic === 'string') setCanonical({ name: ref.name, topic: ref.topic })
        }
        window.addEventListener('message', message); return () => window.removeEventListener('message', message)
      }, [])
      const back = async () => {
        setError('')
        try { await clientApi.dockReading.save(workspaceSessionId, info.tab.id); info.tab.actions.openTab('dpr-library', { revealIfOpened: true }) } catch (cause) { setError(cause.message || String(cause)) }
      }
      return h('section', { 'data-dpr-dock-reader': '', style: { width: '100%', height: '100%', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
        h('div', { style: { flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', fontSize: 12 } }, h('button', { type: 'button', onClick: () => void back() }, t('library')), h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, canonical?.name || params.name || t('pdfTab'))),
        (error || initial.current.error) && h('p', { role: 'status' }, error || initial.current.error),
        !initial.current.error && h('div', { ref: anchorRef, 'data-dpr-dock-anchor': '', style: { flex: '1 1 auto', minHeight: 0, minWidth: 0, width: '100%' } }))
    }

    function BarePdfRoot(props) {
      const active = props.active !== false && props.canShow !== false
      useEffect(() => {
        if (active && props.isReaderExpanded?.(props.sessionId) === true) props.layoutService.openRightbar(true, false)
        // The official seat reports its own presentation when this override is released.
      }, [active, props.sessionId, props.layoutService])
      return h('div', {
        'data-dpr-root': '', 'data-dpr-tab': '1', 'data-dpr-session': props.sessionId,
        'data-dpr-visible': active ? 'true' : 'false', 'data-dsh-surface': 'rightbar-root-anchor',
        style: { position: 'absolute', inset: 0, width: '100%', height: '100%', minWidth: 0, minHeight: 0,
          margin: 0, padding: 0, border: 0, borderRadius: 0, overflow: 'hidden' },
      })
    }

    function PdfTab(props) {
      // Native identity plus actual DOM visibility distinguish keepMounted background tabs.
      const info = props.useTabInfo?.()
      const hasPaper = !!localStorage.getItem('dpr.last')
      return h('div', {
        'data-dsh-surface': 'rightbar-tab-anchor',
        'data-dpr-tab': '1',
        'data-dpr-session': props.sessionId,
        'data-dpr-tab-id': info?.tab?.id,
        'data-dpr-visible': info?.tab?.visible === false ? 'false' : 'true',
        style: { width: '100%', height: '100%' },
      }, hasPaper ? null : h('div', { style: { padding: '16px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #656d76)' } }, '← 从文献库选择一篇论文'))
    }

    /* ---------- 对话列头部的 [🕐历史 / ＋新建] 浮动按钮组 ----------
       官方 header.actions 是 session 作用域 slot，动态包（ModuleLoader）注册的条目
       不被渲染（实测：register 成功但零渲染）——退化为 fixed 浮动组，portal 到 body，
       200ms 轮询对齐对话列头部右侧原生按钮的左缘；仅当前会话是伴读会话（dpr-）时显示。
       历史点开下拉：该论文全部会话（真实标题+日期），点哪条进哪条。 */
    function parseDprSession(sid) {
      const stable = dprSessionPaper(sid)
      if (stable) return stable
      if (typeof sid !== 'string' || !sid.startsWith('dpr-')) return null
      try {
        const body = sid.slice(4)
        const m = body.match(/-(\d+)$/)
        const n = m ? +m[1] : 1
        const b64 = (m ? body.slice(0, -m[0].length) : body).replaceAll('-', '+').replaceAll('_', '/')
        const bin = atob(b64)
        const decoded = decodeURIComponent([...bin].map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''))
        const sep = decoded.indexOf('/')
        if (sep <= 0 || sep === decoded.length - 1) return null
        return { topic: decoded.slice(0, sep), name: decoded.slice(sep + 1), n }
      } catch { return null }
    }

    function SessionActions(props) {
      const { uiWorkspace } = props
      const [curSid, setCurSid] = useState(null)
      const [anchor, setAnchor] = useState(null) // {top, right} | null
      const [open, setOpen] = useState(false)
      const [list, setList] = useState(null)
      const btnRef = React.useRef(null)
      const popRef = React.useRef(null)
      const [popPos, setPopPos] = useState(null)

      // 轮询：当前会话 + 对话列头部锚点（跟随换位/拖拽/折叠/会话切换）
      useEffect(() => {
        let alive = true, padded = null, oldPad = null
        const clearPadding = () => {
          if (padded?.getAttribute('data-dpr-pad') === '1') {
            if (oldPad === null) padded.removeAttribute('data-dpr-pad'); else padded.setAttribute('data-dpr-pad', oldPad)
          }
          padded = null
        }
        const tick = () => {
          if (!alive) return
          let next = null
          try {
            const snap = uiWorkspace.sessions?.list?.getSnapshot?.()
            const cur = currentSessionOf(snap)
            setCurSid((prev) => (prev === cur ? prev : cur))
            const col = Array.from(document.querySelectorAll('[data-rightbar-col]'))
              .map(el => dprConversationColumn(el.parentElement)).find(el => dprVisibleElement(el, window))
            const conv = col?.querySelector('[data-phase]')
            if (col && conv && typeof cur === 'string' && cur.startsWith('dpr-')) {
              const r = col.getBoundingClientRect()
              if (r.width > 200) {
                // 贴头部右端：preset 徽标之右、系统控件（utilities/corner，哪个可见用哪个）之左；
                // Only our local stylesheet reserves header space; native owner keeps its chrome.
                const visibleDock = selector => Array.from(col.querySelectorAll(selector)).find(el => dprVisibleElement(el, window))
                const dock = visibleDock('[class*="headerUtilities"]') || visibleDock('[class*="headerCorner"]')
                const localDock = col.closest('[data-dpr-layout-frame]') ? dock : null
                if (padded !== localDock) {
                  clearPadding()
                  if (localDock) { padded = localDock; oldPad = padded.getAttribute('data-dpr-pad'); padded.setAttribute('data-dpr-pad', '1') }
                }
                const leftEdge = dock ? dock.getBoundingClientRect().left : r.right - 12
                next = { top: Math.round(r.top + 10), right: Math.round(window.innerWidth - leftEdge + 6) }
              }
            }
            if (!next) clearPadding()
          } catch { /* 目录未就绪 */ }
          setAnchor((prev) => (prev && next && prev.top === next.top && prev.right === next.right) || (!prev && !next) ? prev : next)
        }
        tick()
        const timer = setInterval(tick, 200)
        window.addEventListener('dpr:layout', tick)
        return () => {
          alive = false
          clearInterval(timer); clearPadding()
          window.removeEventListener('dpr:layout', tick)
        }
      }, [uiWorkspace])

      // 阅读器当前文献（dpr.last 恢复 + 保存后实际 display commit）。侧栏点论文只保证阅读器切换，
      // 会话列切换是尽力而为（activateSession 轮询 6s 后静默放弃）——两者可能脱钩：
      // 此时「历史/新建」若跟着会话列走，会在用户正看的另一篇论文上建会话（实测踩坑）。
      // 这里以「正在看的文献」为准；脱钩时给 ⚠ 一键对齐入口（把会话列切回当前文献）。
      const [viewed, setViewed] = useState(() => {
        try { return JSON.parse(localStorage.getItem('dpr.last') || 'null') } catch { return null }
      })
      useEffect(() => {
        const on = e => setViewed(e.detail.paper)
        window.addEventListener('dpr:paper-displayed', on)
        return () => window.removeEventListener('dpr:paper-displayed', on)
      }, [])

      const chatPaper = parseDprSession(curSid)
      const paper = viewed || chatPaper
      const mismatch = !!(curSid && viewed && !(list?.some(s => s.sessionId === curSid) || dprSamePaper(chatPaper, viewed)))

      // 下拉打开时拉该论文的会话列表；点外面关闭
      useEffect(() => {
        if (!open || !paper) return undefined
        setList(null)
        api('/sessions?' + new URLSearchParams(paper.paperId ? { paperId: paper.paperId } : { topic: paper.topic, name: paper.name }))
          .then((d) => setList(d.sessions)).catch(() => setList([]))
        const onDown = (e) => {
          if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        transientClosers.add(onDown)
        return () => { transientClosers.delete(onDown); document.removeEventListener('mousedown', onDown) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [open, paper?.topic, paper?.name])

      if (!paper || !anchor) return null

      let titles = {}
      try {
        const snap = uiWorkspace.sessions?.list?.getSnapshot?.()
        for (const s of list ?? []) {
          const title = snap?.byId?.[s.sessionId]?.title
          if (title) titles[s.sessionId] = title
        }
      } catch { /* 标题不可读时用 会话N */ }

      const iconBtn = {
        width: '28px', height: '28px', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px',
        display: 'grid', placeItems: 'center',
        color: 'var(--dsw-alias-label-tertiary, #656d76)',
        background: 'var(--dsw-alias-bg-base, #fff)',
      }

      return createPortal(
        h('div', {
          'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'session-actions',
          style: { position: 'fixed', top: anchor.top + 'px', right: anchor.right + 'px', display: 'flex', gap: '2px', zIndex: 45 },
        },
          mismatch && h('button', {
            style: { ...iconBtn, color: 'var(--dsw-alias-state-warn, #d29922)' },
            title: t('sync'),
            onClick: () => window.dispatchEvent(new CustomEvent('dpr:enter', { detail: { topic: viewed.topic, name: viewed.name, paperId: viewed.paperId } })),
          }, '⚠'),
          h('button', {
            ref: btnRef, style: iconBtn, title: t('history'),
            onClick: () => {
              if (!open && btnRef.current) {
                const r = btnRef.current.getBoundingClientRect()
                setPopPos({ top: Math.round(r.bottom + 6), right: Math.round(window.innerWidth - r.right) })
              }
              setOpen(!open)
            },
          }, '🕐'),
          h('button', {
            style: iconBtn, title: t('newChat'),
            onClick: () => window.dispatchEvent(new CustomEvent('dpr:newchat', { detail: { topic: paper.topic, name: paper.name, paperId: paper.paperId } })),
          }, '＋'),
          open && createPortal(
            h('div', {
              ref: popRef,
              'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'session-history',
              style: {
                position: 'fixed', top: (popPos?.top ?? 40) + 'px', right: (popPos?.right ?? 20) + 'px',
                minWidth: '220px', maxWidth: '320px', maxHeight: '50vh', overflowY: 'auto', zIndex: 90,
                background: 'var(--dsw-alias-bg-base, #fff)', border: '.5px solid var(--dsw-alias-border-l3, #e2e5ea)',
                borderRadius: '10px', boxShadow: '0 8px 30px rgba(0,0,0,.14)', padding: '4px',
              },
            },
              list === null
                ? h('div', { style: { padding: '10px 12px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, #656d76)' } }, '…')
                : list.map((s) => {
                    const active = s.sessionId === curSid
                    return h('div', {
                      key: s.sessionId,
                      onClick: () => {
                        setOpen(false)
                        if (!active) window.dispatchEvent(new CustomEvent('dpr:enter', { detail: { topic: paper.topic, name: paper.name, n: s.n, paperId: paper.paperId, sessionId: s.sessionId } }))
                      },
                      style: {
                        padding: '7px 10px', borderRadius: '7px', cursor: 'pointer', fontSize: '13px',
                        color: active ? 'var(--dsw-alias-state-business-primary, #0969da)' : 'var(--dsw-alias-label-primary, #24292f)',
                        background: active ? 'var(--dsw-alias-bg-active, rgba(9,105,218,.10))' : 'none',
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      },
                    },
                      (s.running ? '● ' : '') + (titles[s.sessionId] || `${t('session')} ${s.n}`),
                      h('span', { style: { float: 'right', fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #656d76)', marginLeft: '12px' } },
                        s.updatedAt ? new Date(s.updatedAt).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' }) : ''),
                    )
                  }),
            ),
            document.body,
          ),
        ),
        document.body,
      )
    }

    /* ---------- 侧栏文献库树（接管 sidebar.workspaces） ---------- */
    const S = {
      root: { padding: '4px 0 12px', fontSize: '13px', color: 'var(--dsw-alias-label-primary, #24292f)' },
      head: { display: 'flex', alignItems: 'center', gap: '4px', padding: '8px 10px 6px', fontSize: '12px', fontWeight: 600, color: 'var(--dsw-alias-label-secondary, #656d76)' },
      iconBtn: { cursor: 'pointer', border: 'none', background: 'none', color: 'inherit', padding: '0 4px', fontSize: '13px', opacity: .75 },
      // 页内弹窗（Electron 无 window.prompt）与空库入口按钮
      btnPrimary: { fontSize: '13px', padding: '5px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer', background: 'var(--dsw-alias-button-primary-fill, #1f6feb)', color: 'var(--dsw-alias-button-primary-foreground, #fff)' },
      btnGhost: { fontSize: '13px', padding: '5px 14px', borderRadius: '6px', cursor: 'pointer', background: 'none', border: '1px solid var(--dsw-alias-border-l1, #d0d7de)', color: 'var(--dsw-alias-label-secondary, #656d76)' },
      linkBtn: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', background: 'none', border: '1px solid var(--dsw-alias-border-l1, #d0d7de)', color: 'var(--dsw-alias-label-action-primary, #0969da)' },
      topicHead: { display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px', margin: '1px 6px 0', borderRadius: '6px', cursor: 'pointer', fontWeight: 600, userSelect: 'none' },
      caret: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary, #656d76)', transition: 'transform .12s', display: 'inline-block' },
      items: { marginLeft: '14px' },
      item: { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', margin: '0 6px', borderRadius: '6px', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      active: { background: 'var(--dsw-alias-bg-active, rgba(9,105,218,.12))', color: 'var(--dsw-alias-label-action-primary, #0969da)', fontWeight: 600 },
      sessionItem: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #656d76)' },
      empty: { padding: '10px 12px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #656d76)', lineHeight: 1.6 },
      running: { color: 'var(--dsw-alias-state-success-primary, #1a7f37)', fontSize: '9px' },
      // 收起态（rail）：官方 rail 的控件是 36×36 圆形按钮、左对齐
      rail: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start' },
      railBtn: { width: '36px', height: '36px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'none', borderRadius: '50%', color: 'var(--dsw-alias-label-primary, #24292f)', cursor: 'pointer', fontSize: '17px', padding: '0' },
    }

    /* ---------- 页内文本输入弹窗：Electron 渲染进程不实现 window.prompt
       （实测同版本 Electron 调用即抛 "prompt() is not supported"，桌面端点「＋」
       曾因此毫无反应），一律走 createPortal 挂 document.body，避免被侧栏 overflow 裁剪。 ---------- */
    const transientClosers = new Set()
    function useTransientClose(close, enabled = true) {
      const ref = React.useRef(null), latest = React.useRef(close)
      latest.current = close
      useEffect(() => {
        if (!enabled) return
        const outside = event => { if (!ref.current?.contains(event.target)) latest.current() }
        transientClosers.add(outside)
        return () => transientClosers.delete(outside)
      }, [enabled])
      return ref
    }
    function AskText(props) {
      const { title, confirmText, cancelText, onConfirm, onCancel, initial } = props
      const [v, setV] = useState(() => initial ?? '')   // 上游写法：惰性初值（避免每次渲染重算）
      const ref = React.useRef(null)
      const panel = useTransientClose(onCancel)
      useEffect(() => {
        ref.current?.focus()
        if (ref.current && initial) ref.current.select() // 重命名场景：默认选中旧名，直接覆盖输入
      }, [])
      const submit = () => { const s = v.trim(); if (s) onConfirm(s) }
      return h('div', {
        style: { position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', font: 'inherit' },
        onClick: onCancel,
      },
        h('div', {
          ref: panel,
          style: { width: '320px', maxWidth: '90vw', padding: '16px', borderRadius: '10px', boxShadow: '0 8px 30px rgba(0,0,0,.3)', background: 'var(--dsw-alias-bg-layer-1, #ffffff)', color: 'var(--dsw-alias-label-primary, #24292f)' },
          onClick: (e) => e.stopPropagation(),
        },
          h('div', { style: { fontSize: '13px', fontWeight: 600, margin: '0 0 10px' } }, title),
          h('input', {
            ref, value: v, type: 'text',
            style: { width: '100%', boxSizing: 'border-box', fontSize: '13px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1, #d0d7de)', background: 'var(--dsw-alias-bg-layer-2, #f6f8fa)', color: 'inherit', outline: 'none' },
            onChange: (e) => setV(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') onCancel() },
          }),
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', margin: '12px 0 0' } },
            h('button', { type: 'button', style: S.btnGhost, onClick: onCancel }, cancelText),
            h('button', { type: 'button', style: S.btnPrimary, onClick: submit }, confirmText))))
    }

    /* ---------- 破坏性操作确认弹窗（删除专用）----------
       与 AskText 同一套 portal + 页内弹窗约定：Electron 渲染进程不支持 window.confirm/prompt。
       契约要求：文案必须**逐条列出将删除的内容**，且清单来自服务端 dry-run（delete-plan），
       不允许前端自己拼。专题删除额外要求输入专题名（type-to-confirm）。 */
    function ConfirmDelete(props) {
      const { title, body, detail, notDeleted, confirmText, cancelText, requireText, onConfirm, onCancel } = props
      const panel = useTransientClose(() => { if (!props.busy) onCancel() })
      const [typed, setTyped] = useState('')
      const ok = !props.busy && (!requireText || typed.trim() === requireText)
      return h('div', {
        role: props.dialogLabel ? 'dialog' : undefined, 'aria-label': props.dialogLabel,
        style: { position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', font: 'inherit' },
        onClick: () => { if (!props.busy) onCancel() },
      },
        h('div', {
          style: { width: '380px', maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto', padding: '16px', borderRadius: '10px', boxShadow: '0 8px 30px rgba(0,0,0,.3)', background: 'var(--dsw-alias-bg-layer-1, #ffffff)', color: 'var(--dsw-alias-label-primary, #24292f)' },
          ref: panel, onClick: (e) => e.stopPropagation(),
        },
          h('div', { style: { fontSize: '13px', fontWeight: 600, margin: '0 0 8px' } }, title),
          body ? h('div', { style: { fontSize: '12.5px', lineHeight: 1.6 } }, body) : null,
          detail ? h('div', {
            style: { margin: '8px 0 0', padding: '6px 8px', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-2, #f6f8fa)', fontSize: '11.5px', lineHeight: 1.7, maxHeight: '32vh', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
          }, detail) : null,
          notDeleted ? h('div', { style: { marginTop: '8px', fontSize: '11.5px', color: 'var(--dsw-alias-label-secondary, #656d76)', lineHeight: 1.6 } }, notDeleted) : null,
          props.error ? h('div', { role: 'alert', style: { marginTop: '8px', whiteSpace: 'pre-wrap' } }, props.error) : null,
          requireText ? h('input', {
            value: typed, type: 'text', placeholder: requireText, 'aria-label': requireText, disabled: !!props.busy,
            style: { width: '100%', boxSizing: 'border-box', marginTop: '10px', fontSize: '13px', padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1, #d0d7de)', background: 'var(--dsw-alias-bg-layer-2, #f6f8fa)', color: 'inherit', outline: 'none' },
            onChange: (e) => setTyped(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter' && ok) onConfirm(); else if (e.key === 'Escape' && !props.busy) onCancel() },
          }) : null,
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', margin: '12px 0 0' } },
            h('button', { type: 'button', style: S.btnGhost, disabled: !!props.busy, onClick: onCancel }, cancelText),
            h('button', {
              type: 'button',
              style: { ...S.btnPrimary, ...(ok ? {} : { opacity: .5, cursor: 'default' }) },
              disabled: !ok,
              onClick: () => { if (ok) onConfirm() },
            }, confirmText))))
    }

    function openBatchDialog() {
      const existing = document.getElementById('dpr-batch-dialog')
      if (existing) { existing.showModal(); return }
      const dialog = document.createElement('dialog')
      dialog.id = 'dpr-batch-dialog'
      dialog.setAttribute('aria-label', '跨库批量翻译')
      Object.assign(dialog.style, { width: 'min(1040px,94vw)', height: 'min(820px,90vh)', padding: '0', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '12px', background: 'var(--dsw-alias-bg-layer-1)' })
      const close = document.createElement('button')
      close.textContent = '关闭面板（后台继续）'
      Object.assign(close.style, { position: 'absolute', right: '12px', top: '8px', zIndex: 2, cursor: 'pointer', borderRadius: '5px', padding: '5px 10px' })
      close.onclick = () => dialog.close()
      const frame = document.createElement('iframe')
      frame.src = '/paper-reader/batch'; frame.title = '跨库批量翻译'
      Object.assign(frame.style, { width: '100%', height: '100%', border: '0', paddingTop: '38px', boxSizing: 'border-box' })
      dialog.append(close, frame); document.body.appendChild(dialog)
      const outside = event => {
        if (event.target?.ownerDocument === frame.contentDocument) return
        if (!dialog.contains(event.target) || event.target === dialog) dialog.close()
      }
      transientClosers.add(outside)
      dialog.addEventListener('close', () => { transientClosers.delete(outside); dialog.remove() }, { once: true })
      dialog.showModal()
    }

    // Directory input supplies File objects, never a server-side directory path.
    const safeImportPart = value => !!value && value !== '.' && value !== '..' && !/[\\/\\\\:\u0000-\u001f]/.test(value)
    function directoryPdfs(files) {
      return files.filter(file => {
        const parts = (file.webkitRelativePath || '').split('/')
        return parts.length > 1 && parts.every(safeImportPart) && parts.at(-1) === file.name
          && /\.pdf$/i.test(file.name) && !/-(en|zh|dual)\.pdf$/i.test(file.name)
      })
    }
    function directoryPlan(files, topic, papers) {
      const key = name => name.normalize('NFC').toLowerCase()
      const seen = new Set(papers.filter(p => p.topic.normalize('NFC').toLowerCase() === topic.normalize('NFC').toLowerCase()).map(p => key(p.name)))
      return files.map(file => {
        const name = key(file.name.replace(/\.pdf$/i, '')), conflict = seen.has(name)
        seen.add(name)
        return { file, conflict }
      })
    }

    // One transient menu; its listeners are disposed on dismiss or tree unmount.
    let dismissLibraryMenu = null
    function showLibraryMenu(event, items) {
      event.preventDefault(); event.stopPropagation()
      dismissLibraryMenu?.()
      const menu = document.createElement('div'), previousFocus = document.activeElement
      menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', t('library'))
      Object.assign(menu.style, { position: 'fixed', zIndex: 100000, minWidth: '180px', maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 16px)', overflow: 'auto', padding: '5px', borderRadius: '8px', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #24292f)', boxShadow: '0 6px 24px #0004', border: '1px solid var(--dsw-alias-border-l1, #d0d7de)' })
      const close = () => {
        transientClosers.delete(outside)
        menu.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('click', outside, true)
        document.removeEventListener('keydown', keydown, true); window.removeEventListener('resize', close); window.removeEventListener('blur', close)
        if (dismissLibraryMenu === close) dismissLibraryMenu = null
        if (previousFocus?.isConnected) previousFocus.focus?.()
      }
      const outside = e => { if (!menu.contains(e.target)) close() }
      const keydown = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const buttons = [...menu.querySelectorAll('button:not(:disabled)')], i = buttons.indexOf(document.activeElement)
          buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
        }
      }
      for (const item of items) {
        const button = document.createElement('button')
        button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = item.label; button.disabled = !!item.disabled
        Object.assign(button.style, { display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', border: 0, borderRadius: '4px', background: 'transparent', color: 'inherit', font: 'inherit', cursor: item.disabled ? 'default' : 'pointer', opacity: item.disabled ? '.45' : '1' })
        button.onmouseenter = () => { button.style.background = 'var(--dsw-alias-interactive-bg-hover, #eee)' }
        button.onmouseleave = () => { button.style.background = 'transparent' }
        button.onclick = () => { close(); Promise.resolve().then(item.run).catch(err => toast(t('libraryActionFail') + ': ' + err.message)) }
        menu.appendChild(button)
      }
      document.body.appendChild(menu)
      const r = menu.getBoundingClientRect()
      menu.style.left = Math.max(8, Math.min(event.clientX, innerWidth - r.width - 8)) + 'px'
      menu.style.top = Math.max(8, Math.min(event.clientY, innerHeight - r.height - 8)) + 'px'
      document.addEventListener('pointerdown', outside, true); document.addEventListener('click', outside, true)
      document.addEventListener('keydown', keydown, true); window.addEventListener('resize', close); window.addEventListener('blur', close)
      dismissLibraryMenu = close
      menu.querySelector('button:not(:disabled)')?.focus()
      transientClosers.add(outside)
    }

    async function copyLibraryPath(path) {
      try { await navigator.clipboard.writeText(path); toast(t('pathCopied')); return } catch { /* permission denied / insecure context */ }
      const dialog = document.createElement('dialog'), hint = document.createElement('p'), text = document.createElement('textarea'), close = document.createElement('button')
      dialog.setAttribute('aria-label', t('copyPath'))
      Object.assign(dialog.style, { width: 'min(520px,85vw)', borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #24292f)' })
      hint.textContent = t('copyPathHint'); text.value = path; text.readOnly = true; text.setAttribute('aria-label', t('copyPath'))
      Object.assign(text.style, { width: '100%', height: '90px', boxSizing: 'border-box' })
      close.type = 'button'; close.textContent = t('ok'); close.onclick = () => dialog.close()
      const outside = event => { if (!dialog.contains(event.target) || event.target === dialog) dialog.close() }
      transientClosers.add(outside)
      dialog.append(hint, text, close); dialog.addEventListener('close', () => { transientClosers.delete(outside); dialog.remove() }, { once: true })
      document.body.appendChild(dialog); dialog.showModal(); text.focus(); text.select()
    }

    let dismissPaperDetails = null
    function openPaperDetails(ref) {
      const key = ref.paperId ? 'paperId' : 'collectionId', id = ref[key]
      if (!id) return
      if (document.getElementById('dpr-paper-details-dialog')) return
      const dialog = document.createElement('dialog'), frame = document.createElement('iframe')
      dialog.id = 'dpr-paper-details-dialog'; dialog.setAttribute('aria-label', t(ref.paperId ? 'paperDetails' : 'collectionNote'))
      Object.assign(dialog.style, { width: 'min(960px,94vw)', height: 'min(820px,90vh)', boxSizing: 'border-box', padding: 0, border: 0, outline: 0, overflow: 'hidden', borderRadius: '12px', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #24292f)' })
      frame.src = '/paper-reader/paper-details.html?' + key + '=' + encodeURIComponent(id)
      frame.title = t(ref.paperId ? 'paperDetails' : 'collectionNote')
      Object.assign(frame.style, { width: '100%', height: '100%', border: 0, display: 'block' })
      const requestClose = () => frame.contentWindow?.postMessage({ type: 'dpr:paper-details-request-close', [key]: id }, window.location.origin)
      const outside = event => {
        if (event.target?.ownerDocument === frame.contentDocument) return
        if (!dialog.contains(event.target) || event.target === dialog) requestClose()
      }
      transientClosers.add(outside)
      dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose() })
      const otherKey = key === 'paperId' ? 'collectionId' : 'paperId'
      const onMessage = e => {
        if (e.origin !== window.location.origin || e.source !== frame.contentWindow || e.data?.[key] !== id || Object.hasOwn(e.data, otherKey)) return
        if (e.data?.type === 'dpr:paper-details-close') dialog.close()
        if (e.data?.type === 'dpr:paper-details-updated' && e.data[key] === id) window.dispatchEvent(new Event('dpr:library-updated'))
      }
      const dispose = () => { transientClosers.delete(outside); window.removeEventListener('message', onMessage); dialog.remove(); if (dismissPaperDetails === dispose) dismissPaperDetails = null }
      window.addEventListener('message', onMessage); dialog.addEventListener('close', dispose, { once: true })
      dismissPaperDetails = dispose
      dialog.append(frame); document.body.appendChild(dialog); dialog.showModal()
    }

    function LibraryTree(props) {
      const { layout, uiWorkspace, sidebarRight, wide, expandSidebar } = props
      const [lib, setLib] = useState(null)
      const [closed, setClosed] = useState(() => JSON.parse(localStorage.getItem('dpr.treeClosed') || '{}'))
      const [sessions, setSessions] = useState({}) // `${topic}/${name}` → [{n, sessionId, running}]
      const [cur, setCur] = useState(() => JSON.parse(localStorage.getItem('dpr.last') || 'null'))
      const fileInput = React.useRef(null)
      const uploadTopic = React.useRef('')
      const uploadCollection = React.useRef(null)
      const folderInput = React.useRef(null)
      const [folder, setFolder] = useState(null)
      const importing = React.useRef(false)
      const folderPanel = useTransientClose(() => { if (!importing.current) setFolder(null) }, !!folder)
      const libraryRef = React.useRef(null)
      const refreshVersion = React.useRef(0)
      useEffect(() => () => { dismissLibraryMenu?.(); dismissPaperDetails?.() }, [])
      useEffect(() => {
        const on = e => setCur(e.detail.paper)
        window.addEventListener('dpr:paper-displayed', on)
        return () => window.removeEventListener('dpr:paper-displayed', on)
      }, [])

      const refresh = useCallback(async () => {
        const version = ++refreshVersion.current
        try {
          const [legacy, tree] = await Promise.all([api('/library'), api('/library/tree').catch(err => { if (err.status === 404) return null; throw err })])
          if (version !== refreshVersion.current) return
          const model = dprLibraryModel(tree, legacy)
          libraryRef.current = model; setLib(model)
          if (props.dockOpen) return model
          const current = JSON.parse(localStorage.getItem('dpr.last') || 'null')
          // Legacy aliases can have multiple historical owners: only the catalog resolver may supply their ID.
          const resolved = current && !current.paperId ? await api('/paper?' + new URLSearchParams({ topic: current.topic, name: current.name })) : current
          if (version !== refreshVersion.current) return model
          const displayed = JSON.parse(localStorage.getItem('dpr.last') || 'null')
          if (!dprSamePaper(current, displayed) || current?.paperId !== displayed?.paperId) return model
          const canonical = resolved?.paperId && model.papers?.find(p => p.paperId === resolved.paperId)
          if (canonical?.paperId && (current.paperId !== canonical.paperId || current.name !== canonical.name || current.topic !== canonical.topic || current.locationRevision !== canonical.locationRevision)) {
            window.dispatchEvent(new CustomEvent('dpr:paper', { detail: { ...canonical, n: current.n, identityOnly: true } }))
          }
          return model
        } catch (err) { toast(t('libraryActionFail') + ': ' + err.message) }
      }, [])
      useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 30000)
        window.addEventListener('focus', refresh); window.addEventListener('dpr:library-updated', refresh)
        return () => { clearInterval(timer); refreshVersion.current++; window.removeEventListener('focus', refresh); window.removeEventListener('dpr:library-updated', refresh) }
      }, [refresh])

      const paperFor = (topic, name, paperId) => libraryRef.current?.papers?.find(p => paperId ? p.paperId === paperId : p.topic === topic && p.name === name) || { topic, name, ...(paperId ? { paperId } : {}) }
      const paperIdentity = ref => ref.paperId ? { paperId: ref.paperId } : { topic: ref.topic, name: ref.name }
      const resolvePaper = async (topic, name, paperId) => {
        if (paperId) {
          const known = paperFor(topic, name, paperId)
          if (known.topic && known.name) return known
        }
        const ref = await api('/paper?' + new URLSearchParams(paperId ? { paperId } : { topic, name }))
        return { ...ref, topic: ref.topic || ref.segments?.join('/') || topic, name: ref.name || name }
      }
      const paperQuery = ref => new URLSearchParams(paperIdentity(ref)).toString()
      const loadSessions = useCallback((topic, name, paperId) => {
        api('/sessions?' + paperQuery(paperId ? paperFor(topic, name, paperId) : { topic, name }))
          .then((d) => setSessions((m) => ({ ...m, [`${topic}/${name}`]: d.sessions })))
          .catch(() => {})
      }, [])

      // 打开 PDF 页签：等 rightbar seat 绑定到目标会话后只调一次 openTab（成功即停，
      // 不再轮询——否则用户关页签会被后续 tick 重开，「关很多次才能关掉」）。
      // 「在屏会话」的读法两代不同：0.1.x 是 sidebarRight.binding.sessionId，
      // 0.2.0 起没有 binding，换成 mounted store（快照=在屏 sessionId）——
      // 只认旧的会把新版的页签轮询 30 次全部耗尽，PDF 永远开不出来（issue #1 实测）。
      const onScreenSession = (sr) => sr.binding?.sessionId ?? sr.mounted?.getSnapshot?.()
      const openPdfTab = useCallback((sessionId) => {
        let tries = 30
        const tick = () => {
          try {
            if (onScreenSession(sidebarRight) !== sessionId) throw new Error('seat-not-bound')
            sidebarRight.openTab('dpr-reader', { revealIfOpened: true })
          } catch {
            // 快轮询：seat 重绑一完成就开页签，把"面板空白"窗口压到最短
            if (--tries > 0) setTimeout(tick, 100)
          }
        }
        tick()
      }, [sidebarRight])

      // 激活会话：客户端会话目录（catalog）感知到新会话有时延，轮询到「已列出」再
      // openSession，并以 current === sessionId 为成功标准（否则原生对话区不切换）。
      // ⚠️ 仅凭 catalog 的 current 判断不够（用户实测「点插件页后再点论文没反应」）：
      // 插件页等非对话视图占着主视图时，目录里 cur 仍是目标会话，但视图并不在对话——
      // 提前返回会让主视图永远停在插件页、PDF 锚点不回来。补一个可见事实作成功标准：
      // PDF 页签锚点回来（对话视图已恢复）；没回来就持续 openSession 往回推。
      const activateSession = useCallback((sessionId) => {
        let tries = 20
        const tick = () => {
          try {
            const snap = uiWorkspace.sessions?.list?.getSnapshot?.()
            const anchorBack = !!dprReaderAnchor(document, window, sessionId)
            if (currentSessionOf(snap) === sessionId && anchorBack) return // 会话已切 + 视图已回
            const listed = !!(snap && (snap.byId?.[sessionId] || snap.ids?.includes(sessionId)))
            if (listed) uiWorkspace.openSession(sessionId)
            if (--tries > 0) setTimeout(tick, 300)
          } catch {
            if (--tries > 0) setTimeout(tick, 300)
          }
        }
        tick()
      }, [uiWorkspace])

      // 预开 PDF 页签到目标会话的 rightbar（在切换前）：先等客户端目录收录该会话
      // （否则 openTabIn 对未收编 store 静默 no-op），收录后 openTabIn 成功再切会话。
      // 不做这步的话，新会话的 rightbar 初始为空 → 列折叠 → openTab 再撑开
      // = PDF 消失又出现（实测逐帧确认）。
      const preOpenPdfTab = useCallback((sessionId, done) => {
        let tries = 30
        const tick = () => {
          try {
            const snap = uiWorkspace.sessions?.list?.getSnapshot?.()
            const listed = !!(snap && (snap.byId?.[sessionId] || snap.ids?.includes(sessionId)))
            if (listed) {
              // 对目录里早已存在的会话这步能真正预开（store 已 adopt）；
              // 对刚创建的会话恒 no-op —— 靠切换护栏兜底（见 beginSwitchGuard）。
              // ⚠️ openTabIn 失败不能堵住 done()（用户实测「点插件页后再点论文没反应」）：
              // 插件页等非对话视图占着主视图时，目标会话在右栏没有 seat，openTabIn 每次都抛——
              // 若当可重试错误轮询，done() 永远不执行 → activateSession（openSession 切回对话
              // 视图）不被调用 → 主视图停在插件页、PDF 锚点永不回来。预开只是优化，失败就
              // 直接放行，切换护栏 + openPdfTab 轮询兜底。
              try {
                sidebarRight.openTabIn(sessionId, 'dpr-reader', { revealIfOpened: true })
              } catch { /* 无 seat（插件页/会话未收编）——切换后由 openPdfTab 补开 */ }
              done?.()
              return
            }
          } catch { /* 目录未就绪 */ }
          if (--tries > 0) setTimeout(tick, 150)
          else done?.() // 兜底：超时也照常切（护栏 + openPdfTab 兜底路径）
        }
        tick()
      }, [sidebarRight, uiWorkspace])

      // 激活某个具体会话（原生对话区 + PDF 页签 + 阅读器同步）。纯函数式操作，不碰列表状态。
      const activate = useCallback((topic, name, target, ref = {}) => {
        // 离开的若是空白草稿（点了新建又没问任何问题）→ 后台归档，不留在会话列表里
        try {
          const snap = uiWorkspace.sessions?.list?.getSnapshot?.()
          const leaving = currentSessionOf(snap)
          if (leaving && typeof leaving === 'string' && leaving.startsWith('dpr-') && leaving !== target.sessionId
            && snap?.byId?.[leaving]?.blank && !snap.byId[leaving].running) {
            api('/sessions/archive', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: leaving, topic, name }),
            }).then(() => loadSessions(topic, name)).catch(() => {})
          }
        } catch { /* 目录未就绪就不归档（host 侧对账会兜底） */ }
        setCur({ topic, name, n: target.n, paperId: ref.paperId, collectionId: ref.collectionId, locationRevision: ref.locationRevision })
        setCurrentPaper(topic, name, target.n, ref)
        // 切换护栏：冻结右栏轨道/阅读器几何/面板过渡，只有对话区换内容（见 beginSwitchGuard）
        beginSwitchGuard()
        preOpenPdfTab(target.sessionId, () => activateSession(target.sessionId))
        openPdfTab(target.sessionId)         // 兜底：seat 重绑后立即开页签（幂等 reveal）
      }, [activateSession, loadSessions, openPdfTab, preOpenPdfTab, uiWorkspace])

      // 进入伴读：永远拉最新会话列表（缓存的 sessions 可能过期）。
      // 只在「未指定会话且一个都没有」时才创建会话1；指定了 n 就绝不擅自新建（避免重复创建）。
      const enter = useCallback(async (topic, name, n, paperId, sessionId) => {
        let ref
        try { ref = await resolvePaper(topic, name, paperId) } catch (err) { toast(t('libraryActionFail') + ': ' + err.message); return }
        let list = []
        try {
          const d = await api('/sessions?' + paperQuery(ref))
          list = d.sessions
          setSessions((m) => ({ ...m, [`${topic}/${name}`]: d.sessions }))
        } catch (err) { toast(t('libraryActionFail') + ': ' + err.message); return }
        let target = sessionId ? list.find(s => s.sessionId === sessionId) : n ? list.find((s) => s.n === n) : list[list.length - 1]
        if (!target) {
          if (n || sessionId) return // 指定的会话不存在，不做
          target = await api('/sessions/new', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(paperIdentity(ref)),
          })
          setSessions((m) => ({ ...m, [`${topic}/${name}`]: [...(m[`${topic}/${name}`] || []), target] }))
        }
        activate(ref.topic, ref.name, target, ref)
      }, [activate])

      // 新建对话：host 建好后直接激活它（不进 enter 的查找路径，杜绝二次创建）
      const newChat = useCallback(async (topic, name, paperId) => {
        let ref
        try { ref = await resolvePaper(topic, name, paperId) } catch (err) { toast(t('libraryActionFail') + ': ' + err.message); return }
        const created = await api('/sessions/new', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(paperIdentity(ref)),
        })
        const key = `${topic}/${name}`
        setSessions((m) => ({ ...m, [key]: [...(m[key] || []), created] }))
        activate(ref.topic, ref.name, created, ref)
        loadSessions(topic, name, ref.paperId) // 后台对账：让 host 的空白过滤把被顶替的旧空白会话收掉
      }, [activate, loadSessions])

      const [askTopic, setAskTopic] = useState(false)
      const createTopic = useCallback(async (raw, parentId = null) => {
        const name = raw?.trim()
        if (!name) return
        await api(lib?.hasTree ? '/library/collections' : '/library/topic', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(lib?.hasTree ? { parentId, name, operationId: crypto.randomUUID() } : { name }),
        })
        refresh()
      }, [refresh, lib])
      // 新建专题：window.prompt 在 Electron 渲染进程不可用（抛 "prompt() is not
      // supported"，点击无任何反应），改为 AskText 页内弹窗（见 LibraryTree return）。
      const newTopic = useCallback(() => setAskTopic({ parentId: null }), [])

      /* ---------- 库管理：改名/删除（用户反馈补齐） ----------
         已知代价（README 明示）：sessionId 编码旧 topic/name，改名后历史伴读会话从树上
         消失（会话本体仍在 dsh 全局列表）；study.json/译文/转录缓存随文件改名全部保留。 */
      const [renaming, setRenaming] = useState(null) // {kind:'topic'|'paper', topic, name}
      const [renamePlan, setRenamePlan] = useState(null)
      const renameApplying = React.useRef(false)

      const doRename = useCallback(async (kind, topic, name, to) => {
        const entity = kind === 'paper' ? paperFor(topic, name) : libraryRef.current?.collections?.find(c => c.topic === topic)
        if (entity?.paperId || entity?.collectionId) {
          try {
            const result = await api('/library/changes/plan', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...(kind === 'paper' ? { paperId: entity.paperId } : { collectionId: entity.collectionId }), name: to, expectedLocationRevision: kind === 'paper' ? entity.locationRevision : entity.revision }),
            })
            if (result.plan.conflicts?.length) { toast(t('renameTargetExists')); return }
            setRenamePlan(result.plan)
          } catch (err) { toast(t('renameFail') + ': ' + err.message) }
          return
        }
        const newTopicName = kind === 'topic' ? to : topic
        const newName = kind === 'paper' ? to : cur?.name ?? name
        try {
          await withSavedReader(async () => {
            const r = await api(`/library/rename-${kind}`, {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(kind === 'topic' ? { topic, to } : { topic, name, to }),
            })
            // 会话 id 内嵌旧身份；改名后保留会话本体并提示脱离树的历史。
            if (r && r.detachedSessions) toast(t('renameDone') + ' · ' + t('renameDetached').replace('{n}', String(r.detachedSessions)), 6000)
            migrateLsKeys(topic, newTopicName, kind === 'paper' ? name : null, kind === 'paper' ? newName : null)
            setSessions((m) => { const c = { ...m }; delete c[`${topic}/${name}`]; return c })
            if (kind === 'topic') setClosed((c) => {
              if (!(topic in c)) return c
              const n = { ...c }; n[to] = c[topic]; delete n[topic]
              try { localStorage.setItem('dpr.treeClosed', JSON.stringify(n)) } catch {}
              return n
            })
            if (cur && (kind === 'topic' ? cur.topic === topic : (cur.topic === topic && cur.name === name))) {
              setCur((c) => ({ ...c, topic: newTopicName, name: newName }))
              window.dispatchEvent(new CustomEvent('dpr:paper', { detail: { topic: newTopicName, name: newName } }))
            }
            refresh()
          })
        } catch (err) {
          const f = clearFailureText(err, t)
          toast(t('renameFail') + ': ' + f.text + (f.recovery ? '　' + f.recovery : ''), f.recovery ? 15000 : 6000)
        }
      }, [cur, refresh])

      const applyRename = async () => {
        if (!renamePlan || renameApplying.current) return
        renameApplying.current = true
        try {
          // The service ReaderGate performs the real snapshot/flush; retain the mounted editor here.
          await api('/library/changes/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId: renamePlan.planId, operationId: crypto.randomUUID() }) })
          setRenamePlan(null)
          window.dispatchEvent(new Event('dpr:library-updated'))
        } catch (err) { toast(t('renameFail') + ': ' + err.message) }
        finally { renameApplying.current = false }
      }

      // 删除不走上游的「同一按钮点两次（3s arm）」：改用我们的「服务端删除计划 + 页内确认框」
      // （文献列清单/总字节，专题要手输专题名）。语义上严格包含上游的两段式——第二击之前
      // 还多一次带清单的确认，且底层是移入回收站（可恢复）而不是 rmSync。

      const upload = useCallback((topic) => {
        uploadTopic.current = topic
        uploadCollection.current = libraryRef.current?.collections?.find(c => c.topic === topic)?.collectionId || null
        fileInput.current?.click()
      }, [])

      const onFile = useCallback(async (e) => {
        // 清空 input 前快照全部文件和目标专题；上传期间切换专题不会误投后续文件。
        const files = Array.from(e.target.files || [])
        const topic = uploadTopic.current
        const collectionId = uploadCollection.current
        e.target.value = ''
        if (!files.length) return
        let ok = 0
        const failed = []
        for (const file of files) {
          try {
            const r = await fetch('/paper-reader/api/library/upload', {
              method: 'POST',
              // header 值只允许 ISO-8859-1：中文专题名/文件名必须先编码
              headers: { 'x-dpr-topic': encodeURIComponent(topic), 'x-dpr-name': encodeURIComponent(file.name), ...(collectionId ? { 'x-dpr-collection-id': collectionId } : {}), 'content-type': 'application/pdf' },
              body: file,
            })
            if (!r.ok) {
              const body = await r.json().catch(() => ({}))
              throw new Error(body.error || body.reason || ('HTTP ' + r.status))
            }
            ok++
          } catch (err) {
            failed.push(t('uploadFailedItem').replace('{name}', file.name).replace('{reason}', err.message || String(err)))
          }
        }
        refresh()
        toast(t('uploadSummary').replace('{ok}', String(ok)).replace('{failed}', String(failed.length)) + (failed.length ? '\n' + failed.join('\n') : ''))
      }, [refresh])

      const topics = lib?.topics ?? []
      const papers = lib?.papers ?? []
      const collections = lib?.collections ?? []

      const onFolder = useCallback(async e => {
        const files = directoryPdfs(Array.from(e.target.files || []))
        e.target.value = ''
        if (!files.length) { toast(t('importCount').replace('{n}', '0').replace('{conflicts}', '0')); return }
        try {
          await refresh()
          setFolder({ files, topic: files[0].webkitRelativePath.split('/')[0], busy: false })
        } catch (err) { toast(t('importFail') + ': ' + err.message) }
      }, [])
      const folderRows = folder ? directoryPlan(folder.files, folder.topic.trim(), papers) : []
      const importFolder = useCallback(async () => {
        if (!folder || importing.current) return
        const topic = folder.topic.trim()
        if (!safeImportPart(topic)) { toast(t('importInvalid')); return }
        importing.current = true
        setFolder(f => ({ ...f, busy: true }))
        let ok = 0, skipped = 0
        const failed = []
        try {
          const latest = await api('/library')
          if (latest.capabilities?.safeImport !== true) throw new Error(t('importRestart'))
          const rows = directoryPlan(folder.files, topic, latest.papers || [])
          if (!(latest.topics || []).some(name => name.normalize('NFC').toLowerCase() === topic.normalize('NFC').toLowerCase())) {
            await api('/library/topic', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: topic }) })
          }
          for (const { file, conflict } of rows) {
            if (conflict) { skipped++; continue }
            try {
              const r = await fetch('/paper-reader/api/library/upload', {
                method: 'POST', headers: { 'x-dpr-topic': encodeURIComponent(topic), 'x-dpr-name': encodeURIComponent(file.name), 'content-type': 'application/pdf' }, body: file,
              })
              if (r.status === 409) { skipped++; continue } // raced since preview: exclusive create, never overwrite
              if (!r.ok) {
                const body = await r.json().catch(() => ({}))
                throw new Error(body.error || body.reason || ('HTTP ' + r.status))
              }
              ok++
            } catch (err) { failed.push(t('uploadFailedItem').replace('{name}', file.name).replace('{reason}', err.message)) }
          }
          setFolder(null)
          toast(t('importSummary').replace('{ok}', String(ok)).replace('{skipped}', String(skipped)).replace('{failed}', String(failed.length)) + (failed.length ? '\n' + failed.join('\n') : ''))
        } catch (err) {
          setFolder(f => f && ({ ...f, busy: false }))
          toast(t('importFail') + ': ' + err.message)
        } finally { importing.current = false; refresh() }
      }, [folder, refresh])

      const location = async (topic, name, action) => {
        const ref = name == null ? libraryRef.current?.collections?.find(c => c.topic === topic) : paperFor(topic, name)
        const identity = name == null && ref?.collectionId ? { collectionId: ref.collectionId } : ref?.paperId ? { paperId: ref.paperId } : { topic, ...(name == null ? {} : { name }) }
        const result = await api('/library/location', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...identity, action }),
        })
        if (action === 'path') await copyLibraryPath(result.path)
      }
      const queueCandidate = paper => !paper.translation || paper.translation.state === 'missing'
      const enqueue = async refs => {
        for (let i = 0; i < refs.length; i += 500) {
          await api('/translation-queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'enqueue', papers: refs.slice(i, i + 500).map(paperIdentity) }) })
        }
        toast(t('queueRequested'))
      }
      const openVersion = async (paper, variant) => {
        // Citation jumps update dpr.last directly; LibraryTree.cur can lag the displayed reader.
        const displayed = JSON.parse(localStorage.getItem('dpr.last') || 'null')
        localStorage.setItem(`dpr.variant.${paper.topic}/${paper.name}`, variant)
        if (paper.paperId) localStorage.setItem(`dpr.variant.id.${paper.paperId}`, variant)
        if (props.dockOpen) { await props.dockOpen({ ...paper, variant: variant || 'orig' }); return }
        await enter(paper.topic, paper.name, undefined, paper.paperId)
        // Same-paper src is unchanged: use the reader's existing openPaper path to restore its mode.
        if (dprSamePaper(displayed, paper)) await readerIframeEl?.contentWindow?.dpr?.openPaper(paper.topic, paper.name, undefined, undefined, paper.paperId)
      }
      const topicMenu = (e, topic) => {
        const collection = collections.find(c => c.topic === topic)
        return showLibraryMenu(e, [
        ...(collection?.collectionId ? [
          { label: t('collectionNote'), run: () => openPaperDetails(collection) },
          { label: t('newChild'), run: () => setAskTopic({ parentId: collection.collectionId }) },
        ] : []),
        { label: t('openFolder'), run: () => location(topic, null, 'open-folder') },
        { label: t('copyPath'), run: () => location(topic, null, 'path') },
        { label: t('upload'), run: () => upload(topic) },
        { label: t('importFolder'), run: () => folderInput.current?.click() },
        { label: t('enqueueTopic'), disabled: !papers.some(p => p.topic === topic && queueCandidate(p)), run: () => enqueue(papers.filter(p => p.topic === topic && queueCandidate(p))) },
        { label: t('rename'), run: () => setRenaming({ kind: 'topic', topic }) },
        { label: t('delTopic'), run: () => openDelete('topic', topic, topic, collection) },
      ]) }
      const paperMenu = (e, paper) => showLibraryMenu(e, [
        ...(paper.paperId ? [{ label: t('paperDetails'), run: () => openPaperDetails(paper) }] : []),
        { label: t('revealFile'), run: () => location(paper.topic, paper.name, 'reveal') },
        { label: t('openFolder'), run: () => location(paper.topic, paper.name, 'open-folder') },
        { label: t('copyPath'), run: () => location(paper.topic, paper.name, 'path') },
        { label: t('openOriginal'), run: () => openVersion(paper, '') },
        { label: t('openTranslation'), disabled: !paper.translation?.zh && !paper.translation?.dual, run: () => openVersion(paper, paper.translation?.zh ? 'zh' : 'dual') },
        { label: t('enqueuePaper'), disabled: !queueCandidate(paper), run: () => enqueue([paper]) },
        { label: t('rename'), run: () => setRenaming({ kind: 'paper', topic: paper.topic, name: paper.name }) },
        { label: t('delPaper'), run: () => openDelete('paper', paper.topic, paper.name, paper) },
      ])

      // 头部「⬆」与空库按钮共用：定位目标专题，没有专题时先自动建「默认专题」
      // （宿主端 mkdir recursive，重名无害）再弹文件选择——空库不再是无入口的死路。
      const uploadSmart = useCallback(async () => {
        let topic = cur?.topic || topics[0]
        if (!topic) {
          topic = t('defaultTopic')
          try {
            await api('/library/topic', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: topic }),
            })
          } catch { /* 已存在等情形忽略，继续走上传 */ }
          refresh()
        }
        upload(topic)
      }, [cur, topics, upload, refresh])

      // 对话头部按钮 → 树的既有动作（enter/newChat 闭包在这里）
      useEffect(() => {
        if (props.dockOpen) return
        const onEnter = (e) => enter(e.detail.topic, e.detail.name, e.detail.n, e.detail.paperId, e.detail.sessionId)
        const onNew = (e) => newChat(e.detail.topic, e.detail.name, e.detail.paperId)
        window.addEventListener('dpr:enter', onEnter)
        window.addEventListener('dpr:newchat', onNew)
        return () => {
          window.removeEventListener('dpr:enter', onEnter)
          window.removeEventListener('dpr:newchat', onNew)
        }
      }, [enter, newChat])

      /* ---------- 文献管理：重命名 / 删除（契约 §2）----------
         破坏性操作的 UI 规矩：
           · 一律页内 portal 弹窗（Electron 无 window.confirm/prompt）；
           · 删除前先打 /library/paper/delete-plan 拿服务端清单，把「将删除什么 / 不删什么」
             逐条写进确认框（前端不许自己拼清单）；
           · 服务端 409 用机器可读 code 分支（session-running / translation-busy /
             topic-not-empty / target-exists），不匹配中文文案。 */
      const [delDlg, setDelDlg] = useState(null) // immutable target + server plan + request token
      const deletePreview = React.useRef(0), deleteApplying = React.useRef(false)
      useEffect(() => () => { deletePreview.current++ }, [])
      const cancelDelete = () => { if (!deleteApplying.current) { deletePreview.current++; setDelDlg(null) } }

      const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B')
      const errText = (err) => {
        switch (err && err.code) {
          case 'session-running': return t('delBusySession')
          case 'translation-busy': return t('delBusyTranslate')
          case 'busy': return t('delBusy')
          // 上游必修 3：Windows 文件占用（EBUSY/EPERM）→ 409 file-busy，给「关掉占用程序再试」的可执行文案
          case 'file-busy': return t('delBusyFile')
          case 'session-unknown': return t('delSessionUnknown')
          case 'target-exists': return t('renameTargetExists')
          case 'topic-not-empty': return err.message || t('delTopicNotEmpty').replace('{n}', String((err.papers || []).length || (err.entries || []).length || 0))
          default: return (err && err.message) || String(err)
        }
      }

      const openDelete = useCallback(async (kind, topic, name, selected) => {
        if (deleteApplying.current) return
        const request = ++deletePreview.current
        setDelDlg(null)
        const ref = selected || (kind === 'paper' ? paperFor(topic, name) : libraryRef.current?.collections?.find(c => c.topic === topic)) || {}
        // Capture the clicked identity before the first await; later tree refreshes never retarget this plan.
        const target = { kind, topic, name, paperId: ref.paperId, collectionId: ref.collectionId, request }
        try {
          let plan
          if (kind === 'paper') {
            plan = await api('/library/paper/delete-plan?' + new URLSearchParams(paperIdentity(target)))
          } else {
            const count = (libraryRef.current?.papers || []).filter(p => target.collectionId ? p.collectionId === target.collectionId : p.topic === topic).length
            target.kind = count ? 'topic-clear' : 'topic'
            const query = new URLSearchParams(target.collectionId ? { collectionId: target.collectionId } : { topic })
            try { plan = await api('/library/topic/' + (count ? 'clear-plan?' : 'delete-plan?') + query) }
            catch (err) { if (!count && !target.collectionId && err.status === 404) plan = null; else throw err }
          }
          if (request !== deletePreview.current) return
          if (!dprDeletePlanMatches(plan, target)) throw new Error(t('deletePlanMismatch'))
          setDelDlg({ ...target, plan })
        } catch (e) {
          if (request === deletePreview.current) toast(t('delPlanFail') + '：' + errText(e))
        }
      }, [])

      /** 删掉的是当前打开的文献（或其所在专题）→ 切到剩余第一篇；全空则收起阅读器。
       *  （上游 v1.3.0 doDelete 的行为，整合时保留——否则 iframe 会指向已被删除的文件。） */
      const switchAfterDelete = useCallback(async (target, committed) => {
        // Shared last-paper preferences may belong to another window. Modern notices are
        // admitted only by this window's actual ReaderOverlay.current and committed PID set.
        if (!committed && !dprDeleteAffects(cur, target)) return
        const d = await api('/library').catch(() => null)
        const next = d?.papers?.[0] || null
        if (committed) {
          const notice = Object.freeze({
            target: Object.freeze({ kind: target.kind, paperId: target.paperId, collectionId: target.collectionId, topic: target.topic, name: target.name }),
            paperIds: Object.freeze([...committed.paperIds]), next: next ? Object.freeze({ ...next }) : null,
          })
          committedDeleteNotices.add(notice)
          window.dispatchEvent(new CustomEvent('dpr:delete-committed', { detail: notice }))
          return
        }
        if (next) {
          setCur(next)
          window.dispatchEvent(new CustomEvent('dpr:paper', { detail: next }))
        } else {
          setCur(null)
          try { localStorage.removeItem('dpr.last') } catch { /* 隐私模式 */ }
          window.dispatchEvent(new CustomEvent('dpr:paper', { detail: { empty: true } }))
        }
      }, [cur])

      const doDelete = useCallback(async () => {
        const d = delDlg
        if (!d || deleteApplying.current || d.request !== deletePreview.current) return
        deleteApplying.current = true
        setDelDlg({ ...d, busy: true, error: '' })
        const modern = !!d.plan?.planId
        let operationId = d.operationId
        try {
          if (modern && !operationId) {
            operationId = crypto.randomUUID()
            setDelDlg({ ...d, operationId, busy: true, error: '' })
          }
          const remove = async () => {
            const path = modern ? '/library/changes/delete' : d.kind === 'paper' ? '/library/delete-paper' : d.kind === 'topic-clear' ? '/library/topic/clear' : '/library/delete-topic'
            const body = modern ? { planId: d.plan.planId, operationId }
              : d.kind === 'paper' ? paperIdentity(d) : d.kind === 'topic-clear' ? { topic: d.topic, confirmName: d.name } : { name: d.name, confirmName: d.name }
            const result = await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
            const receipt = result.receipt
            if (modern && (receipt?.status !== 'committed' || receipt.operationId !== body.operationId || receipt.entityId !== d.plan.entityId || receipt.mode !== d.plan.mode || !Array.isArray(receipt.paperIds) || !receipt.paperIds.every(id => typeof id === 'string'))) throw new Error(t('deleteCommitUnknown'))
            const count = result.movedFiles ?? result.files?.length ?? result.moved?.length ?? d.plan?.affectedFiles?.length ?? 0
            toast(d.kind === 'topic-clear' ? t('clearDone').replace('{topic}', d.topic).replace('{papers}', String(result.cleared ?? d.plan?.papersCount ?? 0)).replace('{files}', String(count)) : t('delDone').replace('{files}', String(count)))
            await switchAfterDelete(d, modern ? receipt : null)
            if (d.request === deletePreview.current) setDelDlg(null)
            refresh()
          }
          // Modern plans use the server's real reader Gate; the legacy route retains its saved-reader lease.
          if (modern) await remove(); else await withSavedReader(remove)
        } catch (e) {
          const failure = clearFailureText(e, t)
          const error = t('delFail') + '：' + failure.text + (failure.recovery ? '　' + failure.recovery : '')
          if (d.request === deletePreview.current) setDelDlg({ ...d, ...(operationId ? { operationId } : {}), busy: false, error })
          toast(error, failure.recovery ? 15000 : 8000)
          refresh()
        } finally { deleteApplying.current = false }
      }, [delDlg, refresh, switchAfterDelete])

      // 清空确认框里的「会被服务端拦下」提示：清单里的 translation.busy / sessions.running 篇名
      // （在用户点确认**之前**就提示，而不是等 409）
      const clearBlockedNames = delDlg?.kind === 'topic-clear'
        ? (delDlg.plan?.papers ?? []).filter((p) => p.translation?.busy || (p.sessions?.running ?? 0) > 0).map((p) => p.name)
        : []

      const renderCollection = (collection, ancestors = new Set()) => {
        const topic = collection.topic, key = collection.collectionId || topic
        if (ancestors.has(key)) return null
        const branch = new Set(ancestors); branch.add(key)
        const isClosed = !!closed[key]
        return h('div', { key, 'data-dpr-collection-id': collection.collectionId },
          h('div', {
            style: S.topicHead, role: 'treeitem', 'aria-expanded': !isClosed, 'data-dpr-row': '', 'data-dpr-library-kind': 'topic',
            onContextMenu: e => topicMenu(e, topic),
            onClick: () => { const next = { ...closed, [key]: !isClosed }; setClosed(next); localStorage.setItem('dpr.treeClosed', JSON.stringify(next)) },
          },
            h('span', { style: { ...S.caret, transform: isClosed ? 'rotate(-90deg)' : 'none' } }, '▾'),
            h('span', { 'aria-hidden': 'true' }, isClosed ? '\uD83D\uDCC1' : '\uD83D\uDCC2'),
            h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: collection.name + (collection.note ? '\n' + collection.note : '') }, collection.name),
            collection.collectionId && h('button', { style: S.iconBtn, title: t('collectionNote'), onClick: e => { e.stopPropagation(); openPaperDetails(collection) } }, 'ⓘ'),
            h('button', { style: S.iconBtn, title: t('upload'), onClick: e => { e.stopPropagation(); upload(topic) } }, '⬆'),
            h('button', { 'data-dpr-act': 'rename', style: S.iconBtn, title: t('rename'), onClick: e => { e.stopPropagation(); setRenaming({ kind: 'topic', topic }) } }, '✎'),
            h('button', { 'data-dpr-act': 'del', style: S.iconBtn, title: t('delTopic'), onClick: e => { e.stopPropagation(); openDelete('topic', topic, topic, collection) } }, '🗑')),
          !isClosed && h('div', { style: S.items },
            (collection.papers || []).map(p => h('div', {
              key: p.paperId || p.name, 'data-dpr-paper-id': p.paperId, ...(props.dockOpen ? { 'data-dpr-dock-paper': p.paperId } : {}),
              style: { ...S.item, ...(cur && dprSamePaper(cur, p) ? S.active : {}) },
              'data-dpr-row': '', 'data-dpr-library-kind': 'paper', title: p.pdfPath || p.name,
              onContextMenu: e => paperMenu(e, p), onClick: () => { void (props.dockOpen ? props.dockOpen(p) : enter(p.topic, p.name, undefined, p.paperId)).catch(err => toast(t('libraryActionFail') + ': ' + err.message)) },
            }, '📄 ',
              h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }, title: p.name }, p.name),
              p.paperId && h('button', { style: S.iconBtn, title: t('paperDetails'), onClick: e => { e.stopPropagation(); openPaperDetails(p) } }, 'ⓘ'),
              h('button', { 'data-dpr-act': 'rename', style: S.iconBtn, title: t('rename'), onClick: e => { e.stopPropagation(); setRenaming({ kind: 'paper', topic: p.topic, name: p.name }) } }, '✎'),
              h('button', { 'data-dpr-act': 'del', style: S.iconBtn, title: t('delPaper'), onClick: e => { e.stopPropagation(); openDelete('paper', p.topic, p.name, p) } }, '🗑'))),
            collection.collectionId && collections.filter(child => child.parentId === collection.collectionId).map(child => renderCollection(child, branch))))
      }

      // 收起态（rail）：官方契约 —— sidebar.workspaces 在窄栏里只该给一个图标入口，点击请求
      // 宿主展开。整棵树不渲染：塞进 56px 会被挤成竖排文字（实测）。
      // 用 wide === false 而非 !wide：宿主万一没传这个 prop 时按展开态走，即改动前的行为。
      const tree = wide === false
        ? h('div', { style: S.rail },
            h('button', {
              type: 'button', style: S.railBtn, 'data-dpr-rail': '', title: t('library'),
              'aria-label': t('library'), onClick: () => expandSidebar && expandSidebar(),
            }, '📚'))
        : h(React.Fragment, null,
            h('div', { style: S.head },
              h('span', { style: { flex: 1 } }, t('library')),
              !props.dockOpen && h('button', { type: 'button', style: { ...S.iconBtn, fontSize: '12px', whiteSpace: 'nowrap' }, title: t('modeExitTip'), 'aria-label': t('returnWorkspace'), onClick: () => applyPaperMode(false) }, t('returnWorkspace')),
              h('button', { type: 'button', style: S.iconBtn, title: '跨库批量翻译', 'aria-label': '跨库批量翻译', onClick: openBatchDialog }, '译'),
              h('button', { style: S.iconBtn, title: t('upload'), onClick: () => uploadSmart() }, '⬆'),
              h('button', { type: 'button', style: S.iconBtn, title: t('importFolder'), 'aria-label': t('importFolder'), onClick: () => folderInput.current?.click() }, '📁'),
              h('button', { style: S.iconBtn, title: t('newTopic'), onClick: newTopic }, '＋'),
              h('button', { style: S.iconBtn, title: 'refresh', onClick: refresh }, '⟳'),
            ),
            lib && topics.length === 0 && h('div', { style: S.empty },
              `${t('empty')}：${t('hint')}`,
              h('div', { style: { display: 'flex', gap: '8px', margin: '8px 0 2px' } },
                h('button', { type: 'button', style: S.linkBtn, onClick: () => uploadSmart() }, '⬆ ', t('uploadBtn')),
                h('button', { type: 'button', style: S.linkBtn, onClick: newTopic }, '＋ ', t('newTopic')))),
            collections.filter(c => !c.parentId).map(c => renderCollection(c)),
          )

      return h('div', {
        style: { ...S.root, minWidth: 0, height: '100%', overflow: 'auto' }, ...(props.dockOpen ? { 'data-dpr-dock-library': '' } : {}), 'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'sidebar',
      },
        h('input', { ref: fileInput, type: 'file', accept: '.pdf', multiple: true, style: { display: 'none' }, onChange: onFile }),
        h('input', { ref: folderInput, type: 'file', accept: '.pdf', multiple: true, webkitdirectory: '', style: { display: 'none' }, onChange: onFolder }),
        // 阅读器 iframe 与对话头部按钮组已迁往 shell.overlay 常驻注册（见 applyPaperMode 下方）——
        // 它们不属于侧栏，更不能跟着「退出伴读模式」被卸载（已打开的 PDF 页签要继续活着）
        tree,
        folder && createPortal(
          h('div', {
            style: { position: 'fixed', inset: 0, zIndex: 99999, background: 'rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
            onClick: () => { if (!importing.current) setFolder(null) },
            onKeyDown: e => { if (e.key === 'Escape' && !importing.current) setFolder(null) },
          }, h('div', {
            ref: folderPanel, role: 'dialog', 'aria-modal': 'true', 'aria-label': t('importPreview'), 'data-dpr-import-preview': '',
            style: { width: '480px', maxWidth: '92vw', maxHeight: '86vh', overflow: 'auto', boxSizing: 'border-box', padding: '16px', borderRadius: '10px', boxShadow: '0 8px 30px #0004', background: 'var(--dsw-alias-bg-layer-1, #fff)', color: 'var(--dsw-alias-label-primary, #24292f)' },
            onClick: e => e.stopPropagation(),
          },
            h('strong', null, t('importPreview')),
            h('p', { style: { fontSize: '12px', lineHeight: 1.6 } }, t('importHint')),
            h('label', { style: { display: 'block' } }, t('importTarget'), h('input', {
              type: 'text', 'aria-label': t('importTarget'), value: folder.topic, disabled: folder.busy,
              onChange: e => setFolder(f => ({ ...f, topic: e.target.value })),
              style: { width: '100%', boxSizing: 'border-box', padding: '6px', marginTop: '6px' },
            })),
            h('p', null, t('importCount').replace('{n}', String(folderRows.length)).replace('{conflicts}', String(folderRows.filter(r => r.conflict).length))),
            h('ul', { style: { maxHeight: '32vh', overflow: 'auto', paddingLeft: '20px', fontSize: '12px', wordBreak: 'break-all' } },
              folderRows.map(({ file, conflict }, i) => h('li', { key: i, ...(conflict ? { 'data-dpr-import-conflict': '' } : {}) }, file.webkitRelativePath, ' → ', file.name, ' · ', t(conflict ? 'importConflict' : 'importReady')))),
            h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
              h('button', { type: 'button', style: S.btnGhost, disabled: folder.busy, onClick: () => setFolder(null) }, t('cancel')),
              h('button', { type: 'button', style: S.btnPrimary, disabled: folder.busy || !safeImportPart(folder.topic.trim()) || folderRows.every(r => r.conflict), onClick: importFolder }, t(folder.busy ? 'importBusy' : 'importStart'))))), document.body),
        askTopic && createPortal(
          h(AskText, {
            title: t('newTopic') + '：', confirmText: t('ok'), cancelText: t('cancel'),
            onConfirm: (name) => {
              setAskTopic(false)
              createTopic(name, askTopic.parentId).catch((err) => toast(t('newTopicFail') + ': ' + err.message))
            },
            onCancel: () => setAskTopic(false),
          }),
          document.body),
        // 重命名：上游 v1.3.0 的页内输入弹窗（初始值 = 旧名，走 migrateLsKeys 迁移本地记忆）
        renaming && createPortal(
          h(AskText, {
            title: (renaming.kind === 'topic' ? t('renameTopic') : t('renamePaper')) + '：',
            initial: renaming.kind === 'topic' ? renaming.topic : renaming.name,
            confirmText: t('ok'), cancelText: t('cancel'),
            onConfirm: (name) => {
              const r = renaming
              setRenaming(null)
              doRename(r.kind, r.topic, r.name, name)
            },
            onCancel: () => setRenaming(null),
          }),
          document.body),
        renamePlan && createPortal(h(ConfirmDelete, {
          dialogLabel: t('renamePreview'), title: t('renamePreview'), body: renamePlan.newName,
          detail: [...(renamePlan.affectedFiles || []), ...(renamePlan.sessionEffects || [])].map(item => typeof item === 'string' ? item : JSON.stringify(item)).join('\n'),
          confirmText: t('renameApply'), cancelText: t('cancel'), onConfirm: applyRename, onCancel: () => { if (!renameApplying.current) setRenamePlan(null) },
        }), document.body),
        // 删除：确认框必须列出服务端给的清单；专题删除还要输入专题名
        delDlg && createPortal(
          h(ConfirmDelete, {
            key: delDlg.request, dialogLabel: t('delConfirmTitle'), busy: delDlg.busy, error: delDlg.error,
            title: delDlg.kind === 'topic-clear'
              ? t('delTopicClearTitle').replace('{topic}', delDlg.topic)
              : `${t('delConfirmTitle')} · ${delDlg.kind === 'paper' ? delDlg.name : delDlg.topic}`,
            body: delDlg.kind === 'topic-clear'
              ? t('delTopicClearBody')
                  .replace('{papers}', String(delDlg.plan.papersCount ?? 0))
                  .replace('{files}', String(delDlg.plan.filesCount ?? delDlg.plan.affectedFiles?.length ?? 0))
                  .replace('{size}', fmtBytes(delDlg.plan.totalBytes ?? 0))
              : delDlg.kind === 'paper' && delDlg.plan
                ? t('delConfirmBody').replace('{files}', String(delDlg.plan.files?.length ?? delDlg.plan.affectedFiles?.length ?? 0)).replace('{size}', fmtBytes(delDlg.plan.totalBytes ?? 0))
                : t('delTopicTypeName').replace('{name}', delDlg.name),
            detail: delDlg.plan?.planId ? delDlg.plan.affectedFiles.join('\n') : delDlg.kind === 'topic-clear'
              // 逐篇列出清单（服务端同源）：篇名 — k 个文件 · 大小，再跟该篇的产物文件名
              ? delDlg.plan.papers.map((p) => `· ${p.name} — ${t('delTopicClearFiles').replace('{n}', String(p.files.length))} · ${fmtBytes(p.totalBytes)}\n    ${p.files.map((f) => f.name).join('、')}`).join('\n')
              : delDlg.kind === 'paper' && delDlg.plan
                ? delDlg.plan.files.map((f) => `· ${f.name}  ${fmtBytes(f.bytes)}`).join('\n')
                : null,
            // R4-F4：清单必须与服务端同源——用 delete-plan 返回的 notDeleted 派生出文案，
            // 不再用本地 i18n 硬编码（那份已经与契约漂移了）。专题删除没有 plan，保留本地兜底文案。
            notDeleted: delDlg.kind === 'topic-clear'
              ? [Array.isArray(delDlg.plan.notDeleted) ? delDlg.plan.notDeleted.join(' · ') : '',
                 clearBlockedNames.length ? t('delTopicClearBlocked').replace('{names}', clearBlockedNames.join('、')) : '',
                 delDlg.plan.hidden?.length ? t('delTopicClearHidden').replace('{names}', delDlg.plan.hidden.join('、')) : ''].filter(Boolean).join('  ')
              : delDlg.kind === 'paper' && delDlg.plan && Array.isArray(delDlg.plan.notDeleted)
                ? delDlg.plan.notDeleted.join(' · ')
                : t('delNotDeleted'),
            confirmText: delDlg.kind === 'topic-clear' ? t('delTopicClearConfirm') : delDlg.kind === 'paper' ? t('delToTrash') : t('delTopic'),
            cancelText: t('cancel'),
            // 手输专题名确认保留在「批量清空」这一步（与单篇删除同强度，不放松）
            requireText: delDlg.kind === 'paper' ? undefined : delDlg.name,
            onConfirm: doDelete,
            onCancel: cancelDelete,
          }),
          document.body),
      )
    }

    /* ---------- 论文伴读模式：默认不接管侧栏 ----------
       sidebar.workspaces 是 single slot，注册即遮蔽官方工作区列表——「一装就覆盖」
       对用户不礼貌。改为按需注册：默认不注册（官方侧栏原样），sidebar.panellist
       放一个主导航开关行，点击注册/注销文献库树，localStorage 记忆。
       阅读器悬浮层/会话按钮组走 shell.overlay 常驻注册，与本开关无关——退出模式时
       已打开的 PDF 页签和伴读会话照常工作，随时可切回。 */
    let paperMode = localStorage.getItem('dpr.mode') === 'paper'
    let disposeLibrarySlot = null
    let clientApi = null // apply() 里注入 { slots, layout, uiWorkspace, sidebarRight }

    function applyPaperMode(on) {
      paperMode = on
      window.dispatchEvent(new Event('dpr:layout'))
      try { localStorage.setItem('dpr.mode', on ? 'paper' : '') } catch { /* 隐私模式写不了就算了 */ }
      if (!clientApi) return
      if (on && !disposeLibrarySlot) {
        clientApi.slots.inject('sidebar.workspaces', () => {
          disposeLibrarySlot = clientApi.slots.register({
            name: 'sidebar.workspaces', priority: -1000, locale: NS,
          }, function LibrarySection(slot) {
            return h(LibraryTree, {
              layout: clientApi.layout, uiWorkspace: clientApi.uiWorkspace,
              sidebarRight: clientApi.sidebarRight,
              wide: slot?.wide, expandSidebar: slot?.expandSidebar,
            })
          })
        })
      } else if (!on && disposeLibrarySlot) {
        disposeLibrarySlot()
        disposeLibrarySlot = null
      }
      window.dispatchEvent(new Event('dpr-paper-mode'))
    }

    function PaperModeIcon({ size = 18 } = {}) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', style: { display: 'block', flexShrink: 0 } },
        h('path', { d: 'M12 5.5C9 3.5 5.5 3.5 3 4.5v15c2.5-1 6-1 9 1 3-2 6.5-2 9-1v-15c-2.5-1-6-1-9 1ZM12 5.5v15' }))
    }

    function PaperModeNav({ size }) {
      const glyph = React.useRef(null)
      useEffect(() => {
        // 当前宿主 panellist 只接受图标，外层按钮由 PanelRow 渲染。
        // 在该按钮捕获原生 click（包括 Enter／Space），仅切换侧栏模式；
        // 不调用 selectPanel，以免卸载当前对话。升级宿主时需回归此 DOM 适配。
        const button = glyph.current?.closest('button')
        if (!button) return
        const update = () => {
          button.setAttribute('data-dpr-mode', '')
          button.setAttribute('aria-pressed', String(paperMode))
          button.title = paperMode ? t('modeExitTip') : t('modeEnterTip')
          button.style.background = paperMode ? 'var(--dsw-alias-interactive-bg-active, rgba(9,105,218,.12))' : ''
        }
        const toggle = (e) => {
          e.preventDefault()
          e.stopImmediatePropagation()
          applyPaperMode(!paperMode)
        }
        button.addEventListener('click', toggle, true)
        window.addEventListener('dpr-paper-mode', update)
        update()
        return () => {
          button.removeEventListener('click', toggle, true)
          window.removeEventListener('dpr-paper-mode', update)
          button.removeAttribute('data-dpr-mode')
          button.removeAttribute('aria-pressed')
          button.removeAttribute('title')
          button.style.background = ''
        }
      }, [])
      return h('span', { ref: glyph, 'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'paper-mode' }, h(PaperModeIcon, { size }))
    }

    /* ---------- 设置面板：Jev 重排 + 翻译端点统一管理 ----------
       settings.section 面板（与官方 通用设置/模型 同款缝）。两张端点卡片共用一套
       读写口（GET 掩码回显 / POST 预检后落盘 / DELETE 回落默认），key 明文永不回传，
       留空即沿用已保存的那把。保存即生效：宿主每次调用都现读配置文件。 */
    const SET = {
      card: { border: '1px solid var(--dsw-alias-border-l1, #30363d)', borderRadius: '10px', padding: '14px 16px', margin: '0 0 16px', background: 'var(--dsw-alias-bg-layer-1, #0d1117)' },
      title: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary, #24292f)', margin: '0 0 4px' },
      desc: { fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary, #656d76)', margin: '0 0 12px' },
      label: { display: 'block', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #656d76)', margin: '10px 0 4px' },
      input: { width: '100%', boxSizing: 'border-box', fontSize: '13px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l1, #30363d)', background: 'var(--dsw-alias-bg-layer-2, #161b22)', color: 'var(--dsw-alias-label-primary, #24292f)' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px' },
      btn: { fontSize: '13px', padding: '6px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer', background: 'var(--dsw-alias-button-primary-fill, #1f6feb)', color: 'var(--dsw-alias-label-primary-foreground, #fff)' },
      btnGhost: { fontSize: '12px', padding: '6px 10px', borderRadius: '6px', cursor: 'pointer', background: 'none', border: '1px solid var(--dsw-alias-border-l1, #30363d)', color: 'var(--dsw-alias-label-secondary, #656d76)' },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary, #3fb950)' },
      err: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #f85149)' },
      meta: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #656d76)' },
    }

    function EndpointCard(props) {
      const [cfg, setCfg] = useState(null) // GET 结果（含 apiKeyHint/source）
      const [form, setForm] = useState({ baseUrl: '', model: '', apiKey: '', batchSize: '' })
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null) // { ok, text }
      const load = useCallback(() => {
        api(props.path).then((d) => {
          setCfg(d)
          setForm({
            baseUrl: d.baseUrl || '',
            model: d.model || '',
            apiKey: '',
            // null = 未显式配置（回落 profile / 默认 10），输入框留空展示占位符
            ...(props.batchSize ? { batchSize: d.batchSize != null ? String(d.batchSize) : '' } : {}),
          })
        }).catch((e) => setMsg({ ok: false, text: String(e.message || e) }))
      }, [props.path])
      useEffect(load, [load])
      const sourceText = !cfg ? '' : { file: t('setSourceFile'), profile: t('setSourceProfile'), env: t('setSourceEnv'), none: t('setSourceNone') }[cfg.source] || ''
      const save = async () => {
        setBusy(true); setMsg(null)
        try {
          await api(props.path, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(form),
          })
          setMsg({ ok: true, text: t('setSaved') })
          load()
        } catch (e) { setMsg({ ok: false, text: String(e.message || e) }) } finally { setBusy(false) }
      }
      const clear = async () => {
        setBusy(true); setMsg(null)
        try {
          await api(props.path, { method: 'DELETE' })
          setMsg({ ok: true, text: t('setCleared') })
          load()
        } catch (e) { setMsg({ ok: false, text: String(e.message || e) }) } finally { setBusy(false) }
      }
      const field = (key, label, placeholder, type) => h('div', null,
        h('label', { style: SET.label }, label, props.optional && key !== 'apiKey' ? `（${t('setOptional')}）` : ''),
        h('input', {
          style: SET.input, type: type || 'text', value: form[key], placeholder, disabled: busy,
          onChange: (e) => setForm({ ...form, [key]: e.target.value }),
        }),
      )
      return h('div', { style: SET.card, 'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-part': 'settings-card' },
        h('h3', { style: SET.title }, props.title),
        h('p', { style: SET.desc }, props.desc),
        field('baseUrl', t('setBaseUrl'), props.baseUrlPlaceholder),
        field('model', t('setModel'), props.modelPlaceholder),
        field('apiKey', t('setKey'), cfg?.hasApiKey ? t('setKeyKeep') + cfg.apiKeyHint : props.keyPlaceholder, 'password'),
        // 批大小仅嵌入卡片有（issue #14）：预检会按这个值真打一批，端点限流当场暴露而不是首次检索才失败
        props.batchSize ? field('batchSize', t('setEmbedBatchSize'), '10') : null,
        h('div', { style: SET.row },
          h('button', { type: 'button', style: SET.btn, disabled: busy, onClick: save }, busy ? t('setSaving') : t('setSave')),
          cfg?.source === 'file' ? h('button', { type: 'button', style: SET.btnGhost, disabled: busy, onClick: clear }, t('setClear')) : null,
          msg ? h('span', { style: msg.ok ? SET.ok : SET.err }, msg.text) : h('span', { style: SET.meta }, sourceText),
        ),
      )
    }

    /* ---------- 分屏同步滚动卡片（模式 B 的**全局**偏好）----------
       本卡片与阅读器是**两个文档**（阅读器是同源 iframe ~ /paper-reader/），共享同一个 localStorage：
         · 这里勾/取消 → 写 `dpr.syncScroll` → 阅读器收到 storage 事件 → 开关与滚动行为立即跟着变
           （打开时还会自动把两列对齐回当前页）；
         · 反之在阅读器「分屏」控件旁点开关 → 这里收到 storage 事件 → 勾选态立即跟着变。
       ⇒ 两处入口互相同步，且都是**同一个键**（键名与 '1'/'0' 编码由文件顶层的纯函数定义，
          与 reader/index.html 逐字一致）。默认开 = 缺省值（与改造前行为一致）。 */
    function SyncScrollCard() {
      const readPref = () => { try { return dprSyncScrollFromRaw(localStorage.getItem(DPR_SYNC_SCROLL_KEY)) } catch { return true } }
      const [on, setOn] = useState(readPref)
      useEffect(() => {
        const onStorage = (e) => {
          if (!e || e.key !== DPR_SYNC_SCROLL_KEY) return
          setOn(dprSyncScrollFromRaw(e.newValue))   // 另一处（阅读器/另一个窗口）改了 → 立即反映
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
      }, [])
      const apply = (v) => {
        setOn(v)
        try { localStorage.setItem(DPR_SYNC_SCROLL_KEY, dprSyncScrollRaw(v)) } catch { /* 隐私模式写不了：阅读器里仍可单独改 */ }
      }
      return h('div', { style: SET.card, 'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-part': 'settings-card' },
        h('h3', { style: SET.title }, t('setSyncScrollTitle')),
        h('p', { style: SET.desc }, t('setSyncScrollDesc')),
        h('div', { style: SET.row },
          h('label', { style: { ...SET.label, display: 'flex', alignItems: 'center', gap: '8px', margin: '0' }, 'data-dpr-sync-label': '' },
            h('input', {
              type: 'checkbox', checked: on, 'data-dpr-sync-input': '',
              // 与面板主题色对齐（原生 checkbox 的默认蓝与每套主题都对不上）：accent-color 是标准
              // 属性，不支持的旧壳只是回落成默认色，不影响可用性
              style: { width: '16px', height: '16px', cursor: 'pointer', accentColor: 'var(--dsw-alias-button-primary-fill, #1f6feb)' },
              onChange: (e) => apply(!!e.target.checked),
            }),
            t('setSyncScrollLabel'),
          ),
          h('span', { style: SET.meta, 'data-dpr-sync-state': '' }, on ? t('setSyncScrollOnHint') : t('setSyncScrollOffHint')),
        ),
      )
    }

    function WorkspaceVisibilityCard() {
      const [show, setShow] = useState(localStorage.getItem('dpr.showLibraryWorkspaces') === '1')
      return h('div', { style: SET.card },
        h('h3', { style: SET.title }, '文献库工作区显示隔离'),
        h('p', { style: SET.desc }, '默认从普通工作区列表隐藏文献库工作区，论文伴读模式照常显示；不删除、不归档、不改变文件权限。'),
        h('label', { style: SET.row }, h('input', { type: 'checkbox', checked: show, onChange: e => {
          const value = !!e.target.checked
          localStorage.setItem('dpr.showLibraryWorkspaces', value ? '1' : '0')
          setShow(value); window.dispatchEvent(new Event('dpr-workspace-visibility'))
        } }), '在普通工作区列表显示文献库工作区'),
        h('button', { type: 'button', style: SET.btnGhost, onClick: openBatchDialog }, '打开跨库批量翻译'),
      )
    }

    function SettingsPanel() {
      return h('div', { style: { maxWidth: '560px' }, 'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-surface': 'settings-modal' },
        h(EndpointCard, {
          path: '/typesafe/config', title: t('setRerankTitle'), desc: t('setRerankDesc'), optional: true,
          baseUrlPlaceholder: 'https://api.typesafe.ai', modelPlaceholder: 'jev-latest', keyPlaceholder: 'ts-...',
        }),
        h(EndpointCard, {
          path: '/embed/config', title: t('setEmbedTitle'), desc: t('setEmbedDesc'), optional: true,
          baseUrlPlaceholder: 'https://api.openai.com/v1', modelPlaceholder: 'text-embedding-3-small', keyPlaceholder: 'sk-...',
          batchSize: true,
        }),
        h(EndpointCard, {
          path: '/translate/config', title: t('setTranslateTitle'), desc: t('setTranslateDesc'),
          baseUrlPlaceholder: 'https://api.deepseek.com/v1', modelPlaceholder: 'deepseek-chat', keyPlaceholder: 'sk-...',
        }),
        h(MineruCard, null),
        h(SyncScrollCard, null),
        h(WorkspaceVisibilityCard, null),
      )
    }

    /* ---------- MinerU 卡片：模式 + 本地/云端参数 + 保存前预检 ---------- */
    function MineruCard() {
      const [cfg, setCfg] = useState(null)
      const [form, setForm] = useState({ mode: 'off', baseUrl: '', backend: 'pipeline', effort: 'medium', parseMethod: 'auto', apiKey: '', cloudApiKey: '' })
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null) // { ok, text }
      const load = useCallback(() => {
        api('/mineru/config').then((d) => {
          setCfg(d)
          setForm({
            mode: d.mode || 'off',
            baseUrl: d.local?.baseUrl || '',
            backend: d.local?.backend || 'pipeline',
            effort: d.local?.effort || 'medium',
            parseMethod: d.local?.parseMethod || 'auto',
            apiKey: '',
            cloudApiKey: '',
          })
        }).catch((e) => setMsg({ ok: false, text: String(e.message || e) }))
      }, [])
      useEffect(load, [load])
      const sourceText = !cfg ? '' : { file: t('setSourceFile'), profile: t('setSourceProfile'), env: t('setSourceEnv'), none: t('setSourceNone') }[cfg.source] || ''
      const payload = () => ({
        mode: form.mode,
        local: { baseUrl: form.baseUrl, backend: form.backend, effort: form.effort, parseMethod: form.parseMethod, apiKey: form.apiKey },
        cloud: { apiKey: form.cloudApiKey },
      })
      const save = async () => {
        setBusy(true); setMsg(null)
        try {
          await api('/mineru/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload()) })
          setMsg({ ok: true, text: t('setSaved') })
          load()
        } catch (e) { setMsg({ ok: false, text: String(e.message || e) }) } finally { setBusy(false) }
      }
      const clear = async () => {
        setBusy(true); setMsg(null)
        try {
          await api('/mineru/config', { method: 'DELETE' })
          setMsg({ ok: true, text: t('setCleared') })
          load()
        } catch (e) { setMsg({ ok: false, text: String(e.message || e) }) } finally { setBusy(false) }
      }
      const testConn = async () => {
        setBusy(true); setMsg(null)
        try {
          const d = await api('/mineru/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload()) })
          setMsg({ ok: d.reachable, text: d.reachable ? t('setMineruHealthOk') : (t('setMineruHealthFail') + (d.error ? ': ' + d.error : '')) })
        } catch (e) { setMsg({ ok: false, text: String(e.message || e) }) } finally { setBusy(false) }
      }
      const field = (key, label, placeholder, type) => h('div', null,
        h('label', { style: SET.label }, label),
        h('input', {
          style: SET.input, type: type || 'text', value: form[key], placeholder, disabled: busy,
          onChange: (e) => setForm({ ...form, [key]: e.target.value }),
        }),
      )
      const select = (key, label, options) => h('div', null,
        h('label', { style: SET.label }, label),
        h('select', {
          style: SET.input, value: form[key], disabled: busy,
          onChange: (e) => setForm({ ...form, [key]: e.target.value }),
        }, options.map((o) => h('option', { value: o.value, key: o.value }, o.label))),
      )
      return h('div', { style: SET.card, 'data-dsh-plugin': 'dsh-paper-reader', 'data-dsh-part': 'settings-card' },
        h('h3', { style: SET.title }, t('setMineruTitle')),
        h('p', { style: SET.desc }, t('setMineruDesc')),
        // 激活门槛人话（上游评审第 7 条）：说清「什么时候需要 + 配好之后入口出现在哪」，
        // 并按当前模式给一句取舍；「关闭」时明确 pdf.js 与 MinerU 各自能干什么（不夸大）。
        h('p', { style: SET.desc }, t('setMineruWhy')),
        h('p', { style: SET.meta },
          form.mode === 'local' ? t('setMineruWhyLocal') : form.mode === 'cloud' ? t('setMineruWhyCloud') : t('setMineruOffHint')),
        select('mode', t('setMineruMode'), [
          { value: 'off', label: t('setMineruModeOff') },
          { value: 'local', label: t('setMineruModeLocal') },
          { value: 'cloud', label: t('setMineruModeCloud') },
        ]),
        field('baseUrl', t('setMineruLocalUrl'), 'http://127.0.0.1:8000'),
        select('backend', t('setMineruBackend'), [
          { value: 'pipeline', label: 'pipeline' },
          { value: 'hybrid-engine', label: 'hybrid-engine' },
          { value: 'vlm-engine', label: 'vlm-engine' },
          { value: 'vlm-http-client', label: 'vlm-http-client' },
          { value: 'hybrid-http-client', label: 'hybrid-http-client' },
        ]),
        select('parseMethod', t('setMineruParseMethod'), [
          { value: 'auto', label: 'auto' },
          { value: 'txt', label: 'txt' },
          { value: 'ocr', label: 'ocr' },
        ]),
        select('effort', t('setMineruEffort'), [
          { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' },
        ]),
        field('apiKey', t('setMineruLocalKey'), cfg?.local?.hasApiKey ? t('setKeyKeep') + cfg.local.apiKeyHint : '', 'password'),
        field('cloudApiKey', t('setMineruCloudKey'), cfg?.cloud?.hasApiKey ? t('setKeyKeep') + cfg.cloud.apiKeyHint : 'mineru.net token', 'password'),
        h('div', { style: SET.row },
          h('button', { type: 'button', style: SET.btn, disabled: busy, onClick: save }, busy ? t('setSaving') : t('setSave')),
          h('button', { type: 'button', style: SET.btnGhost, disabled: busy, onClick: testConn }, t('setMineruTestConnection')),
          cfg?.source === 'file' ? h('button', { type: 'button', style: SET.btnGhost, disabled: busy, onClick: clear }, t('setClear')) : null,
          msg ? h('span', { style: msg.ok ? SET.ok : SET.err }, msg.text) : h('span', { style: SET.meta }, sourceText),
        ),
      )
    }

    return {
      inject: ['slots', 'locale', 'layout', 'uiWorkspace', 'sidebarRight', 'sidebarRightTabs', 'workspaces'],
      apply(ctx) {
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-paper-reader: dicts')
          const bound = ctx.locale.bind(NS)
          setT(bound)

          ctx.effect(() => () => {
            clearTimeout(switchTimer); switching = false
            readingLayout?.dispose(); readingLayout = null
          }, 'dsh-paper-reader: reading layout cleanup')
          // 自绘元素里 :hover 这类伪类内联 style 表达不了。内联仍写死态（注入失败时有个安全默认），
          // 这里用 !important 盖过内联给出 hover。
          if (!document.getElementById('dpr-surface-css')) {
            const styleEl = document.createElement('style')
            styleEl.id = 'dpr-surface-css'
            styleEl.textContent = '[data-dpr-rail]:hover,[data-dpr-mode]:hover{background:var(--dsw-alias-interactive-bg-hover)!important}'
              // 树行内的 ✎🗑 操作按钮：默认隐身，行悬停才现身（不再有「待确认态常亮」的 armed 状态）
              + '[data-dpr-act]{opacity:0!important;transition:opacity .12s}'
              + '[data-dpr-row]:hover [data-dpr-act],[data-dpr-row]:focus-within [data-dpr-act]{opacity:1!important}'
              + '[data-dpr-row]:hover{background:var(--dsw-alias-interactive-bg-hover,#eee)}'
            document.head.appendChild(styleEl)
          }

          // Display-only isolation uses the shipped official row identity seam; never mutate
          // the shared workspaces store or hide by title, and never hide nested ordinary projects.
          ctx.effect(() => {
            const css = document.createElement('style')
            css.id = 'dpr-workspace-visibility'
            document.head.appendChild(css)
            let paths = [], disposed = false
            const update = () => {
              if (disposed) return
              const rows = localStorage.getItem('dpr.showLibraryWorkspaces') === '1' ? []
                : paperWorkspaceRows(paths, ctx.workspaces.list.getSnapshot().items)
              css.textContent = rows.map(key => `[data-row-key="${CSS.escape(key)}"]{display:none!important}`).join('\n')
            }
            const refresh = async () => {
              try { const result = await api('/library/workspaces'); paths = result.paths; update() }
              catch { /* Failure leaves ordinary workspace navigation visible. */ }
            }
            const unsubscribe = ctx.workspaces.list.subscribe(update)
            window.addEventListener('storage', update)
            window.addEventListener('dpr-workspace-visibility', update)
            const timer = setInterval(refresh, 10000)
            void refresh()
            return () => {
              disposed = true; clearInterval(timer); unsubscribe()
              window.removeEventListener('storage', update)
              window.removeEventListener('dpr-workspace-visibility', update)
              css.remove(); document.getElementById('dpr-batch-dialog')?.remove()
            }
          }, 'dsh-paper-reader: workspace display isolation')

          // Guide metadata is drawn by the shipped Start-page EntryBox; no menu DOM interception.
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: 'dpr-library', kind: 'dpr-library', keepMounted: true, title: () => bound('library'),
            guide: [{ id: 'dpr-library-entry', order: 60, title: () => bound('mode'), description: () => bound('library') }],
          }), 'dsh-paper-reader: independent library type')
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: 'dpr-dock-reader', kind: 'dpr-dock-reader', multiple: true, keepMounted: true, title: () => bound('pdfTab'),
          }), 'dsh-paper-reader: independent reading type')
          ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dpr-library', locale: NS }, DockLibraryTab))
          ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dpr-dock-reader', locale: NS }, DockReaderTab))

          // rightbar PDF 页签类型 + 内容
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: 'dpr-reader', kind: 'dpr-reader', keepMounted: true, title: () => bound('pdfTab'),
          }), 'dsh-paper-reader: tab type')
          ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab', key: 'dpr-reader', locale: NS,
          }, PdfTab))

          // 设置面板（设置 → 论文伴读）：Jev 重排 + 翻译端点统一管理
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section', id: 'dsh-paper-reader', order: 70,
            label: () => bound('settings'), locale: NS,
          }, SettingsPanel))

          clientApi = { slots: ctx.slots, layout: ctx.layout, uiWorkspace: ctx.uiWorkspace, sidebarRight: ctx.sidebarRight, workspaces: ctx.workspaces }
          ctx.effect(() => createDprClientInteractions(document, window, {
            toggleChat: () => readingLayout?.toggleChat() || false,
            toggleDock: () => ctx.sidebarRight.toggleExpanded?.(),
            outside: event => { for (const close of [...transientClosers]) close(event) },
          }), 'dsh-paper-reader: shortcuts and iframe outside focus')
          ctx.effect(() => {
            const dockReading = createDprDockReading(ctx.sidebarRight, message => toast(message))
            clientApi.dockReading = dockReading
            return () => { dockReading.dispose(); if (clientApi?.dockReading === dockReading) delete clientApi.dockReading }
          }, 'dsh-paper-reader: independent dock save lifecycle')
          ctx.effect(() => {
            const seat = createDprBareReaderSeat(document, window, clientApi, BarePdfRoot)
            clientApi.readerSeat = seat
            return () => { seat.dispose(); if (clientApi?.readerSeat === seat) delete clientApi.readerSeat }
          }, 'dsh-paper-reader: bare native reading seat')

          // 阅读器跳转链接拦截（capture 阶段，一次绑定）：渲染器给 http(s) 链接加了
          // target=_blank，不拦会新开浏览器标签页 —— 拦下后交给应用内跳转
          if (!window.__dprJumpLinkBound) {
            window.__dprJumpLinkBound = true
            document.addEventListener('click', (e) => {
              const a = e.target?.closest?.('a[href*="/paper-reader/"]')
              if (!a) return
              let url
              try { url = new URL(a.href) } catch { return }
              const page = +(url.searchParams.get('page') || 0)
              if (!page) return
              e.preventDefault()
              e.stopImmediatePropagation()
              void jumpToPaperPage(url.searchParams.get('topic'), url.searchParams.get('name'), page, url.searchParams.get('q') || '', url.searchParams.get('paperId'))
            }, true)
          }

          // 常驻浮层（与模式开关无关）：阅读器 iframe + 对话头部历史/新建按钮组。
          // shell.overlay 是官方钦定的整页浮层自留地（list slot，additive，不遮蔽任何人）。
          // （对话头部按钮不走 slot —— session 作用域 slot 不渲染动态包条目，只能自渲染。）
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay', id: 'dpr-paper-overlays', locale: NS,
          }, function PaperOverlays() {
            return h(React.Fragment, null,
              h(ReaderOverlay, null),
              h(SessionActions, { uiWorkspace: clientApi?.uiWorkspace }),
            )
          }))

          // 与自动化任务等同级的主导航入口；由宿主绘制按钮、文字和折叠态。
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist', id: 'dpr-paper-mode', order: 70,
            label: () => bound('mode'), locale: NS,
          }, PaperModeNav))

          // 上次会话开过伴读模式的话恢复（默认/首次安装 = 关 = 官方侧栏）
          if (paperMode) applyPaperMode(true)
        } catch (e) {
          console.error('[dsh-paper-reader] client apply failed:', e)
        }
      },
    }
  },
})
