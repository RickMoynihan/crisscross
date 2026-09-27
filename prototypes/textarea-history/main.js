import { Repo, Automerge as A, initializeBase64Wasm } from '@automerge/automerge-repo/slim'
import { automergeWasmBase64 } from '@automerge/automerge/automerge.wasm.base64'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import { sameHeads, author, color } from './graph.js'
import { textEdits, describeEdits } from './changes.js'
import { createBranch, branchLinks, registerBranch } from './branches.js'
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
  let paused = false, writing = false, composing = false, compositionHeads, selection = null
  const peers = new Map(), documents = new Map(), loading = new Set(), branchLanes = new Map()
  const unavailable = new Map()
  let selectedHash = null, selectedHeads = null
  let displayed = handle.doc()
  const username = () => name.value.trim() || 'Anonymous'
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
  function renderGraph() {
    tooltip.hidden = true
    const { nodes, edges } = branchHistory([...documents.values()], {
      grouped: !$('individual').checked, selected: selectedHash, lanes: branchLanes,
    })
    const x = n => 20 + n.lane * 20, y = n => 24 + n.row * 40
    const labelX = 40 + Math.max(0, branchLanes.size - 1) * 20, width = labelX + 240
    graph.setAttribute('width', width); graph.setAttribute('height', nodes.length * 40 + 16)
    graph.replaceChildren()
    $('heads').textContent = `${handle.doc().branch?.name || 'Main'} · current document`
    const byId = new Map(nodes.map(n => [n.id, n]))
    for (const edge of edges) {
      const from = byId.get(edge.from), to = byId.get(edge.to)
      const bend = Math.min(y(from) + 28, y(to))
      graph.append(svg('path', { d: `M${x(from)},${y(from)} C${x(from)},${bend} ${x(to)},${bend} ${x(to)},${Math.min(y(from) + 40, y(to))} L${x(to)},${y(to)}`,
        fill: 'none', stroke: color(from.type === 'fork' ? from.branchUrl : from.url), 'stroke-width': 2 }))
    }
    for (const node of nodes) {
      if (node.type !== 'edit') {
        const forkSelected = node.type === 'fork' && selectedHash && handle.url === node.url && sameHeads(selectedHeads, node.afterHeads)
        const group = svg('g', { tabindex: 0, role: 'button', 'aria-pressed': String(Boolean(forkSelected)), 'data-branch': node.branchUrl || node.url, 'data-kind': node.type, 'aria-label': node.label })
        group.append(svg('rect', { x: 4, y: y(node) - 17, width: width - 8, height: 34, rx: 5,
          fill: forkSelected ? '#fff0c2' : node.type === 'tip' && node.url === handle.url ? '#e9eef3' : 'transparent' }))
        group.append(svg('circle', { cx: x(node), cy: y(node), r: node.type === 'tip' ? 8 : 5,
          fill: 'white', stroke: color(node.branchUrl || node.url), 'stroke-width': 2 }))
        group.append(svg('text', { x: labelX, y: y(node) + 4 }, node.label.length > 31 ? node.label.slice(0, 30) + '…' : node.label))
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
    selectedHash = null; selectedHeads = null; selection = null; compositionHeads = null
    peers.clear()
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
      option.textContent = `${doc.doc().branch?.name || 'Main'} · ${doc.documentId.slice(0, 5)}`
      return option
    })
    const existing = [...$('branch-select').options]
    if (existing.length !== options.length || existing.some((option, i) => option.value !== options[i].value || option.textContent !== options[i].textContent)) {
      $('branch-select').replaceChildren(...options)
    }
    $('branch-select').value = handle.url
    $('branch-status').textContent = unavailable.size ? `${unavailable.size} branch document(s) unavailable · retrying` : loading.size ? 'Loading branches…' : ''
  }
  function watchDocument(doc) {
    if (documents.has(doc.url)) return
    documents.set(doc.url, doc)
    doc.on('change', () => {
      discover(doc)
      if (doc === handle) refresh()
      else { updateBranchSelect(); renderGraph() }
    })
    discover(doc)
    // Opening an older branch publishes its link once its source is available.
    for (const known of documents.values()) {
      const source = documents.get(known.doc().branch?.source)
      if (source) registerBranch(source, known, username())
    }
  }
  function discover(doc) {
    for (const link of branchLinks(doc)) {
      if (documents.has(link.url) || loading.has(link.url) || unavailable.has(link.url)) continue
      loading.add(link.url)
      repo.find(link.url).then(found => {
        loading.delete(link.url); unavailable.delete(link.url)
        watchDocument(found); updateBranchSelect(); renderGraph()
      }).catch(() => {
        loading.delete(link.url); unavailable.set(link.url, Date.now()); updateBranchSelect()
      })
    }
    updateBranchSelect()
  }
  $('branch-create').onclick = async () => {
    if (!selectedHash || composing) return
    const button = $('branch-create')
    button.disabled = true
    try {
      const branch = createBranch(repo, handle, selectedHeads,
        $('branch-name').value.trim() || `Branch ${selectedHash.slice(0, 7)}`, username())
      await repo.flush([branch.documentId, handle.documentId])
      watchDocument(branch)
      activateHandle(branch)
      $('branch-name').value = ''
      history.replaceState(null, '', `#${handle.url}`)
      refresh(); text.focus(); sendPresence()
    } catch (error) {
      $('status').textContent = `Could not create branch: ${error.message}`
    } finally { button.disabled = false }
  }
  $('live').onclick = live
  $('heads').onclick = live
  $('individual').onchange = renderGraph
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
    const branch = handle.doc().branch
    $('branch-info').hidden = !branch
    if (branch) {
      $('branch-label').textContent = `Branch: ${branch.name} · from ${branch.forkHash.slice(0, 7)}`
      $('branch-source').href = `#${branch.source}`
    }
    $('mode-detail').textContent = selectedHash ? `Read-only · pinned activity snapshot · Escape returns to live` : ''
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
    const options = { message: JSON.stringify({ author: username() }), time: Math.floor(Date.now() / 1000) }
    try {
      if (compositionHeads) {
        // Apply composition to the version it started from, preserving intervening remote edits.
        const heads = handle.changeAt(compositionHeads, d => A.updateText(d, ['text'], value), options)
        if (heads) {
          const local = handle.view(heads).doc()
          selection = [start, end].map(i => A.getCursor(local, ['text'], i))
        }
        compositionHeads = null
      } else {
        handle.change(d => A.updateText(d, ['text'], value), options)
        displayed = handle.doc()
        selection = [start, end].map(i => A.getCursor(displayed, ['text'], i))
      }
    } finally { writing = false }
    refresh(); sendPresence()
  }
  text.oninput = edit
  text.addEventListener('compositionstart', () => { if (selectedHash) return; composing = true; compositionHeads = handle.heads() })
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
    for (const [url, time] of unavailable) if (Date.now() - time > 15000) unavailable.delete(url)
    if (!paused) for (const doc of documents.values()) discover(doc)
  }, 3000)
  text.disabled = $('pause').disabled = $('copy').disabled = false
  watchDocument(handle)
  refresh(); status()
} catch (error) { $('status').textContent = `Could not open document: ${error.message}` }
window.addEventListener('hashchange', () => location.reload())
