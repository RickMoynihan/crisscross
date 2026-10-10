import { Automerge as A } from '@automerge/automerge-repo/slim'
import { LruCache, headsKey } from './analysis-cache.js'

export const metadata = change => { try { return JSON.parse(change.message) || {} } catch { return {} } }
const controls = new Set(['checkpoint', 'branch-create', 'branch-register', 'branch-identity', 'branch-rename', 'branch-rename-link', 'branch-remove', 'branch-remove-open', 'merge'])
const mergeClock = (target, source) => { for (const [actor, seq] of source) target.set(actor, Math.max(target.get(actor) || 0, seq)) }
const compare = (a, b) => a.depth - b.depth || (a.time || 0) - (b.time || 0) || a.actor.localeCompare(b.actor) || a.seq - b.seq

// One metadata node per change; clocks contain actor sequence numbers, never
// sets of every ancestor hash. Related branches share the same indexed nodes.
export class HistoryIndex {
  constructor() {
    this.nodes = new Map(); this.actors = new Map(); this.streams = new Map(); this.textObjects = new Set()
    this.snapshots = new LruCache(64)
    this.stats = { metadataRead: 0, operationsRead: 0 }
  }
  ingest(doc) {
    const heads = A.getHeads(doc)
    if (heads.every(hash => this.nodes.has(hash))) return this
    const actor = A.getActorId(doc), previous = this.streams.get(actor) || []
    const incoming = A.getChangesMetaSince(doc, previous.length && A.hasHeads(doc, previous) ? previous : [])
    this.stats.metadataRead += incoming.length
    const pending = new Map(incoming.map(change => [change.hash, change]))
    const add = hash => {
      if (this.nodes.has(hash)) return this.nodes.get(hash)
      const change = pending.get(hash)
      if (!change) throw new Error('Snapshot history is not available yet')
      const parents = change.deps.map(add), clock = new Map(), contentClock = new Map()
      for (const parent of parents) { mergeClock(clock, parent.clock); mergeClock(contentClock, parent.contentClock) }
      // Actor IDs need only be unique within a document's history. Namespace
      // their clocks by the actor's first change so unrelated documents cannot
      // overwrite each other's actor/sequence entries in this shared index.
      const clockActor = change.seq === 1 ? `${change.actor}:${hash}` : [...clock.keys()].find(key => key.startsWith(`${change.actor}:`))
      if (!clockActor) throw new Error('Missing actor history')
      clock.set(clockActor, change.seq)
      let hasText = false
      if (!controls.has(metadata(change).kind)) {
        // Classify immutable operations once. Diffing every historical state
        // just to ask whether text was touched is much more expensive.
        const decoded = A.inspectChange(doc, hash)
        let operation = decoded.startOp
        for (const op of decoded.ops) {
          this.stats.operationsRead++
          if (op.obj === '_root' && op.key === 'text') {
            hasText = true
            if (op.action === 'makeText') this.textObjects.add(`${clockActor}/${operation}`)
          } else {
            const [counter, objectActor] = op.obj.split('@')
            const lineage = [...clock.keys()].find(key => key.startsWith(`${objectActor}:`))
            if (lineage && this.textObjects.has(`${lineage}/${counter}`)) hasText = true
          }
          operation += op.values?.length || op.multiOp || 1
        }
      }
      if (hasText) contentClock.set(clockActor, change.seq)
      const node = { ...change, clockActor, clock, contentClock, hasText, depth: 1 + Math.max(0, ...parents.map(p => p.depth)) }
      this.nodes.set(hash, node)
      if (!this.actors.has(clockActor)) this.actors.set(clockActor, new Map())
      this.actors.get(clockActor).set(change.seq, node)
      return node
    }
    // The API normally returns causal order. Iterating here keeps the common
    // linear path iterative; recursion is only needed for out-of-order deps.
    for (const change of incoming) add(change.hash)
    this.streams.set(actor, heads)
    return this
  }
  clock(heads) {
    const clock = new Map()
    for (const hash of heads) {
      const node = this.nodes.get(hash)
      if (!node) throw new Error('Snapshot history is not available yet')
      mergeClock(clock, node.clock)
    }
    return clock
  }
  contains(clock, hash) {
    const node = this.nodes.get(hash)
    return Boolean(node && (clock.get(node.clockActor) || 0) >= node.seq)
  }
  precedes(before, after) { return this.contains(this.nodes.get(after).clock, before) }
  frontier(heads) {
    const unique = [...new Set(heads)]
    return unique.filter(hash => !unique.some(other => other !== hash && this.precedes(hash, other))).sort()
  }
  common(heads) {
    if (!heads.length) return []
    const clock = new Map(this.nodes.get(heads[0]).clock)
    for (const hash of heads.slice(1)) for (const [actor, seq] of clock) {
      const common = Math.min(seq, this.nodes.get(hash).clock.get(actor) || 0)
      if (common) clock.set(actor, common); else clock.delete(actor)
    }
    return this.frontier([...clock].map(([actor, seq]) => this.actors.get(actor).get(seq).hash))
  }
  between(beforeHeads, afterHeads) {
    const before = this.clock(beforeHeads), after = this.clock(afterHeads), changes = []
    for (const [actor, end] of after) {
      const actorNodes = this.actors.get(actor)
      for (let seq = (before.get(actor) || 0) + 1; seq <= end; seq++) {
        const node = actorNodes.get(seq)
        if (node) changes.push(node)
      }
    }
    return changes.sort(compare)
  }
  snapshot(doc) {
    this.ingest(doc)
    const heads = A.getHeads(doc), key = headsKey(heads)
    return this.snapshots.get(key) || this.snapshots.set(key, this.between([], heads))
  }
  publicChange(node) {
    const { clockActor, clock, contentClock, hasText, depth, run, span, ...change } = node
    return change
  }
}
export let historyIndex = new HistoryIndex()
// Used by benchmarks and tests to measure a real cold analysis, not a cache hit.
export function resetHistoryIndex() { historyIndex = new HistoryIndex() }
