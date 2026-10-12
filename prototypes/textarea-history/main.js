import { Repo, Automerge as A, initializeBase64Wasm } from '@automerge/automerge-repo/slim'
import { automergeWasmBase64 } from '@automerge/automerge/automerge.wasm.base64'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import { sameHeads, author, color } from './graph.js'
import { textEdits, describeEdits } from './changes.js'
import { branchInfo, branchName, branchRemoved, renameBranch, renameBranchLink, removeBranchOpenCommit } from './branches.js'
import { commitState, checkpoint, renameCommit, branchFromCommit, mergeBranch, mergeCommit, recordMergeReview, mergeReviewRecords, resolutionRecords, changeOptions } from './versioning.js'
import { currentPassage, applyResolution, applyStoredResolution, reviewIssues } from './conflicts.js'
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
  let reviewSession = null, versionBusy = false, renderQueued = false, commitClickTimer = null, draggedCommitNode = null
  let pointerCommitDrag = null, suppressCommitClick = false, visibleCommitNodes = new Map(), dragTargetNodeId = null
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
  let assistantMessage = null, assistantMuted = false, assistantFlashTimer = null
  function renderAssistantMessage(summary, thoughts, feedback) {
    $('assistant-summary').textContent = summary || 'Waiting for assistant…'
    const node = $('assistant-thoughts')
    node.replaceChildren()
    if (Array.isArray(thoughts)) thoughts = thoughts.join('\n')
    if (thoughts) node.append(document.createTextNode(String(thoughts)))
    if (feedback) {
      if (thoughts) node.append(document.createTextNode(' '))
      const link = document.createElement('a')
      link.href = '#assistant-feedback'
      link.textContent = feedback
      node.append(link)
    }
  }
  function renderAssistant() {
    $('assistant-toggle').textContent = assistantMuted ? 'Resume assistant' : 'Mute assistant'
    $('assistant-toggle').setAttribute('aria-pressed', String(assistantMuted))
    if (assistantMuted) renderAssistantMessage('Assistant muted.', 'The local UI asked the agent to pause riffs and cursor/status updates.')
    else if (assistantMessage && Date.now() - assistantMessage.seen < 30000) {
      renderAssistantMessage(assistantMessage.summary, assistantMessage.thoughts, assistantMessage.feedback)
    } else renderAssistantMessage('Waiting for assistant…', '')
  }
  function flashAssistantUpdate() {
    const editor = $('editor')
    editor.classList.add('assistant-updated')
    clearTimeout(assistantFlashTimer)
    assistantFlashTimer = setTimeout(() => editor.classList.remove('assistant-updated'), 1700)
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
        caret.className = `caret${peer.role === 'agent' ? ' agent' : ''}`; caret.style.setProperty('--color', peer.role === 'agent' ? '#7c3aed' : color(id))
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
  function setCommitDragHighlight(sourceId, targetId = null) {
    for (const group of graph.querySelectorAll('g[data-node-id]')) {
      group.classList.toggle('drag-source', group.dataset.nodeId === sourceId)
      group.classList.toggle('drop-target', Boolean(targetId) && group.dataset.nodeId === targetId)
    }
    dragTargetNodeId = targetId
  }
  function clearCommitDragHighlight() {
    for (const group of graph.querySelectorAll('g.drag-source, g.drop-target')) group.classList.remove('drag-source', 'drop-target')
    dragTargetNodeId = null
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
      const option = element('option', `${branchName(d)} · ${d.documentId.slice(0, 5)}`)
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
      const state = commitState(docHandle), name = branchName(docHandle)
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
  function storedMergeIssues(doc) {
    return reviewIssues(doc).map(issue => {
      const current = currentPassage(doc, issue)
      return { id: issue.id, kind: issue.kind, title: issue.title, base: issue.base || '', current: current.text,
        startCursor: issue.startCursor, endCursor: issue.endCursor, batches: issue.batches || [], choices: issue.choices || [] }
    })
  }
  function mergeConflictView(current, choices, { actions = true } = {}) {
    const container = element('div')
    for (const choice of choices) {
      const block = element('div', null, 'merge-conflict')
      block.append(
        element('span', '<<<<<<< Current document', 'merge-line merge-marker'),
        element('span', current || '(empty)', 'merge-line merge-current'),
        element('span', '=======', 'merge-line merge-marker'),
        element('span', choice.text || '(empty)', 'merge-line merge-choice'),
        element('span', `>>>>>>> ${choice.label.replace(/^Use\s+/, '')}`, 'merge-line merge-marker'),
      )
      if (actions) {
        const controls = element('div', null, 'merge-actions')
        controls.append(action('Use current side', () => { $('review-result').value = current }),
          action(choice.label, () => { $('review-result').value = choice.text }))
        block.append(controls)
      }
      container.append(block)
    }
    return container
  }
  function beginReview(issue, heads) {
    if (selectedHash) return
    if (!sameHeads(heads, A.getHeads(handle.doc()))) { notify('The passage changed. Wait for its updated review.'); return }
    reviewSession = { issue, heads: A.getHeads(handle.doc()), url: handle.url }
    $('review-title').textContent = issue.title
    $('review-description').textContent = issue.kind === 'review'
      ? `${issue.editCount} edits overlap in one passage. Resolve the merge conflict by choosing a side or editing the final result.`
      : 'Resolve the text conflict by choosing a side or editing the final result.'
    const current = currentPassage(handle.doc(), issue), fullText = handle.doc().text || ''
    const before = [...fullText.slice(0, current.start).split('\n').at(-1)].slice(-60).join('')
    const after = [...fullText.slice(current.end).split('\n')[0]].slice(0, 60).join('')
    const preview = (node, value) => node.replaceChildren(
      element('span', before, 'review-context'), element('mark', value || '(empty)'), element('span', after, 'review-context'))
    preview($('review-base'), issue.base)
    preview($('review-current'), current.text)
    $('review-result').value = current.text
    $('review-choices').replaceChildren(mergeConflictView(current.text, issue.choices))
    $('review-message').textContent = ''
    $('review-panel').hidden = false
    $('review-result').focus()
  }
  let displayedIssueContext = null
  function patchView(edits) {
    const patch = element('div', null, 'patch')
    if (!edits.length) {
      patch.append(element('div', ' No text changes', 'patch-line'))
      return patch
    }
    for (const edit of edits) {
      const line = element('div', null, `patch-line ${edit.kind}`)
      const sign = element('span', edit.kind === 'inserted' ? '+' : '−', 'patch-sign')
      const textNode = element('span', edit.text || '(empty)')
      line.append(sign, textNode)
      patch.append(line)
    }
    return patch
  }
  function reapplyStoredResolution(issue, value) {
    try {
      selectedHash = null; selectedHeads = null
      applyStoredResolution(handle, issue, value, identity(), commitState(handle).open.id)
      refresh(); notify('Recorded a new resolution edit from the stored merge conflict.')
    } catch (error) { notify(`Could not apply stored resolution: ${error.message}`) }
  }
  function renderCommitDetail() {
    const workspace = $('workspace'), panel = $('commit-detail-panel')
    const state = commitState(handle)
    const record = selectedHash ? state.closed.find(commit => commit.id === selectedHash) : null
    workspace.classList.toggle('detail-open', Boolean(record))
    panel.replaceChildren()
    if (!record) return
    const title = element('h3', record.title || 'Checkpoint')
    const branch = element('p', `${branchName(handle)} · closed commit`, 'hint')
    const meta = element('dl')
    const addMeta = (name, value) => {
      const dt = element('dt', name), dd = element('dd', value)
      meta.append(dt, dd)
    }
    addMeta('Checkpoint by', record.closedBy || 'Unknown')
    addMeta('Closed', record.closedAt ? new Date(record.closedAt).toLocaleString() : 'Unknown')
    addMeta('Edits', `${record.edits?.length || 0}`)
    addMeta('Contributors', record.contributors?.map(p => `${p.name} (${p.count})`).join(', ') || 'None')
    if (record.parentIds.length) addMeta('Parents', record.parentIds.map(id => state.byId.get(id)?.title || id.slice(0, 7)).join(', '))
    const diffTitle = element('h4', 'Introduced changes')
    panel.append(title, branch, meta, diffTitle, patchView(textEdits(state.doc, record)))
    if (record.parentIds.length > 1) {
      panel.append(element('h4', 'Compared with each parent'))
      for (const id of record.parentIds) {
        const parent = state.byId.get(id)
        if (!parent) continue
        panel.append(element('p', `Compared with “${parent.title}”`, 'hint'),
          patchView(textEdits(state.doc, { beforeHeads: parent.snapshotHeads, afterHeads: record.snapshotHeads })))
      }
    }
    const mergeReviews = mergeReviewRecords(state.doc).filter(review => (record.mergeIds || []).includes(review.id))
    const resolutions = resolutionRecords(state.doc)
    if (mergeReviews.length) {
      panel.append(element('h4', 'Recorded merge conflicts'))
      for (const review of mergeReviews) for (const issue of review.issues || []) {
        const resolved = resolutions.filter(r => r.issueId === issue.id)
        const section = element('section')
        section.append(element('p', issue.title || 'Merge conflict', 'hint'), mergeConflictView(issue.current || '', issue.choices || [], { actions: false }))
        if (resolved.length) {
          section.append(element('strong', 'Resolution history'))
          for (const r of resolved) section.append(element('pre', `${r.author || 'Unknown'} chose:\n${r.value || ''}`))
        }
        const actions = element('div', null, 'merge-actions')
        actions.append(action('Apply current side again', () => reapplyStoredResolution(issue, issue.current || '')))
        for (const choice of issue.choices || []) actions.append(action(choice.label, () => reapplyStoredResolution(issue, choice.text)))
        section.append(actions)
        panel.append(section)
      }
    }
    if (record.lateEdits?.length) panel.append(element('p', `${record.lateEdits.length} edits arrived from an earlier editing context`, 'hint'))
    panel.append(action('Return to live', live))
  }
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
      const state = commitState(docHandle), name = branchName(docHandle)
      const lane = branchLanes.get(docHandle.url)
      const records = branchRemoved(docHandle) ? state.closed : [state.open, ...state.closed]
      for (const record of records) {
        const id = `${docHandle.url}/${record.id}`
        const node = { ...record, nodeId: id, url: docHandle.url, handle: docHandle, doc: state.doc, lane, branchName: name,
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
    visibleCommitNodes = new Map(nodes.map(n => [n.nodeId, n]))
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
      const group = svg('g', { tabindex: 0, role: 'button', draggable: 'true', 'aria-pressed': String(selected), 'data-commit': node.id, 'data-node-id': node.nodeId, 'data-document': node.url,
        style: 'cursor: grab', 'aria-label': `${label}\n${sublabel}` })
      group.append(svg('rect', { x: 4, y: y(node) - 17, width: width - 8, height: 34, rx: 5,
        fill: selected ? '#fff0c2' : node.open && node.url === handle.url ? '#e9eef3' : 'transparent', stroke: selected ? '#b68118' : 'none' }))
      group.append(svg('circle', { cx: x(node), cy: y(node), r: node.open ? 8 : 5, fill: node.open ? 'white' : color(node.url), stroke: color(node.url), 'stroke-width': 2 }))
      group.append(svg('text', { x: labelX, y: y(node) - 2 }, label.length > 36 ? label.slice(0, 35) + '…' : label))
      group.append(svg('text', { x: labelX, y: y(node) + 13 }, sublabel.length > 42 ? sublabel.slice(0, 41) + '…' : sublabel))
      const branchLink = svg('text', { x: width - 76, y: y(node) + 4, fill: '#34745b', style: 'opacity:0; cursor:pointer; font-weight:600' }, '+ branch')
      branchLink.onpointerdown = event => event.stopPropagation()
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
        if (suppressCommitClick) return
        clearTimeout(commitClickTimer)
        commitClickTimer = setTimeout(activate, 180)
      }
      group.ondblclick = event => {
        event.preventDefault(); event.stopPropagation(); clearTimeout(commitClickTimer); editName()
      }
      group.onpointerdown = event => {
        if (event.button !== 0) return
        pointerCommitDrag = { node, startX: event.clientX, startY: event.clientY, dragging: false }
        event.preventDefault()
      }
      group.ondragstart = event => {
        draggedCommitNode = node
        event.dataTransfer.effectAllowed = 'copyMove'
        event.dataTransfer.setData('text/plain', node.nodeId)
        setCommitDragHighlight(node.nodeId)
      }
      group.ondragover = event => {
        if (draggedCommitNode && draggedCommitNode.nodeId !== node.nodeId) {
          event.preventDefault(); event.dataTransfer.dropEffect = 'copyMove'; showBranchLink()
          setCommitDragHighlight(draggedCommitNode.nodeId, node.nodeId)
        }
      }
      group.ondragleave = () => { if (draggedCommitNode && dragTargetNodeId === node.nodeId) setCommitDragHighlight(draggedCommitNode.nodeId) }
      group.ondragend = () => { draggedCommitNode = null; clearCommitDragHighlight(); hideBranchLink() }
      group.ondrop = event => {
        event.preventDefault(); event.stopPropagation()
        const source = draggedCommitNode
        draggedCommitNode = null; clearCommitDragHighlight(); hideBranchLink()
        if (source && source.nodeId !== node.nodeId) mergeCommitNodes(source, node)
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
    handle.off('ephemeral-message', receiveEphemeral)
    handle = next
    handle.on('ephemeral-message', receiveEphemeral)
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
  $('branch-select').onchange = event => {
    const value = event.target.value
    if (value === '__rename') return renameCurrentBranch()
    if (value === '__remove') return removeCurrentBranch()
    switchBranch(value)
  }
  async function renameCurrentBranch() {
    $('branch-select').value = handle.url
    if (versionBusy) return
    const previous = branchName(handle)
    const next = prompt('Branch name', previous)?.trim()
    if (!next || next === previous) return
    versionBusy = true; refresh()
    try {
      renameBranch(handle, next, username())
      for (const doc of documents.values()) renameBranchLink(doc, handle.url, next, username())
      await repo.flush([...documents.values()].map(doc => doc.documentId))
      notify(`Renamed branch to “${next}”.`)
    } catch (error) { notify(`Could not rename branch: ${error.message}`) }
    finally { versionBusy = false; refresh() }
  }
  async function removeCurrentBranch() {
    $('branch-select').value = handle.url
    if (versionBusy) return
    const activeBranches = [...documents.values()].filter(doc => !branchRemoved(doc))
    if (activeBranches.length <= 1) { notify('Cannot remove the last branch.'); return }
    const doomed = handle, replacement = activeBranches.find(doc => doc.url !== doomed.url)
    if (!confirm(`Remove open commit for branch “${branchName(doomed)}”? Its merges and checkpoint history will remain visible.`)) return
    versionBusy = true; refresh()
    try {
      removeBranchOpenCommit(doomed, username())
      activateHandle(replacement)
      await repo.flush([doomed.documentId])
      notify('Branch open commit removed; history remains visible.')
    } catch (error) { notify(`Could not remove branch: ${error.message}`) }
    finally { versionBusy = false; refresh() }
  }
  function updateBranchSelect() {
    const activeBranches = [...documents.values()].filter(doc => !branchRemoved(doc))
    const options = activeBranches.map(doc => {
      const option = document.createElement('option')
      option.value = doc.url
      option.textContent = `${branchName(doc)} · open commit`
      return option
    })
    const separator = document.createElement('option')
    separator.disabled = true; separator.textContent = '──────────'
    const rename = document.createElement('option')
    rename.value = '__rename'; rename.textContent = 'Rename branch…'
    const remove = document.createElement('option')
    remove.value = '__remove'; remove.textContent = activeBranches.length <= 1 ? 'Remove branch unavailable — last branch' : 'Remove branch…'
    remove.disabled = activeBranches.length <= 1
    options.push(separator, rename, remove)
    const existing = [...$('branch-select').options]
    if (existing.length !== options.length || existing.some((option, i) => option.value !== options[i].value || option.textContent !== options[i].textContent || option.disabled !== options[i].disabled)) {
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
  const cleanCommitRecord = node => node.open ? null : commitState(node.handle).byId.get(node.id)
  async function mergeCommitNodes(source, target) {
    if (composing || versionBusy || source.nodeId === target.nodeId) return
    versionBusy = true; refresh()
    try {
      const sourceRecord = cleanCommitRecord(source)
      if (!source.open && !sourceRecord) throw new Error('Choose a closed source commit')
      let targetHandle = target.handle, flushIds = [source.handle.documentId, target.handle.documentId]
      if (!target.open) {
        const targetRecord = cleanCommitRecord(target)
        if (!targetRecord) throw new Error('Choose a closed target commit')
        const defaultName = `Merge ${source.branchName} into ${target.branchName}`
        const name = prompt(source.open ? 'New branch name for merge' : 'Both commits are closed. New branch name for merge', defaultName)?.trim()
        if (!name) return
        targetHandle = branchFromCommit(repo, target.handle, targetRecord, name, identity())
        branches.watch(targetHandle)
        flushIds.push(targetHandle.documentId)
      }
      const result = mergeCommit(targetHandle, source.handle, identity(), { sourceRecord })
      if (result?.id) {
        const issues = storedMergeIssues(targetHandle.doc())
        if (issues.length) recordMergeReview(targetHandle, result.id, issues, identity())
      }
      await repo.flush([...new Set(flushIds)])
      if (targetHandle !== target.handle) activateHandle(targetHandle)
      refresh(); text.focus(); sendPresence()
      notify(result ? 'Merged the dragged commit. Review the result, then create a checkpoint.' : 'All source edits are already included.')
    } catch (error) { notify(`Could not merge commits: ${error.message}`) }
    finally { versionBusy = false; refresh() }
  }
  $('merge').onclick = async () => {
    if (composing || selectedHash || versionBusy) return
    versionBusy = true; refresh()
    try {
      const source = documents.get($('merge-source').value)
      if (!source) return
      const result = mergeBranch(handle, source, identity())
      if (result?.id) {
        const issues = storedMergeIssues(handle.doc())
        if (issues.length) recordMergeReview(handle, result.id, issues, identity())
      }
      await repo.flush([handle.documentId, source.documentId])
      notify(result ? 'Merged the captured source checkpoint into this open commit. Review the result, then create a checkpoint.' : 'All source edits are already included.')
      refresh()
    } catch (error) { notify(`Could not merge: ${error.message}`) }
    finally { versionBusy = false; refresh() }
  }
  $('live').onclick = live
  function showHistoryTab(tab) {
    const assistant = tab === 'assistant'
    $('history-tab-history').setAttribute('aria-selected', String(!assistant))
    $('history-tab-assistant').setAttribute('aria-selected', String(assistant))
    $('history').hidden = assistant
    $('assistant-panel').hidden = !assistant
  }
  $('history-tab-history').onclick = () => showHistoryTab('history')
  $('history-tab-assistant').onclick = () => showHistoryTab('assistant')
  $('assistant-toggle').onclick = () => {
    assistantMuted = !assistantMuted
    if (!paused && adapter.remotePeerId && adapter.socket?.readyState === 1) {
      handle.broadcast({ type: 'agent-control', action: assistantMuted ? 'mute' : 'resume' })
    }
    renderAssistant()
  }
  document.addEventListener('pointermove', event => {
    if (!pointerCommitDrag) return
    if (Math.hypot(event.clientX - pointerCommitDrag.startX, event.clientY - pointerCommitDrag.startY) > 4) {
      pointerCommitDrag.dragging = true
      tooltip.hidden = true
      const targetGroup = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('g[data-node-id]')
      const targetId = targetGroup?.dataset.nodeId !== pointerCommitDrag.node.nodeId ? targetGroup?.dataset.nodeId : null
      setCommitDragHighlight(pointerCommitDrag.node.nodeId, targetId)
    }
  })
  document.addEventListener('pointerup', event => {
    if (!pointerCommitDrag) return
    const drag = pointerCommitDrag
    pointerCommitDrag = null
    if (!drag.dragging) { clearCommitDragHighlight(); return }
    suppressCommitClick = true
    clearTimeout(commitClickTimer)
    setTimeout(() => { suppressCommitClick = false }, 0)
    const targetGroup = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('g[data-node-id]')
    const target = targetGroup && visibleCommitNodes.get(targetGroup.dataset.nodeId)
    clearCommitDragHighlight()
    if (target && target.nodeId !== drag.node.nodeId) mergeCommitNodes(drag.node, target)
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      tooltip.hidden = true
      pointerCommitDrag = null
      draggedCommitNode = null
      clearCommitDragHighlight()
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
    capture(); renderCursors(); renderAssistant(); updateBranchSelect(); renderGraph(); renderCommitDetail()
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
  function receiveEphemeral({ senderId, message }) {
    if (paused || !message) return
    if (message.type === 'cursor') {
      if (typeof message.name !== 'string' || (message.cursor !== null && typeof message.cursor !== 'string')) return
      peers.set(senderId, { name: message.name.slice(0, 60), cursor: message.cursor, role: message.role === 'agent' ? 'agent' : 'user', seen: Date.now() }); renderCursors()
    } else if (message.type === 'assistant') {
      if (assistantMuted && message.status !== 'idle') return
      assistantMessage = {
        summary: String(message.summary || '').slice(0, 500),
        thoughts: Array.isArray(message.thoughts) ? message.thoughts.map(item => String(item).slice(0, 1000)) : String(message.thoughts || '').slice(0, 4000),
        feedback: message.feedback ? String(message.feedback).slice(0, 200) : '',
        seen: Date.now(), senderId,
      }
      if (message.event === 'riff-added') flashAssistantUpdate()
      renderAssistant()
    }
  }
  handle.on('ephemeral-message', receiveEphemeral)
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
    status(); sendPresence(); renderCursors(); renderAssistant()
    if (!paused) branches.retry()
  }, 3000)
  text.disabled = $('pause').disabled = $('copy').disabled = false
  branches.watch(handle)
  refresh(); status()
} catch (error) { $('status').textContent = `Could not open document: ${error.message}` }
window.addEventListener('hashchange', () => location.reload())
