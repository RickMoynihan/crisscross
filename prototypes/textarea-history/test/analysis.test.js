import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as A from '@automerge/automerge'
import { HistoryIndex } from '../history-index.js'
import { reviewIssues, reviewStats, clearReviewCache } from '../conflicts.js'
import { commitState, checkpoint, summaryStats, changeOptions } from '../versioning.js'
import { createReviewProcessor } from '../review-worker-core.js'
import { ReviewClient } from '../review-client.js'
import { ReviewStore } from '../review-store.js'

const options = author => changeOptions({ author, userId: author }, { kind: 'edit', openCommitId: 'test' })
function handle(initial, url = 'test') {
  let doc = initial
  return { url, doc: () => doc, change: (fn, opts) => { doc = A.change(doc, opts, fn) } }
}
const edit = (h, value, author = 'Alice') => h.change(d => A.updateText(d, ['text'], value), options(author))

test('history index reads only appended metadata and keeps actor clocks, not ancestor sets', () => {
  const h = handle(A.from({ text: '' })), index = new HistoryIndex()
  for (let i = 0; i < 100; i++) edit(h, h.doc().text + 'a')
  index.ingest(h.doc())
  const previous = index.stats.metadataRead, first = A.getChangesMetaSince(h.doc(), [])[0].hash
  edit(h, h.doc().text + '!')
  index.ingest(h.doc())
  assert.equal(index.stats.metadataRead - previous, 1)
  for (const node of index.nodes.values()) assert.equal(node.clock.size, 1)
  assert.ok(index.precedes(first, A.getHeads(h.doc())[0]))
  assert.equal(index.snapshot(A.view(h.doc(), [first])).length, 1)
})

test('unrelated documents may reuse actor IDs without contaminating the shared index', () => {
  const index = new HistoryIndex()
  const first = A.from({ text: 'first' }, { actor: 'aabb' })
  let other = A.from({ metadata: 'other' }, { actor: 'aabb' })
  other = A.change(other, d => { d.metadata = 'new metadata' })
  index.ingest(first); index.ingest(other)
  assert.equal(index.snapshot(first)[0].hash, A.getHeads(first)[0])
  assert.ok(index.snapshot(other).every(n => !n.hasText))
  assert.ok(!index.precedes(A.getHeads(first)[0], A.getHeads(other)[0]))
})

test('closed summaries and reviews survive new document objects; new edits only add new counts and runs', () => {
  const h = handle(A.from({ text: '' }))
  for (let i = 0; i < 20; i++) edit(h, h.doc().text + 'a')
  const saved = checkpoint(h, 'Saved', 'Alice')
  const first = commitState(h).closed[0]
  reviewIssues(A.view(h.doc(), saved.snapshotHeads))
  const analysed = reviewStats.analyses
  const second = commitState(handle(A.clone(h.doc()))).closed[0]
  assert.equal(first.edits, second.edits)
  reviewIssues(A.view(A.clone(h.doc()), saved.snapshotHeads))
  assert.equal(reviewStats.analyses, analysed)
  reviewIssues(h.doc()); commitState(h)
  const added = summaryStats.editsAdded, built = reviewStats.runsBuilt
  edit(h, h.doc().text + '!')
  assert.equal(commitState(h).open.edits.length, 1)
  reviewIssues(h.doc())
  assert.equal(summaryStats.editsAdded - added, 1)
  assert.equal(reviewStats.runsBuilt - built, 1)
})

test('spatial review index agrees with exhaustive comparisons across independent passages', () => {
  const summarize = issues => issues.map(i => ({ base: i.base, current: i.current, choices: i.choices.map(c => c.text).sort() })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  for (let seed = 0; seed < 12; seed++) {
    const base = A.from({ text: 'cat\n\ndog\n\nowl\n\nfox' })
    const handles = Array.from({ length: 3 }, () => handle(A.clone(base)))
    for (let actor = 0; actor < handles.length; actor++) {
      for (let step = 0; step < 3; step++) {
        const parts = handles[actor].doc().text.split('\n\n')
        const index = (seed + actor * 2 + step) % parts.length
        parts[index] = ['bear', 'ibis', 'hare'][(actor + step) % 3] + step
        edit(handles[actor], parts.join('\n\n'), `Actor ${actor}`)
      }
    }
    const merged = handles.map(h => h.doc()).reduce((a, b) => A.merge(a, b))
    assert.deepEqual(summarize(reviewIssues(merged)), summarize(reviewIssues(merged, { rangeIndex: false })), `seed ${seed}`)
  }
})

test('worker analysis reuses persisted closed snapshots after a processor restart', async () => {
  const data = new Map(), store = { get: async key => data.get(key), set: async (key, value) => { data.set(key, value) } }
  const first = handle(A.from({ text: 'cat' })), second = handle(A.clone(first.doc()))
  edit(first, 'dog'); edit(second, 'fox', 'Bob')
  const merged = A.merge(first.doc(), second.doc()), heads = A.getHeads(merged)
  const message = { url: 'test', changes: A.getAllChanges(merged), heads, persist: true }
  const result = await createReviewProcessor(store)(message)
  assert.equal(result.issues.length, 1)
  clearReviewCache()
  const analysed = reviewStats.analyses
  const reloaded = await createReviewProcessor(store)(message)
  assert.deepEqual(reloaded, result)
  assert.equal(reviewStats.analyses, analysed, 'must use persisted result rather than analysing again')
  const changed = A.change(A.clone(merged), options('Alice'), d => A.updateText(d, ['text'], d.text + '!'))
  await assert.rejects(createReviewProcessor(store)({ ...message, heads: A.getHeads(changed) }), /not arrived/)
})

test('worker client coalesces live edits and never returns an old result for new heads', () => {
  const messages = [], worker = { postMessage: message => messages.push(message), terminate() {} }
  const client = new ReviewClient({ worker }), h = handle(A.from({ text: 'cat' }))
  try {
    const first = A.getHeads(h.doc())
    client.get(h, first, { live: true }); client.pump()
    edit(h, 'dog'); client.get(h, A.getHeads(h.doc()), { live: true })
    edit(h, 'fox'); const latest = A.getHeads(h.doc())
    client.get(h, latest, { live: true })
    assert.equal(messages.length, 1)
    assert.equal(client.pending.size, 1)
    worker.onmessage({ data: { id: messages[0].id, heads: first, issues: [{ id: 'old' }] } })
    assert.equal(messages.length, 2)
    assert.deepEqual(messages[1].heads, latest)
    assert.equal(messages[1].changes.length, 2, 'send only new changes to the worker')
    assert.equal(client.get(h, latest).status, 'pending')
    worker.onmessage({ data: { id: messages[1].id, heads: latest, issues: [] } })
    assert.deepEqual(client.get(h, latest).issues, [])
    assert.equal(client.get(h, first).issues[0].id, 'old')
  } finally { client.stop() }
})

test('worker failures remain visible and missing IndexedDB is a safe cache miss', async () => {
  const worker = { postMessage() {}, terminate() {} }, client = new ReviewClient({ worker })
  const h = handle(A.from({ text: '' }))
  try {
    client.get(h, A.getHeads(h.doc())); client.pump()
    worker.onerror({ message: 'Worker failed' })
    assert.equal(client.get(h, A.getHeads(h.doc())).status, 'error')
    assert.equal(client.get(h, A.getHeads(h.doc())).issues, undefined)
    const store = new ReviewStore(null)
    assert.equal(await store.get('missing'), undefined)
    await store.set('missing', [])
  } finally { client.stop() }
})

test('a cached live result is persisted when the same heads become a checkpoint', () => {
  const messages = [], worker = { postMessage: message => messages.push(message), terminate() {} }
  const client = new ReviewClient({ worker }), h = handle(A.from({ text: 'cat' })), heads = A.getHeads(h.doc())
  try {
    client.get(h, heads, { live: true }); client.pump()
    worker.onmessage({ data: { id: messages[0].id, heads, issues: [] } })
    assert.equal(client.get(h, heads, { persist: true }).status, 'ready')
    client.pump()
    assert.equal(messages.length, 2)
    assert.equal(messages[1].persist, true)
    assert.equal(messages[1].changes.length, 0)
    worker.onmessage({ data: { id: messages[1].id, heads, issues: [] } })
    client.get(h, heads, { persist: true }); client.pump()
    assert.equal(messages.length, 2, 'persist exactly once')
  } finally { client.stop() }
})

test('cache storage failure does not prevent analysis or report a false clean result', async () => {
  const store = { get: async () => { throw new Error('Disk unavailable') }, set: async () => { throw new Error('Quota exceeded') } }
  const first = handle(A.from({ text: 'cat' })), second = handle(A.clone(first.doc()))
  edit(first, 'dog'); edit(second, 'fox', 'Bob')
  const doc = A.merge(first.doc(), second.doc())
  const result = await createReviewProcessor(store)({ url: 'test', changes: A.getAllChanges(doc), heads: A.getHeads(doc), persist: true })
  assert.equal(result.issues.length, 1)
})
