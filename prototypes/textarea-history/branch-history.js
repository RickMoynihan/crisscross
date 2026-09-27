import { Automerge as A } from '@automerge/automerge-repo/slim'
import { layout, author } from './graph.js'

// Each document keeps its own linear activity. Fork markers are explicitly
// labelled snapshots, since a saved multi-head state need not still be a prefix
// of its source's activity order after late changes arrive.
export function branchHistory(handles, { grouped = true, selected = null, lanes = new Map() } = {}) {
  const records = new Map(), rows = new Map(), edges = []
  for (const handle of handles) {
    const doc = handle.doc(), branch = doc.branch
    const forkHeads = branch && [...(branch.forkHeads || [branch.forkHash])]
    const inherited = new Set(forkHeads ? A.getAllChanges(A.view(doc, forkHeads)).map(bytes => A.decodeChange(bytes).hash) : [])
    const changes = A.getAllChanges(doc).map(A.decodeChange)
    const timeline = layout(changes, { grouped: false }).nodes.toReversed()
    // Group only branch-owned activity; do not duplicate its inherited history.
    const own = timeline.filter(n => !inherited.has(n.hash))
    const runs = []
    for (const node of own) {
      let kind
      try { kind = JSON.parse(node.message).kind } catch {}
      if (kind === 'branch-register') continue
      const last = runs.at(-1)
      const merge = grouped && last && !kind && !last.kind && last.hash !== selected &&
        last.actor === node.actor && author(last) === author(node) && node.time >= last.time && node.time - last.time <= 2
      if (merge) runs[runs.length - 1] = { ...node, beforeHeads: last.beforeHeads, changes: [...last.changes, ...node.changes] }
      else runs.push({ ...node, kind })
    }
    records.set(handle.url, { handle, doc, branch, forkHeads, inherited, timeline, runs, name: branch?.name || 'Main' })
  }
  // Parent-first ordering gives branches persistent adjacent narrow tracks.
  const visiting = new Set()
  function add(url) {
    const record = records.get(url)
    if (!record || visiting.has(url)) return
    visiting.add(url)
    if (record.branch) add(record.branch.source)
    if (!lanes.has(url)) lanes.set(url, lanes.size)
    const lane = lanes.get(url)
    let previous
    if (record.branch) {
      previous = `${url}/fork`
      rows.set(previous, { id: previous, type: 'fork', url, source: record.branch.source,
        branchUrl: url, name: record.name, lane: lanes.get(record.branch.source) ?? lane,
        doc: record.doc, afterHeads: record.forkHeads,
        time: record.runs[0]?.time || 0, label: `Fork → ${record.name}` })
    }
    for (const node of record.runs) {
      const id = `${url}/${node.hash}`
      rows.set(id, { ...node, id, type: 'edit', url, name: record.name, lane, doc: record.doc })
      if (previous) edges.push({ from: id, to: previous })
      previous = id
    }
    const tip = `${url}/live`
    rows.set(tip, { id: tip, type: 'tip', url, name: record.name, lane,
      time: Number.MAX_SAFE_INTEGER, afterHeads: A.getHeads(record.doc), label: `${record.name} · live` })
    if (previous) edges.push({ from: tip, to: previous })
  }
  for (const url of records.keys()) add(url)
  function attachFork(fork, anchor, sourceUrl) {
    // Insert the snapshot into the source track, before its later activity.
    const sourceLane = lanes.get(sourceUrl)
    for (const edge of edges) {
      if (edge.to === anchor && rows.get(edge.from).lane === sourceLane) edge.to = fork
    }
    edges.push({ from: fork, to: anchor })
  }
  // Attach each saved fork to the source activity at its latest included change.
  for (const [url, record] of records) {
    if (!record.branch) continue
    const source = records.get(record.branch.source)
    if (!source) continue
    const anchor = source.runs.findLast(n => n.changes.some(c => record.inherited.has(c.hash)))
    if (anchor) {
      // A run can straddle a fork: render it as individual changes at that boundary.
      // The caller passes selected hashes for pinning; here locate the exact prefix.
      const included = anchor.changes.filter(c => record.inherited.has(c.hash))
      const excluded = anchor.changes.filter(c => !record.inherited.has(c.hash))
      if (included.length && excluded.length) {
        const oldId = `${source.handle.url}/${anchor.hash}`
        const endpoint = included.at(-1)
        const original = source.timeline.find(n => n.hash === endpoint.hash)
        const prefixId = `${source.handle.url}/${endpoint.hash}`
        const row = rows.get(oldId)
        rows.set(prefixId, { ...row, ...endpoint, id: prefixId, changes: included, afterHeads: original.afterHeads })
        rows.set(oldId, { ...row, changes: excluded, beforeHeads: original.afterHeads })
        for (const edge of edges) if (edge.from === oldId) edge.from = prefixId
        edges.push({ from: oldId, to: prefixId })
        // Keep source.runs updated for another branch forking inside this run.
        const index = source.runs.indexOf(anchor)
        source.runs.splice(index, 1, rows.get(prefixId), rows.get(oldId))
        attachFork(`${url}/fork`, prefixId, source.handle.url)
      } else attachFork(`${url}/fork`, `${source.handle.url}/${anchor.hash}`, source.handle.url)
    } else if (source.branch) attachFork(`${url}/fork`, `${source.handle.url}/fork`, source.handle.url)
  }
  const pending = new Map([...rows.keys()].map(id => [id, 0])), children = new Map()
  for (const edge of edges) {
    pending.set(edge.from, pending.get(edge.from) + 1)
    if (!children.has(edge.to)) children.set(edge.to, [])
    children.get(edge.to).push(edge.from)
  }
  const ready = [...rows.values()].filter(row => !pending.get(row.id)), ordered = []
  while (ready.length) {
    ready.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
    const row = ready.shift(); ordered.push(row)
    for (const id of children.get(row.id) || []) {
      pending.set(id, pending.get(id) - 1)
      if (!pending.get(id)) ready.push(rows.get(id))
    }
  }
  if (ordered.length !== rows.size) throw new Error('Invalid branch graph')
  return { nodes: ordered.reverse().map((row, index) => ({ ...row, row: index })), edges, lanes }
}
