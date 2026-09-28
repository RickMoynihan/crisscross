import { Automerge as A } from '@automerge/automerge-repo/slim'
import { author } from './graph.js'
import { historyIndex, metadata } from './history-index.js'
import { LruCache, headsKey } from './analysis-cache.js'
import { encodeRecord, decodeRecord } from './immutable-records.js'
export { metadata } from './history-index.js'
import { branchInfo, createBranch } from './branches.js'

export const changeOptions = (who, extra = {}) => ({
  message: JSON.stringify({ ...(typeof who === 'string' ? { author: who } : who), ...extra }),
  time: Math.floor(Date.now() / 1000),
})
export function commitRecords(doc) {
  return Object.entries(doc).filter(([key]) => key.startsWith('commit:')).map(([, value]) => decodeRecord(value))
}
let states = new WeakMap()
const summaries = new LruCache(512), openStages = new LruCache(64)
export const summaryStats = { rebuilt: 0, editsAdded: 0 }
export function clearSummaryCaches() { states = new WeakMap(); summaries.clear(); openStages.clear() }
export function commitState(handle) {
  const doc = handle.doc()
  if (states.get(doc)?.url === handle.url) return states.get(doc).state
  const index = historyIndex.ingest(doc)
  const records = commitRecords(doc), byId = new Map(records.map(c => [c.id, c]))
  const own = records.filter(c => c.branchUrl === handle.url)
  const parentIds = new Set(own.flatMap(c => c.parentIds))
  const tips = own.filter(c => !parentIds.has(c.id)).sort((a, b) => a.id.localeCompare(b.id))
  const branch = branchInfo(handle)
  const merges = Object.entries(doc).filter(([key]) => key.startsWith('merge:')).map(([, value]) => decodeRecord(value)).filter(value => value.branchUrl === handle.url)
  const consumed = new Set(own.flatMap(c => c.mergeIds || []))
  const activeMerges = merges.filter(m => !consumed.has(m.id))
  const candidates = new Set([...tips.map(c => c.id), ...activeMerges.flatMap(m => [...m.parentIds])])
  if (!candidates.size && branch?.forkCommitId) candidates.add(branch.forkCommitId)
  const ancestors = new Set()
  function visit(id) {
    for (const parent of byId.get(id)?.parentIds || []) {
      if (!ancestors.has(parent)) { ancestors.add(parent); visit(parent) }
    }
  }
  for (const id of candidates) visit(id)
  const mergeParents = new Set(activeMerges.flatMap(m => [...m.parentIds]))
  const parents = [...candidates].filter(id => !ancestors.has(id) || mergeParents.has(id)).sort()
  const baseHeads = index.frontier(parents.length ? parents.flatMap(id => byId.get(id)?.snapshotHeads || []) : branch?.forkHeads || [])
  const context = `open:${handle.url}:${parents.length ? parents.join(',') : 'root'}`
  const open = { id: context, branchUrl: handle.url, parentIds: parents, baseHeads, snapshotHeads: A.getHeads(doc), title: 'Open commit', open: true, mergeIds: activeMerges.map(m => m.id), hasPendingMerge: activeMerges.length > 0 }
  function decorate(record) {
    const beforeHeads = record.baseHeads || []
    const key = `${record.id}/${headsKey(beforeHeads)}/${headsKey(record.snapshotHeads)}`
    const cached = record.open ? openStages.get(record.id) : summaries.get(key)
    if (cached && headsKey(cached.afterHeads) === headsKey(record.snapshotHeads)) return { ...record, ...cached }
    const currentClock = index.clock(record.snapshotHeads)
    const previous = record.open && cached && cached.afterHeads.every(hash => index.contains(currentClock, hash)) ? cached : null
    summaryStats.rebuilt++
    const added = index.between(previous?.afterHeads || beforeHeads, record.snapshotHeads)
      .filter(c => c.hasText && (c.deps.length > 0 || metadata(c).author)).map(c => index.publicChange(c))
    summaryStats.editsAdded += added.length
    const edits = previous ? previous.edits.concat(added) : added
    const compare = (a, b) => index.nodes.get(a.hash).depth - index.nodes.get(b.hash).depth ||
      (a.time || 0) - (b.time || 0) || a.actor.localeCompare(b.actor) || a.seq - b.seq
    if (previous && added.length && previous.edits.length && compare(previous.edits.at(-1), added[0]) > 0) edits.sort(compare)
    const contributors = new Map((previous?.contributors || []).map(p => [p.id, { ...p }]))
    for (const c of added) {
      const m = metadata(c), id = m.userId || c.actor
      const person = contributors.get(id) || { id, name: author(c), count: 0, lastHash: c.hash }
      person.count++
      if (compare(index.nodes.get(person.lastHash), c) <= 0) { person.name = author(c); person.lastHash = c.hash }
      contributors.set(id, person)
    }
    const summary = { beforeHeads, afterHeads: record.snapshotHeads, edits, contributors: [...contributors.values()].sort((a, b) => a.id.localeCompare(b.id)),
      lateEdits: (previous?.lateEdits || []).concat(added.filter(c => metadata(c).openCommitId && metadata(c).openCommitId !== record.id &&
        metadata(c).openCommitId !== record.openCommitId)) }
    if (record.open) openStages.set(record.id, summary); else summaries.set(key, summary)
    return { ...record, ...summary }
  }
  const state = { doc, get changes() { return index.snapshot(doc) }, records, byId, closed: own.map(decorate), open: decorate(open) }
  states.set(doc, { url: handle.url, state })
  return state
}
export function checkpoint(handle, title, who, { force = false } = {}) {
  const { open, byId } = commitState(handle)
  const hasResolution = historyIndex.between(open.baseHeads, open.snapshotHeads).some(c => metadata(c).kind === 'resolution')
  if (!force && !title.trim() && !open.edits.length && !hasResolution && !open.hasPendingMerge && open.parentIds.length === 1) return byId.get(open.parentIds[0])
  const record = {
    id: crypto.randomUUID(), branchUrl: handle.url, parentIds: open.parentIds,
    baseHeads: open.baseHeads, snapshotHeads: open.snapshotHeads, openCommitId: open.id, mergeIds: open.mergeIds,
    title: title.trim() || 'Checkpoint', closedBy: typeof who === 'string' ? who : who.author,
    closedAt: Date.now(),
  }
  handle.change(doc => { doc[`commit:${record.id}`] = encodeRecord(record) }, changeOptions(who, { kind: 'checkpoint' }))
  return record
}
export function branchFromCommit(repo, source, record, name, who) {
  const saved = record || checkpoint(source, '', who)
  return createBranch(repo, source, saved.snapshotHeads, name, typeof who === 'string' ? who : who.author, saved)
}

// Branch identity is scoped by document URL. Importing another branch's history
// cannot change the target's name/origin, including for legacy documents.
export function preserveBranchIdentity(handle, who) {
  const key = `branch-info:${handle.url}`
  if (handle.doc()[key]) return
  const info = branchInfo(handle)
  handle.change(doc => { doc[key] = info ? JSON.parse(JSON.stringify(info)) : { name: 'Main' } }, changeOptions(who, { kind: 'branch-identity' }))
}
export function mergeBranch(target, source, who) {
  if (source.url === target.url) throw new Error('Choose another branch to merge')
  const targetState = commitState(target), sourceState = commitState(source)
  const sourceContent = sourceState.changes.filter(c => c.hasText || metadata(c).kind === 'resolution')
  const targetHashes = new Set(targetState.changes.map(c => c.hash))
  if (sourceContent.every(c => targetHashes.has(c.hash))) return null
  const left = checkpoint(target, '', who), right = checkpoint(source, '', who)
  preserveBranchIdentity(target, who)
  // Clone the pinned content and apply the import plus control record atomically
  // on the target. Source edits arriving later stay outside this merge.
  const snapshot = A.clone(A.view(source.doc(), right.snapshotHeads))
  const sourceRecords = new Map(commitRecords(source.doc()).map(c => [c.id, c]))
  const imported = [], seen = new Set()
  function include(id) {
    if (seen.has(id)) return
    seen.add(id)
    const record = sourceRecords.get(id)
    if (record) { imported.push(record); record.parentIds.forEach(include) }
  }
  include(right.id)
  const id = crypto.randomUUID()
  target.update(doc => A.change(A.merge(doc, snapshot), changeOptions(who, { kind: 'merge' }), d => {
    for (const record of imported) if (!d[`commit:${record.id}`]) d[`commit:${record.id}`] = encodeRecord(record)
    d[`merge:${id}`] = encodeRecord({ id, branchUrl: target.url, parentIds: [left.id, right.id], sourceUrl: source.url })
  }))
  return { left, right }
}
