import { Automerge as A } from '@automerge/automerge-repo/slim'
import { changeOptions } from './versioning.js'
import { historyIndex, metadata } from './history-index.js'
import { LruCache, headsKey } from './analysis-cache.js'
import { encodeRecord, decodeRecord } from './immutable-records.js'
import { author, sameHeads } from './graph.js'

// A conservative contiguous replacement span. Multiple edits within one change
// can widen it: this is a review heuristic, not a semantic conflict detector.
export function replacement(base, value) {
  const before = [...base], after = [...value]
  let prefix = 0, suffix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  const start = before.slice(0, prefix).join('').length
  const end = base.length - before.slice(before.length - suffix).join('').length
  const nextEnd = value.length - after.slice(after.length - suffix).join('').length
  return { start, end, text: value.slice(start, nextEnd), nextEnd }
}
function overlaps(a, b) {
  if (a.start === a.end && b.start === b.end) return a.start === b.start
  if (a.start === a.end) return a.start > b.start && a.start < b.end
  if (b.start === b.end) return b.start > a.start && b.start < a.end
  return a.start < b.end && b.start < a.end
}
// Project Automerge's sequential patches back onto the original text. Keeping
// unchanged characters as anchors gives separate replacement spans, rather than
// one bounding box that swallows unrelated edits elsewhere in the document.
function replacements(doc, beforeHeads, afterHeads) {
  const base = A.view(doc, beforeHeads).text || ''
  const after = A.view(doc, afterHeads).text || ''
  let tokens = base.split('').map((char, index) => ({ char, index }))
  for (const patch of A.diff(doc, beforeHeads, afterHeads)) {
    if (patch.path[0] !== 'text') continue
    if (patch.path.length === 1 && ['put', 'del'].includes(patch.action)) {
      tokens = (patch.action === 'put' ? String(patch.value) : '').split('').map(char => ({ char }))
    } else if (patch.path.length === 2) {
      const index = patch.path[1]
      if (patch.action === 'del') tokens.splice(index, patch.length ?? 1)
      if (patch.action === 'splice') tokens = tokens.slice(0, index).concat(patch.value.split('').map(char => ({ char })), tokens.slice(index))
    }
  }
  const result = []
  let start = 0, afterStart = 0
  for (let pos = 0; pos <= tokens.length; pos++) {
    const index = pos === tokens.length ? base.length : tokens[pos].index
    if (index == null) continue
    const text = after.slice(afterStart, pos)
    if (start !== index || afterStart !== pos) {
      if (base.slice(start, index) !== text) result.push({ start, end: index, text, afterStart, afterEnd: pos })
    }
    start = index + 1; afterStart = pos + 1
  }
  return result
}
function project(position, spans, end = false) {
  let offset = 0
  for (const span of spans) {
    if (position < span.start) break
    if (position <= span.end) return end ? span.afterEnd : span.afterStart
    offset += span.text.length - (span.end - span.start)
  }
  return position + offset
}
const touches = (a, b) => a.start <= b.end && b.start <= a.end
const pairId = (a, b) => `overlap:${[a, b].sort().join(':')}`

// Keep a typing run local to its actor, editing context and touched passage.
// Observing another actor's content or recording a resolution starts a new run.
// Clock timestamps do not determine grouping, so offline typing batches too.
export const reviewStats = { analyses: 0, runsBuilt: 0, pairChecks: 0 }
function typingRuns(doc, index, heads) {
  const current = new Map()
  for (const hash of heads) for (const [actor, seq] of index.nodes.get(hash).contentClock) current.set(actor, Math.max(current.get(actor) || 0, seq))
  const missing = []
  for (const [actor, seq] of current) {
    const chain = []
    for (let node = index.actors.get(actor).get(seq); node?.deps.length && !node.run;) {
      chain.push(node)
      const previous = Math.max(0, ...node.deps.map(hash => index.nodes.get(hash).contentClock.get(actor) || 0))
      node = index.actors.get(actor).get(previous)
    }
    for (const change of chain.reverse()) missing.push(change)
  }
  for (const change of missing) {
    if (change.run) continue
    reviewStats.runsBuilt++
    const info = metadata(change), before = A.view(doc, change.deps).text || ''
    const after = A.view(doc, [change.hash]).text || '', span = replacement(before, after)
    const priorSeq = Math.max(0, ...change.deps.map(hash => index.nodes.get(hash).contentClock.get(change.clockActor) || 0))
    const previous = index.actors.get(change.clockActor).get(priorSeq)?.run
    const foreign = previous && [...change.contentClock].some(([actor, seq]) =>
      actor !== change.clockActor && seq > (previous.last.contentClock.get(actor) || 0))
    const extend = previous && info.kind !== 'resolution' && metadata(previous.last).kind !== 'resolution' &&
      info.openCommitId === metadata(previous.last).openCommitId && author(change) === author(previous.last) &&
      !foreign && touches(previous.range, span)
    change.run = extend ? {
      last: change, previous, previousRun: previous.previousRun,
      range: { start: Math.min(previous.range.start, span.start), end: Math.max(span.nextEnd, previous.range.end + after.length - before.length) },
    } : { last: change, previous: null, previousRun: previous,
      range: { start: span.start, end: span.nextEnd } }
  }
  const runs = []
  for (const [actor, seq] of current) {
    for (let segment = index.actors.get(actor).get(seq)?.run; segment; segment = segment.previousRun) {
      const root = segment
      let changes
      runs.push({ last: segment.last, range: segment.range, segment,
        get changes() {
          if (!changes) {
            changes = []
            for (let part = root; part; part = part.previous) changes.push(part.last)
            changes.reverse()
          }
          return changes
        },
      })
    }
  }
  return runs
}
function commonHeads(index, heads) { return index.common(heads) }
const viewCaches = new WeakMap()
function isolatedView(doc, heads) {
  if (!viewCaches.has(doc)) viewCaches.set(doc, new LruCache(16))
  const views = viewCaches.get(doc), key = headsKey(heads)
  return views.get(key) || views.set(key, A.clone(A.view(doc, heads)))
}
// Sweep only touching ranges. A run's anchors are immutable and reused when
// new document heads arrive; their positions are resolved against the live text.
function overlappingRuns(doc, runs) {
  if (new Set(runs.map(run => run.last.clockActor)).size < 2) return []
  const positioned = runs.map(run => {
    try {
      if (!run.segment.anchors) {
        const view = isolatedView(doc, [run.last.hash])
        run.segment.anchors = { startCursor: A.getCursor(view, ['text'], run.range.start), endCursor: A.getCursor(view, ['text'], run.range.end) }
      }
      return { run, ...currentPassage(doc, run.segment.anchors) }
    } catch {
      // Whole-property replacement can invalidate anchors for a different text
      // object. A broad range is conservative; the property picker handles it.
      return { run, start: 0, end: (doc.text || '').length }
    }
  }).sort((a, b) => a.start - b.start || a.end - b.end || a.run.last.hash.localeCompare(b.run.last.hash))
  const pairs = [], active = []
  for (const next of positioned) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i].end < next.start) active.splice(i, 1)
    for (const other of active) if (other.run.last.actor !== next.run.last.actor) pairs.push([other.run, next.run])
    active.push(next)
  }
  return pairs
}
function passage(doc, heads, baseHeads, start, end) {
  const snapshot = isolatedView(doc, heads), spans = replacements(doc, baseHeads, heads)
  const from = project(start, spans), to = project(end, spans, true)
  return { snapshot, from, to, startCursor: A.getCursor(snapshot, ['text'], from), endCursor: A.getCursor(snapshot, ['text'], to) }
}
function conflictSpans(left, right) {
  const spans = []
  for (const a of left) for (const b of right) {
    if (overlaps(a, b) && !(a.start === b.start && a.end === b.end && a.text === b.text)) {
      spans.push({ start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) })
    }
  }
  return spans
}

function groupPassages(doc, index, candidates) {
  const groups = []
  // Group touching ranges in the current document, including deleted passages
  // whose cursor anchors have collapsed to a single position.
  for (const candidate of candidates.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end)) {
    const group = groups.at(-1)
    if (group && touches(group.range, candidate.range)) {
      group.range.end = Math.max(group.range.end, candidate.range.end)
      group.members.push(candidate)
    } else groups.push({ range: { ...candidate.range }, members: [candidate] })
  }
  return groups.flatMap(group => {
    const latest = new Map()
    for (const run of group.members.flatMap(m => m.runs)) {
      if (!latest.has(run.last.actor) || latest.get(run.last.actor).last.seq < run.last.seq) latest.set(run.last.actor, run)
    }
    const sides = [...latest.values()].sort((a, b) => a.last.actor.localeCompare(b.last.actor))
    const heads = sides.map(run => run.last.hash), baseHeads = commonHeads(index, heads)
    const base = A.view(doc, baseHeads).text || ''
    const versions = sides.map(run => ({ run, spans: replacements(doc, baseHeads, [run.last.hash]) }))
    const relevant = []
    for (let i = 0; i < versions.length; i++) for (let j = i + 1; j < versions.length; j++) {
      for (const span of conflictSpans(versions[i].spans, versions[j].spans)) {
        const p = passage(doc, heads, baseHeads, span.start, span.end)
        if (touches(currentPassage(doc, p), group.range)) relevant.push(span)
      }
    }
    if (!relevant.length) return []
    const start = Math.min(...relevant.map(s => s.start)), end = Math.max(...relevant.map(s => s.end))
    const p = passage(doc, heads, baseHeads, start, end)
    const batches = [...new Map(group.members.map(m => {
      const [left, right] = m.runs.map(r => r.changes.map(c => c.hash))
      return [[left.at(-1), right.at(-1)].sort().join(':'), { left, right }]
    })).values()]
    const hashes = new Set(group.members.flatMap(m => m.runs.flatMap(r => r.changes.map(c => c.hash))))
    const names = [...new Set(sides.map(r => author(r.last)))]
    const issue = { id: `passage:${[...heads].sort().join(':')}:${p.startCursor}:${p.endCursor}`, kind: 'review', title: `${names.join(' / ')} · overlapping passage`,
      heads, batches, editCount: hashes.size, base: base.slice(start, end),
      current: p.snapshot.text.slice(p.from, p.to), startCursor: p.startCursor, endCursor: p.endCursor,
      choices: versions.map(({ run, spans }) => {
        const value = A.view(doc, [run.last.hash]).text || ''
        return { label: `Use ${author(run.last)}’s version`, text: value.slice(project(start, spans), project(end, spans, true)) }
      }),
    }
    // Several historical runs can lead to identical versions. One choice per
    // distinct result is enough; keep all contributors in the passage title.
    issue.choices = issue.choices.filter((choice, index, all) => all.findIndex(c => c.text === choice.text) === index)
    return issue.choices.length > 1 ? [issue] : []
  })
}

const cache = new LruCache(256)
export function clearReviewCache() { cache.clear() }
export function reviewIssues(doc, { rangeIndex = true } = {}) {
  const key = `${rangeIndex ? 'indexed' : 'exhaustive'}:${headsKey(A.getHeads(doc))}`, cached = cache.get(key)
  if (cached) return cached
  reviewStats.analyses++
  const index = historyIndex.ingest(doc)
  // getConflicts/getCursor can inspect backing state on an Automerge view.
  // Isolate the exact snapshot before querying values or creating anchors.
  doc = A.clone(doc)
  const resolutions = Object.entries(doc).filter(([key]) => key.startsWith('resolution:')).map(([, value]) => decodeRecord(value))
  const resolved = new Set(resolutions.filter(r => !r.startCursor).flatMap(r => [r.issueId, ...(r.memberIds || [])]))
  const covered = resolutions.filter(r => r.startCursor).map(r => ({
    ids: new Set(r.memberIds || []), range: currentPassage(doc, r),
    batches: (r.batches || []).map(b => ({ left: new Set(b.left), right: new Set(b.right) })),
  }))
  const issues = []
  const values = A.getConflicts(doc, 'text')
  if (values && Object.keys(values).length > 1) {
    const id = `property:${Object.keys(values).sort().join(',')}`
    issues.push({ id, kind: 'conflict', title: 'Conflicting text values', heads: A.getHeads(doc),
      choices: Object.entries(values).map(([id, value]) => ({ label: `Use value from ${id.split('@')[1]?.slice(0, 8)}`, text: String(value) })),
      current: doc.text || '', base: '', start: 0, end: (doc.text || '').length })
  }
  const runs = typingRuns(doc, index, A.getHeads(doc)), candidates = []
  const pairs = rangeIndex ? overlappingRuns(doc, runs) : runs.flatMap((run, i) => runs.slice(i + 1).map(other => [run, other]))
  for (const [a, b] of pairs) {
    reviewStats.pairChecks++
    const heads = [a.last.hash, b.last.hash]
    if (index.precedes(heads[1], heads[0]) || index.precedes(heads[0], heads[1])) continue
    const baseHeads = commonHeads(index, heads)
    const merged = isolatedView(doc, heads), competing = A.getConflicts(merged, 'text')
    if (competing && Object.keys(competing).length > 1) continue
    const left = replacements(doc, baseHeads, [a.last.hash]).filter(s => touches({ start: s.afterStart, end: s.afterEnd }, a.range))
    const right = replacements(doc, baseHeads, [b.last.hash]).filter(s => touches({ start: s.afterStart, end: s.afterEnd }, b.range))
    for (const span of conflictSpans(left, right)) {
      const p = passage(doc, heads, baseHeads, span.start, span.end)
      const range = currentPassage(doc, p)
      // A decision covers the observed pairs only within its passage. Store the
      // two hash sets, not their quadratic Cartesian product, in the document.
      const acknowledged = (left, right) => {
        if (index.precedes(right.hash, left.hash) || index.precedes(left.hash, right.hash)) return true
        const id = pairId(left.hash, right.hash)
        return resolved.has(id) || covered.some(r => r.range.start <= range.start && r.range.end >= range.end &&
          (r.ids.has(id) || r.batches.some(b => b.left.has(left.hash) && b.right.has(right.hash) ||
            b.right.has(left.hash) && b.left.has(right.hash))))
      }
      if (a.changes.every(left => b.changes.every(right => acknowledged(left, right)))) continue
      candidates.push({ runs: [a, b], range })
    }
  }
  issues.push(...groupPassages(doc, index, candidates))
  cache.set(key, issues)
  return issues
}
export function currentPassage(doc, issue) {
  if (issue.kind === 'conflict') return { start: 0, end: (doc.text || '').length, text: doc.text || '' }
  const start = A.getCursorPosition(doc, ['text'], issue.startCursor)
  const end = A.getCursorPosition(doc, ['text'], issue.endCursor)
  return { start, end, text: (doc.text || '').slice(start, end) }
}
export function resolveIssue(handle, issue, value, who, expectedHeads, openCommitId) {
  // The review is explicitly tied to what the user saw. Never overwrite a
  // collaborator's newer work using an out-of-date resolution panel.
  if (!sameHeads(A.getHeads(handle.doc()), expectedHeads)) throw new Error('The document changed. Review the updated passage before resolving.')
  if (!reviewIssues(handle.doc()).some(item => item.id === issue.id)) throw new Error('This issue has already been resolved.')
  return applyResolution(handle, issue, value, who, expectedHeads, openCommitId)
}
// The browser passes a worker-validated issue tied to these exact heads. Keep
// this final compare-and-apply synchronous; no stale worker result may write.
export function applyResolution(handle, issue, value, who, expectedHeads, openCommitId) {
  if (!sameHeads(A.getHeads(handle.doc()), expectedHeads)) throw new Error('The document changed. Review the updated passage before resolving.')
  const { start, end } = currentPassage(handle.doc(), issue)
  const id = crypto.randomUUID()
  handle.change(doc => {
    if (issue.kind === 'conflict') doc.text = value
    else A.splice(doc, ['text'], start, end - start, value)
    doc[`resolution:${id}`] = encodeRecord({ issueId: issue.id, batches: issue.batches || [],
      ...(issue.kind === 'review' ? { startCursor: issue.startCursor, endCursor: issue.endCursor } : {}), author: typeof who === 'string' ? who : who.author, value })
  }, changeOptions(who, { kind: 'resolution', openCommitId }))
}
