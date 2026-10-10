import { Repo, Automerge as A, initializeBase64Wasm } from '@automerge/automerge-repo/slim'
import { automergeWasmBase64 } from '@automerge/automerge/automerge.wasm.base64'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import { sameHeads, author, color } from './graph.js'
import { textEdits, describeEdits } from './changes.js'
import { branchInfo } from './branches.js'
import { commitState, checkpoint, renameCommit, branchFromCommit, mergeBranch, changeOptions } from './versioning.js'
import { currentPassage, applyResolution } from './conflicts.js'
import { ReviewClient } from './review-client.js'
import { watchBranches } from './branch-documents.js'
import { branchHistory } from './branch-history.js'

const $ = id => document.getElementById(id)
const text = $('text'), name = $('name'), graph = $('graph'), tooltip = $('tooltip')
name.value = sessionStorage.getItem('textarea-history-name') || ''
// Guard against a reconnect timeout already scheduled before the user paused.
class PausableSocket extends WebSocketClientAdapter {
  stopped = false
  connect(...args) { if (!this.stopped) super.connect(...args) }
  disconnect() { this.stopped = true; super.disconnect() }
}
try {
  await initializeBase64Wasm(automergeWasmBase64)
  let adapter = new PausableSocket('wss://sync.automerge.org')
  const repo = new Repo({ network: [adapter], storage: new IndexedDBStorageAdapter('textarea-history') })
  let handle = location.hash ? await repo.find(location.hash.slice(1)) : repo.create({ text: '' })
  history.replaceState(null, '', `#${handle.url}`)
  let paused = false, writing = false, composing = false, compositionHeads, compositionContext, selection = null
  const peers = new Map(), branchLanes = new Map()
  const branches = watchBranches(repo, { author: () => username(), onUpdate: () => {
    refresh()
    if (composing || writing) { updateBranchSelect(); renderGraph() }
  } })
  const { documents, loading, unavailable } = branches
  let selectedHash = null, selectedHeads = null
  let displayed = handle.doc()
  const username = () => name.value.trim() || 'Anonymous'
  const userId = sessionStorage.getItem('textarea-history-user-id') || crypto.randomUUID()
  sessionStorage.setItem('textarea-history-user-id', userId)
  const identity = () => ({ author: username(), userId })
  let reviewSession = null, versionBusy = false, renderQueued = false, commitClickTimer = null
  const reviews = new ReviewClient({ onUpdate: () => {
    if (renderQueued) return
    renderQueued = true
    requestAnimationFrame(() => { renderQueued = false; renderIssues(); renderGraph() })
  } })
  const notify = message => { $('version-status').textContent = message }

  const capture = () => {
    if (selectedHash) return
    selection = [text.selectionStart, text.selectionEnd].map(i => A.getCursor(displayed, ['text'], i))
  }
  const sendPresence = () => {
    if (paused || composing || !adapter.remotePeerId || adapter.socket?.readyState !== 1) return
    handle.broadcast({ type: 'cursor', name: username(), cursor: !selectedHash && document.activeElement === text ? A.getCursor(handle.doc(), ['text'], text.selectionEnd) : null })
  }
  function renderCursors() {
    const mirror = $('mirror'), container = $('cursors')
    container.replaceChildren()
    if (selectedHash) return
    mirror.style.width = `${text.clientWidth}px`
    for (const [id, peer] of peers) {
      if (Date.now() - peer.seen > 12000) { peers.delete(id); continue }
      if (!peer.cursor) continue
      try {
        const pos = A.getCursorPosition(displayed, ['text'], peer.cursor)
        const marker = document.createElement('span')
        marker.textContent = '\u200b'
        mirror.replaceChildren(document.createTextNode(text.value.slice(0, pos)), marker, document.createTextNode(text.value.slice(pos) + '\u200b'))
        const caret = document.createElement('div'), label = document.createElement('span')
        caret.className = 'caret'; caret.style.setProperty('--color', color(id))
        caret.style.left = `${marker.offsetLeft - text.scrollLeft}px`
        caret.style.top = `${marker.offsetTop - text.scrollTop}px`
        label.textContent = peer.name; caret.append(label); container.append(caret)
      } catch { /* Presence may arrive before its referenced text change. Retry on change. */ }
    }
  }
  function svg(tag, attrs, content) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value)
    if (content != null) el.textContent = content
    return el
  }
  const element = (tag, content, className) => {
    const node = document.createElement(tag)
    if (content != null) node.textContent = content
    if (className) node.className = className
    return node
  }
  function action(label, callback) {
    const button = element('button', label)
    button.type = 'button'; button.onclick = callback
    return button
  }
  function openCommitSnapshot(docHandle, record) {
    const position = orderedClosed(commitState(docHandle)).findIndex(c => c.id === record.id)
    if (position >= 0) historyPages.set(docHandle.url, Math.floor(position / PAGE_SIZE))
    viewHistory({ url: docHandle.url, hash: record.id, afterHeads: record.snapshotHeads })
  }
  const announced = new Map(), historyPages = new Map(), reviewTargets = new WeakMap()
  const PAGE_SIZE = 20
  function orderedClosed(state) {
    if (state.ordered) return state.ordered
    const depths = new Map()
    const depth = id => {
      if (depths.has(id)) return depths.get(id)
      const record = state.byId.get(id)
      const value = record ? 1 + Math.max(0, ...record.parentIds.map(depth)) : 0
      depths.set(id, value); return value
    }
    return state.ordered = [...state.closed].sort((a, b) => depth(b.id) - depth(a.id) || a.id.localeCompare(b.id))
  }
  function paintBadge(node, result, record) {
    node.hidden = false
    node.className = 'review-badge'
    if (result.status === 'pending') {
      // Keep the card's reserved badge row, but do not announce routine
      // background work or change the card's height while it runs.
      node.classList.add('pending')
      node.textContent = 'Checking review…'
      return
    }
    if (result.status === 'error') { node.classList.add('error'); node.textContent = 'Review unavailable'; return }
    const issues = result.issues
    if (issues.length) {
      node.classList.add('conflict-badge')
      node.textContent = `${issues.some(i => i.kind === 'conflict') ? 'Conflicting' : 'Needs review'} · ${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}${record.open ? '' : ' in this snapshot'}`
    } else node.classList.add('empty')
  }
  const reviewObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting && entry.target.isConnected) {
      const target = reviewTargets.get(entry.target)
      if (!target) continue
      const result = reviews.get(target.handle, target.record.snapshotHeads, { persist: !target.record.open, live: target.record.open })
      paintBadge(entry.target, result, target.record)
      if (result.status !== 'pending') reviewObserver.unobserve(entry.target)
    }
  }, { root: $('history'), rootMargin: '200px' })
  function renderGraph() {
    graph.hidden = false
    graph.style.display = 'block'
    $('commits').hidden = true
    renderCommitTrainlines()
    const chosen = $('merge-source').value
    $('merge-source').replaceChildren(...[...documents.values()].filter(d => d.url !== handle.url).map(d => {
      const option = element('option', `${branchInfo(d)?.name || 'Main'} · ${d.documentId.slice(0, 5)}`)
      option.value = d.url; return option
    }))
    if ([...$('merge-source').options].some(o => o.value === chosen)) $('merge-source').value = chosen
    $('merge').disabled = versionBusy || Boolean(selectedHash) || composing || !$('merge-source').options.length
    renderIssues()
  }
  function renderCommits() {
    const focused = document.activeElement?.dataset.commitFocus
    const expanded = new Set([...$('commits').querySelectorAll('details[open][data-commit-details]')].map(n => n.dataset.commitDetails))
    reviewObserver.disconnect()
    $('commits').replaceChildren()
    for (const docHandle of documents.values()) {
      const state = commitState(docHandle), name = branchInfo(docHandle)?.name || 'Main'
      const ids = new Set(state.closed.map(c => c.id)), previous = announced.get(docHandle.url)
      if (previous && docHandle.url === handle.url) {
        const fresh = state.closed.filter(c => !previous.has(c.id))
        if (fresh.length) notify(`${fresh.at(-1).closedBy} created checkpoint “${fresh.at(-1).title}”. Editing continues in the open commit.`)
      }
      announced.set(docHandle.url, ids)
      const section = element('section', null, 'branch-commits')
      section.append(element('h3', `${name}${docHandle.url === handle.url ? ' · current branch' : ''}`))
      const ordered = orderedClosed(state)
      const page = Math.min(historyPages.get(docHandle.url) || 0, Math.max(0, Math.ceil(ordered.length / PAGE_SIZE) - 1))
      historyPages.set(docHandle.url, page)
      if (ordered.length > PAGE_SIZE) {
        const controls = element('div', null, 'history-pages')
        const newer = action('Newer', () => { historyPages.set(docHandle.url, page - 1); renderGraph() })
        const older = action('Older', () => { historyPages.set(docHandle.url, page + 1); renderGraph() })
        newer.disabled = page === 0; older.disabled = (page + 1) * PAGE_SIZE >= ordered.length
        controls.append(newer, element('span', `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, ordered.length)} of ${ordered.length}`), older)
        section.append(controls)
      }
      for (const record of [state.open, ...ordered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)]) {
        const card = element('article', null, `commit-card${record.open ? ' open' : ''}${selectedHash === record.id && handle.url === docHandle.url ? ' selected' : ''}`)
        const title = action(record.open ? 'Open commit' : `${record.title} · Closed`, () => record.open ? switchBranch(docHandle.url) : openCommitSnapshot(docHandle, record))
        title.dataset.commitFocus = `${docHandle.url}/${record.id}`
        card.append(title)
        const summary = record.contributors.map(p => `${p.count} ${p.count === 1 ? 'edit' : 'edits'} from ${p.name}`).join(' · ')
        card.append(element('p', summary || (record.open ? 'No new edits yet' : 'No content edits')))
        if (!record.open) card.append(element('p', `Checkpoint by ${record.closedBy} · ${new Date(record.closedAt).toLocaleString()}`, 'hint'))
        if (record.lateEdits.length) card.append(element('p', `${record.lateEdits.length} edits arrived from an earlier editing context`, 'hint'))
        if (record.parentIds.length) {
          const parents = element('div', null, 'parent-links')
          parents.append(element('span', record.parentIds.length > 1 ? 'Combined parents: ' : 'Parent: '))
          for (const id of record.parentIds) {
            const parent = state.byId.get(id)
            if (parent) parents.append(action(parent.title, () => {
              const owner = documents.get(parent.branchUrl) || docHandle
              openCommitSnapshot(owner, parent)
            }))
          }
          card.append(parents)
        }
        const badge = element('p', 'Checking review…', 'review-badge pending')
        reviewTargets.set(badge, { handle: docHandle, record }); reviewObserver.observe(badge)
        card.append(badge)
        const details = element('details'), summaryEl = element('summary', 'Net changes and individual edits')
        details.dataset.commitDetails = `${docHandle.url}/${record.id}`
        details.append(summaryEl)
        // Compute diffs and drill-down only when expanded.
        details.ontoggle = () => {
          if (!details.open || details.childElementCount > 1) return
          details.append(element('pre', describeEdits(textEdits(state.doc, record))))
          if (record.parentIds.length > 1) {
            for (const id of record.parentIds) {
              const parent = state.byId.get(id)
              if (!parent) continue
              details.append(element('p', `Compared with “${parent.title}”`), element('pre', describeEdits(textEdits(state.doc, { beforeHeads: parent.snapshotHeads, afterHeads: record.snapshotHeads }))))
            }
          }
          for (const edit of record.edits) {
            const item = element('details'), label = element('summary', `${author(edit)} · ${new Date(edit.time * 1000).toLocaleString()}`)
            item.append(label, element('pre', describeEdits(textEdits(state.doc, edit))))
            details.append(item)
          }
        }
        details.open = expanded.has(details.dataset.commitDetails)
        card.append(details); section.append(card)
      }
      $('commits').append(section)
    }
    if (focused) [...$('commits').querySelectorAll('[data-commit-focus]')].find(n => n.dataset.commitFocus === focused)?.focus({ preventScroll: true })
  }
  function closeReview() {
    reviewSession = null
    $('review-panel').hidden = true
  }
  function beginReview(issue, heads) {
    if (selectedHash) return
    if (!sameHeads(heads, A.getHeads(handle.doc()))) { notify('The passage changed. Wait for its updated review.'); return }
    reviewSession = { issue, heads: A.getHeads(handle.doc()), url: handle.url }
    $('review-title').textContent = issue.title
    $('review-description').textContent = issue.kind === 'review'
      ? `${issue.editCount} edits grouped into one passage. Choose an editor’s latest version or edit the result; one approval resolves this batch.`
      : 'Choose a value or edit the result. Applying records a new edit and preserves history.'
    const current = currentPassage(handle.doc(), issue), fullText = handle.doc().text || ''
    const before = [...fullText.slice(0, current.start).split('\n').at(-1)].slice(-60).join('')
    const after = [...fullText.slice(current.end).split('\n')[0]].slice(0, 60).join('')
    const preview = (node, value) => node.replaceChildren(
      element('span', before, 'review-context'), element('mark', value || '(empty)'), element('span', after, 'review-context'))
    preview($('review-base'), issue.base)
    preview($('review-current'), current.text)
    $('review-result').value = current.text
    $('review-choices').replaceChildren()
    for (const choice of issue.choices) {
      const container = element('div'), textPreview = element('pre')
      preview(textPreview, choice.text)
      container.append(textPreview, action(choice.label, () => { $('review-result').value = choice.text }))
      $('review-choices').append(container)
    }
    $('review-message').textContent = ''
    $('review-panel').hidden = false
    $('review-result').focus()
  }
  let displayedIssueContext = null
  function renderIssues() {
    const container = $('issues')
    const heads = selectedHeads || A.getHeads(handle.doc())
    const result = reviews.get(handle, heads, { persist: Boolean(selectedHash && commitState(handle).byId.has(selectedHash)), live: !selectedHash })
    const pending = result.status === 'pending'
    $('review-progress').style.visibility = pending ? 'visible' : 'hidden'
    const context = `${handle.url}/${selectedHash || 'live'}`
    // Keep the last findings in place while refreshing the same view. Their
    // actions must wait for fresh heads before opening a resolution.
    if (!pending || context !== displayedIssueContext) container.replaceChildren()
    displayedIssueContext = context
    for (const button of container.querySelectorAll('button')) button.disabled = pending
    if (result.status === 'error') {
      container.append(element('p', `Review unavailable: ${result.error}`, 'hint'), action('Retry review', () => {
        if (reviews.failure) location.reload(); else reviews.retry(heads)
      }))
    }
    for (const issue of pending ? [] : result.issues || []) {
      const row = element('div', null, 'issue')
      row.append(element('span', `${issue.kind === 'conflict' ? 'Conflict' : 'Needs review'}: ${issue.title} `))
      if (!selectedHash) row.append(action(issue.kind === 'review' ? 'Review passage' : 'Review', () => beginReview(issue, result.heads)))
      else row.append(element('span', 'Historical snapshot — return to live to resolve.', 'hint'))
      container.append(row)
    }
    if (reviewSession && (selectedHash || reviewSession.url !== handle.url)) closeReview()
    if (reviewSession && !sameHeads(reviewSession.heads, A.getHeads(handle.doc()))) {
      $('review-message').textContent = 'The document changed. Reopen Review to refresh the passage before applying.'
      $('review-apply').disabled = true
    } else $('review-apply').disabled = false
  }
  $('review-cancel').onclick = closeReview
  $('review-apply').onclick = () => {
    if (!reviewSession) return
    try {
      applyResolution(handle, reviewSession.issue, $('review-result').value, identity(), reviewSession.heads, commitState(handle).open.id)
      closeReview(); refresh(); notify('Resolution recorded as a new edit.')
    } catch (error) { $('review-message').textContent = error.message }
  }
  function renderCommitTrainlines() {
    const nodes = [], edges = [], byId = new Map()
    for (const docHandle of documents.values()) {
      if (!branchLanes.has(docHandle.url)) branchLanes.set(docHandle.url, branchLanes.size)
      const state = commitState(docHandle), branchName = branchInfo(docHandle)?.name || 'Main'
      const lane = branchLanes.get(docHandle.url)
      const records = [state.open, ...state.closed]
      for (const record of records) {
        const id = `${docHandle.url}/${record.id}`
        const node = { ...record, nodeId: id, url: docHandle.url, handle: docHandle, doc: state.doc, lane, branchName,
          time: record.open ? Number.MAX_SAFE_INTEGER : record.closedAt || 0 }
        nodes.push(node); byId.set(record.id, node)
      }
    }
    for (const node of nodes) for (const parentId of node.parentIds || []) {
      const parent = byId.get(parentId)
      if (parent) edges.push({ from: node.nodeId, to: parent.nodeId })
    }
    nodes.sort((a, b) => b.time - a.time || a.branchName.localeCompare(b.branchName) || a.id.localeCompare(b.id))
    nodes.forEach((node, row) => { node.row = row })
    const byNodeId = new Map(nodes.map(n => [n.nodeId, n]))
    const x = n => 20 + n.lane * 22, y = n => 24 + n.row * 42
    const labelX = 44 + Math.max(0, branchLanes.size - 1) * 22, width = labelX + 320
    const height = Math.max(64, 24 + nodes.length * 42)
    graph.setAttribute('width', width); graph.setAttribute('height', height)
    graph.replaceChildren()
    for (const edge of edges) {
      const from = byNodeId.get(edge.from), to = byNodeId.get(edge.to)
      if (!from || !to) continue
      const bend = Math.max(y(from), y(to) - 30)
      graph.append(svg('path', { d: `M${x(from)},${y(from)} L${x(from)},${bend} C${x(from)},${y(to)} ${x(to)},${bend} ${x(to)},${y(to)}`,
        fill: 'none', stroke: color(from.url), 'stroke-width': 2 }))
    }
    for (const node of nodes) {
      const selected = !node.open && selectedHash === node.id && handle.url === node.url
      const contributors = node.contributors.map(p => `${p.count} ${p.count === 1 ? 'edit' : 'edits'} from ${p.name}`).join(' · ')
      const label = node.open ? `${node.branchName} · open commit` : `${node.branchName} · ${node.title}`
      const sublabel = contributors || (node.open ? 'No new edits yet' : 'No content edits')
      const group = svg('g', { tabindex: 0, role: 'button', 'aria-pressed': String(selected), 'data-commit': node.id, 'data-document': node.url,
        'aria-label': `${label}\n${sublabel}` })
      group.append(svg('rect', { x: 4, y: y(node) - 17, width: width - 8, height: 34, rx: 5,
        fill: selected ? '#fff0c2' : node.open && node.url === handle.url ? '#e9eef3' : 'transparent', stroke: selected ? '#b68118' : 'none' }))
      group.append(svg('circle', { cx: x(node), cy: y(node), r: node.open ? 8 : 5, fill: node.open ? 'white' : color(node.url), stroke: color(node.url), 'stroke-width': 2 }))
      group.append(svg('text', { x: labelX, y: y(node) - 2 }, label.length > 36 ? label.slice(0, 35) + '…' : label))
      group.append(svg('text', { x: labelX, y: y(node) + 13 }, sublabel.length > 42 ? sublabel.slice(0, 41) + '…' : sublabel))
      const branchLink = svg('text', { x: width - 76, y: y(node) + 4, fill: '#34745b', style: 'opacity:0; cursor:pointer; font-weight:600' }, '+ branch')
      branchLink.onclick = event => { event.preventDefault(); event.stopPropagation(); createBranchFromCommitNode(node) }
      branchLink.ondblclick = event => { event.preventDefault(); event.stopPropagation() }
      group.append(branchLink)
      const showBranchLink = () => { branchLink.style.opacity = '1' }
      const hideBranchLink = () => { branchLink.style.opacity = '0' }
      group.onmouseenter = group.onfocus = showBranchLink
      group.onmouseleave = group.onblur = hideBranchLink
      const activate = () => node.open ? switchBranch(node.url) : openCommitSnapshot(node.handle, node)
      const editName = () => {
        if (composing || versionBusy || selectedHash) return
        const foreign = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject')
        foreign.setAttribute('x', labelX); foreign.setAttribute('y', y(node) - 17)
        foreign.setAttribute('width', width - labelX - 8); foreign.setAttribute('height', 32)
        const input = document.createElement('input')
        input.value = node.open ? '' : node.title
        input.placeholder = node.open ? 'Name checkpoint' : 'Checkpoint name'
        input.maxLength = 120
        input.style.width = '100%'; input.style.height = '28px'; input.style.padding = '3px 6px'
        foreign.append(input); graph.append(foreign)
        input.focus(); input.select()
        let saved = false
        const save = async apply => {
          if (saved) return
          saved = true; foreign.remove()
          const title = input.value.trim()
          if (!apply || (!node.open && title === node.title) || (node.open && !title)) return
          versionBusy = true; refresh()
          try {
            if (node.open) {
              const record = checkpoint(node.handle, title, identity(), { force: true })
              await repo.flush([node.handle.documentId])
              notify(`Created checkpoint “${record.title}”. Everyone continues in the next open commit.`)
            } else {
              renameCommit(node.handle, node, title, identity())
              await repo.flush([node.handle.documentId])
              notify(`Renamed checkpoint to “${title}”.`)
            }
          } catch (error) { notify(`Could not save checkpoint name: ${error.message}`) }
          finally { versionBusy = false; refresh() }
        }
        input.onclick = input.ondblclick = event => event.stopPropagation()
        input.onkeydown = event => {
          if (event.key === 'Enter') { event.preventDefault(); save(true) }
          if (event.key === 'Escape') { event.preventDefault(); save(false) }
        }
        input.onblur = () => save(true)
      }
      group.onclick = () => {
        clearTimeout(commitClickTimer)
        commitClickTimer = setTimeout(activate, 180)
      }
      group.ondblclick = event => {
        event.preventDefault(); event.stopPropagation(); clearTimeout(commitClickTimer); editName()
      }
      group.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }; if (e.key === 'F2') { e.preventDefault(); editName() } }
      graph.append(group)
    }
  }
  function renderActivityGraph() {
    tooltip.hidden = true
    return renderCommitTrainlines()
    const { nodes, edges } = branchHistory([...documents.values()], {
      grouped: false, selected: selectedHash, lanes: branchLanes,
    })
    const badges = new Map()
    for (const node of nodes.filter(n => n.anchor)) {
      if (!badges.has(node.row)) badges.set(node.row, [])
      badges.get(node.row).push(node)
    }
    const rowY = new Map()
    let height = 24
    for (const row of [...new Set(nodes.map(n => n.row))].sort((a, b) => a - b)) {
      rowY.set(row, height)
      height += 40 + (badges.get(row)?.length || 0) * 24
    }
    const x = n => 20 + n.lane * 20, y = n => rowY.get(n.row)
    const labelX = 40 + Math.max(0, branchLanes.size - 1) * 20, width = labelX + 240
    graph.setAttribute('width', width); graph.setAttribute('height', height)
    graph.replaceChildren()
    const byId = new Map(nodes.map(n => [n.id, n]))
    for (const edge of edges) {
      const from = byId.get(edge.from), to = byId.get(edge.to)
      const bend = Math.max(y(from), y(to) - 28)
      graph.append(svg('path', { d: `M${x(from)},${y(from)} L${x(from)},${bend} C${x(from)},${y(to)} ${x(to)},${bend} ${x(to)},${y(to)}`,
        fill: 'none', stroke: color(from.type === 'fork' ? from.branchUrl : from.url), 'stroke-width': 2 }))
    }
    for (const node of nodes) {
      if (node.type !== 'edit') {
        const forkSelected = node.type === 'fork' && selectedHash && handle.url === node.url && sameHeads(selectedHeads, node.afterHeads)
        const badge = Boolean(node.anchor)
        const badgeY = y(node) + 32 + (badges.get(node.row)?.indexOf(node) || 0) * 24
        const label = badge ? node.name : node.label
        const group = svg('g', { tabindex: 0, role: 'button', 'aria-pressed': String(Boolean(forkSelected)), 'data-branch': node.branchUrl || node.url, 'data-kind': node.type, 'aria-label': badge ? `${node.name} · view starting snapshot` : node.label })
        group.append(svg('title', {}, `${node.name}${badge ? ' · view starting snapshot' : ''}`))
        group.append(svg('rect', { x: badge ? labelX : 4, y: badge ? badgeY - 14 : y(node) - 17, width: badge ? Math.min(230, label.length * 8 + 20) : width - 8, height: badge ? 22 : 34, rx: 5,
          stroke: badge ? color(node.branchUrl) : 'none',
          fill: forkSelected ? '#fff0c2' : node.type === 'tip' && node.url === handle.url ? '#e9eef3' : 'transparent' }))
        if (!badge) group.append(svg('circle', { cx: x(node), cy: y(node), r: node.type === 'tip' ? 8 : 5,
          fill: 'white', stroke: color(node.branchUrl || node.url), 'stroke-width': 2 }))
        group.append(svg('text', { x: labelX + (badge ? 8 : 0), y: badge ? badgeY + 1 : y(node) + 4 }, label.length > 27 ? label.slice(0, 26) + '…' : label))
        const activate = () => {
          if (node.type === 'tip') switchBranch(node.url)
          else viewHistory({ ...node, url: documents.has(node.url) ? node.url : node.branchUrl,
            hash: node.afterHeads.at(-1), snapshot: true })
        }
        group.onclick = activate
        group.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate() } }
        graph.append(group)
        continue
      }
      const doc = node.doc
      const selected = handle.url === node.url && selectedHash === node.hash && sameHeads(selectedHeads, node.afterHeads)
      const first = node.changes[0]
      const timestamp = change => change.time ? new Date(change.time * 1000).toISOString() : 'Not recorded'
      const times = node.changes.length === 1 ? `Time: ${timestamp(node)}` : `Started: ${timestamp(first)}\nEnded: ${timestamp(node)}`
      const sequence = first.seq === node.seq ? node.seq : `${first.seq}–${node.seq}`
      const metadata = `${times}\nAuthor: ${author(node)}\nActor ID: ${node.actor}\nSequence: ${sequence}`
      const count = node.changes.length
      const summary = `${author(node)} edited · ${count} ${count === 1 ? 'change' : 'changes'}`
      const group = svg('g', { tabindex: 0, role: 'button', 'data-hash': node.hash, 'data-document': node.url, 'aria-label': summary + '\n' + metadata, 'aria-pressed': String(selected) })
      group.append(svg('rect', { x: 4, y: y(node) - 17, width: width - 8, height: 34, rx: 5, fill: selected ? '#fff0c2' : 'transparent', stroke: selected ? '#b68118' : 'none' }))
      group.append(svg('circle', { cx: x(node), cy: y(node), r: 5, fill: color(node.url) }))
      group.append(svg('text', { x: labelX, y: y(node) + 4 }, node.kind === 'branch-create' ? `Created ${node.name.slice(0, 20)}` : `${node.name.slice(0, 12)} · ${author(node).slice(0, 12)} · ${count} ${count === 1 ? 'edit' : 'edits'}`))
      let details
      const show = event => {
        details ??= `Net text edits\n${describeEdits(textEdits(doc, node))}\n\n${metadata}`
        tooltip.textContent = details; tooltip.hidden = false
        group.setAttribute('aria-label', details)
        const rect = group.getBoundingClientRect()
        const left = event.clientX ?? rect.left, top = event.clientY ?? rect.bottom
        tooltip.style.left = `${Math.max(4, Math.min(left + 12, innerWidth - tooltip.offsetWidth - 8))}px`
        tooltip.style.top = `${Math.max(4, Math.min(top + 12, innerHeight - tooltip.offsetHeight - 8))}px`
      }
      group.onmouseenter = show; group.onfocus = show
      group.onmouseleave = group.onblur = () => { tooltip.hidden = true }
      group.onclick = () => viewHistory(node)
      group.onkeydown = e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); viewHistory(node) }
        if (e.key === 'Escape') tooltip.hidden = true
      }
      graph.append(group)
    }
  }
  function viewHistory(node) {
    if (composing) return
    if (node.url !== handle.url) activateHandle(documents.get(node.url))
    if (!selectedHash) capture()
    selectedHash = node.hash
    selectedHeads = [...node.afterHeads]
    refresh(); sendPresence()
    // Keep keyboard navigation on the chosen change after rebuilding the graph.
    graph.querySelector(`[data-hash="${node.hash}"]`)?.focus({ preventScroll: true })
    tooltip.hidden = true
  }
  function live() {
    selectedHash = null; selectedHeads = null
    refresh(); text.focus(); sendPresence()
  }
  function activateHandle(next) {
    if (!next || composing) return
    if (!paused && adapter.remotePeerId && adapter.socket?.readyState === 1) handle.broadcast({ type: 'cursor', name: username(), cursor: null })
    handle.off('ephemeral-message', receivePresence)
    handle = next
    handle.on('ephemeral-message', receivePresence)
    selectedHash = null; selectedHeads = null; selection = null; compositionHeads = null; compositionContext = null
    peers.clear()
    closeReview()
    history.replaceState(null, '', `#${handle.url}`)
    displayed = handle.doc()
    text.value = displayed.text || ''
  }
  function switchBranch(url) {
    if (composing) return
    activateHandle(documents.get(url))
    refresh(); text.focus(); sendPresence()
  }
  $('branch-select').onchange = event => switchBranch(event.target.value)
  function updateBranchSelect() {
    const options = [...documents.values()].map(doc => {
      const option = document.createElement('option')
      option.value = doc.url
      option.textContent = `${branchInfo(doc)?.name || 'Main'} · open commit`
      return option
    })
    const existing = [...$('branch-select').options]
    if (existing.length !== options.length || existing.some((option, i) => option.value !== options[i].value || option.textContent !== options[i].textContent)) {
      $('branch-select').replaceChildren(...options)
    }
    $('branch-select').value = handle.url
    $('branch-status').textContent = unavailable.size ? `${unavailable.size} branch document(s) unavailable · retrying` : loading.size ? 'Loading branches…' : ''
  }
  async function createBranchFromCommitNode(node) {
    if (composing || versionBusy) return
    const name = prompt('Branch name', 'Alternative')?.trim()
    if (!name) return
    versionBusy = true; refresh()
    try {
      const record = node.open ? null : commitState(node.handle).byId.get(node.id)
      if (!node.open && !record) throw new Error('Choose a closed commit to branch from')
      const branch = branchFromCommit(repo, node.handle, record, name, identity())
      await repo.flush([branch.documentId, node.handle.documentId])
      branches.watch(branch)
      activateHandle(branch)
      refresh(); text.focus(); sendPresence()
      notify('Branch created. Collaborators remain on the source branch.')
    } catch (error) { notify(`Could not create branch: ${error.message}`) }
    finally { versionBusy = false; refresh() }
  }
  $('merge').onclick = async () => {
    if (composing || selectedHash || versionBusy) return
    versionBusy = true; refresh()
    try {
      const source = documents.get($('merge-source').value)
      if (!source) return
      const result = mergeBranch(handle, source, identity())
      await repo.flush([handle.documentId, source.documentId])
      notify(result ? 'Merged the captured source checkpoint into this open commit. Review the result, then create a checkpoint.' : 'All source edits are already included.')
      refresh()
    } catch (error) { notify(`Could not merge: ${error.message}`) }
    finally { versionBusy = false; refresh() }
  }
  $('live').onclick = live
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      tooltip.hidden = true
      if (selectedHash) { event.preventDefault(); live() }
    }
  })
  function refresh() {
    if (composing || writing) return
    displayed = selectedHash ? A.view(handle.doc(), selectedHeads) : handle.doc()
    text.readOnly = Boolean(selectedHash)
    $('history-mode').hidden = !selectedHash
    $('editor').classList.toggle('history', Boolean(selectedHash))
    $('mode-detail').textContent = selectedHash ? `Read-only · Esc returns to live` : ''
    const direction = text.selectionDirection
    text.value = displayed.text || ''
    if (!selectedHash && selection) {
      try { text.setSelectionRange(...selection.map(c => A.getCursorPosition(displayed, ['text'], c)), direction) } catch { /* Initial selection. */ }
    }
    capture(); renderCursors(); updateBranchSelect(); renderGraph()
  }
  function edit() {
    if (composing || selectedHash) return
    writing = true
    const value = text.value, start = text.selectionStart, end = text.selectionEnd
    const options = changeOptions(identity(), { kind: 'edit', openCommitId: compositionContext || commitState(handle).open.id })
    try {
      if (compositionHeads) {
        // Apply composition to the version it started from, preserving intervening remote edits.
        const heads = handle.changeAt(compositionHeads, d => A.updateText(d, ['text'], value), options)
        if (heads) {
          const local = handle.view(heads).doc()
          selection = [start, end].map(i => A.getCursor(local, ['text'], i))
        }
        compositionHeads = null; compositionContext = null
      } else {
        handle.change(d => A.updateText(d, ['text'], value), options)
        displayed = handle.doc()
        selection = [start, end].map(i => A.getCursor(displayed, ['text'], i))
      }
    } finally { writing = false }
    refresh(); sendPresence()
  }
  text.oninput = edit
  text.addEventListener('compositionstart', () => { if (selectedHash) return; composing = true; compositionHeads = handle.heads(); compositionContext = commitState(handle).open.id })
  text.addEventListener('compositionend', () => { composing = false; edit() })
  text.addEventListener('select', () => { if (!composing) { capture(); sendPresence() } })
  for (const event of ['keyup', 'click', 'focus', 'blur']) text.addEventListener(event, () => { if (!composing) { capture(); sendPresence() } })
  text.onscroll = renderCursors
  new ResizeObserver(renderCursors).observe(text)
  name.oninput = () => { sessionStorage.setItem('textarea-history-name', name.value); sendPresence() }
  function receivePresence({ senderId, message }) {
    if (paused || message?.type !== 'cursor' || typeof message.name !== 'string' || (message.cursor !== null && typeof message.cursor !== 'string')) return
    peers.set(senderId, { name: message.name.slice(0, 60), cursor: message.cursor, seen: Date.now() }); renderCursors()
  }
  handle.on('ephemeral-message', receivePresence)
  $('pause').onclick = () => {
    paused = !paused
    if (paused) { repo.networkSubsystem.removeNetworkAdapter(adapter); peers.clear(); renderCursors() }
    else { adapter = new PausableSocket('wss://sync.automerge.org'); repo.networkSubsystem.addNetworkAdapter(adapter) }
    $('pause').textContent = paused ? 'Resume sync' : 'Pause sync'
    $('pause').setAttribute('aria-pressed', String(paused)); status()
  }
  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); $('status').textContent = 'Link copied' }
    catch { $('status').textContent = 'Copy the address bar URL to share' }
  }
  function status() { $('status').textContent = paused ? 'Sync paused · edits stay local' : adapter.socket?.readyState === 1 && adapter.remotePeerId ? 'Connected to sync.automerge.org' : 'Disconnected · retrying' }
  repo.networkSubsystem.on('peer', status)
  repo.networkSubsystem.on('peer-disconnected', status)
  setInterval(() => {
    status(); sendPresence(); renderCursors()
    if (!paused) branches.retry()
  }, 3000)
  text.disabled = $('pause').disabled = $('copy').disabled = false
  branches.watch(handle)
  refresh(); status()
} catch (error) { $('status').textContent = `Could not open document: ${error.message}` }
window.addEventListener('hashchange', () => location.reload())
