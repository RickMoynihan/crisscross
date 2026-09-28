import * as A from '@automerge/automerge'
import { Repo } from '@automerge/automerge-repo'
import { commitState, checkpoint, clearSummaryCaches, branchFromCommit } from '../versioning.js'
import { reviewIssues, clearReviewCache } from '../conflicts.js'
import { resetHistoryIndex } from '../history-index.js'

const options = author => ({ time: 1, message: JSON.stringify({ author, userId: author, kind: 'edit', openCommitId: 'shared' }) })
const handle = initial => {
  let doc = initial
  return { url: 'benchmark', doc: () => doc, change: (fn, options) => { doc = A.change(doc, options, fn) } }
}
function reset() { resetHistoryIndex(); clearSummaryCaches(); clearReviewCache() }
function sample(doc, operation, cold = true) {
  const times = []
  for (let i = 0; i < 3; i++) {
    const copy = A.clone(doc)
    if (cold) reset()
    const start = performance.now(); operation(copy)
    times.push(performance.now() - start)
  }
  return +times.sort((a, b) => a - b)[1].toFixed(2)
}
function make(total) {
  const base = A.from({ text: '' })
  let left = A.clone(base), right = A.clone(base)
  for (let i = 0; i < total / 2; i++) {
    left = A.change(left, options('Alice'), d => A.splice(d, ['text'], i, 0, String.fromCharCode(97 + i % 26)))
    right = A.change(right, options('Bob'), d => A.splice(d, ['text'], i, 0, String.fromCharCode(65 + i % 26)))
  }
  return A.merge(left, right)
}
reviewIssues(make(10))
for (const edits of [100, 500, 1000]) {
  const doc = make(edits)
  const result = { edits, coldSummariesMs: sample(doc, d => commitState(handle(d))), coldReviewMs: sample(doc, reviewIssues) }
  result.cachedReviewMs = sample(doc, reviewIssues, false)
  console.log(JSON.stringify(result))
}
const h = handle(A.from({ text: '' }))
for (let i = 0; i < 200; i++) {
  h.change(d => A.splice(d, ['text'], i, 0, String.fromCharCode(97 + i % 26)), options('Alice'))
  if ((i + 1) % 20 === 0) checkpoint(h, `Checkpoint ${(i + 1) / 20}`, 'Alice')
}
const closedReviews = doc => { for (const c of commitState(handle(doc)).closed) reviewIssues(A.view(doc, c.snapshotHeads)) }
console.log(JSON.stringify({ scenario: '200 edits, 10 checkpoints', serializedBytes: A.save(h.doc()).length,
  coldSummariesMs: sample(h.doc(), d => commitState(handle(d))), coldReviewMs: sample(h.doc(), reviewIssues),
  coldClosedReviewsMs: sample(h.doc(), closedReviews), cachedClosedReviewsMs: sample(h.doc(), closedReviews, false) }))

const live = handle(make(1000))
commitState(live); reviewIssues(live.doc())
const started = performance.now()
live.change(d => A.splice(d, ['text'], d.text.length, 0, '!'), options('Alice'))
const applied = performance.now()
commitState(live)
const summarized = performance.now()
reviewIssues(live.doc())
console.log(JSON.stringify({ scenario: 'one additional edit after 1000', editMs: +(applied - started).toFixed(2),
  summariesMs: +(summarized - applied).toFixed(2), reviewMs: +(performance.now() - summarized).toFixed(2) }))

// Investigate branch sharing without changing the production storage format.
const repo = new Repo({ network: [] })
try {
  const source = repo.create({ text: '' })
  for (let i = 0; i < 200; i++) source.change(d => A.splice(d, ['text'], i, 0, String.fromCharCode(97 + i % 26)), options('Alice'))
  const documents = [source]
  for (let i = 0; i < 4; i++) documents.push(branchFromCommit(repo, source, null, `Branch ${i}`, 'Alice'))
  const hashes = documents.flatMap(d => A.getChangesMetaSince(d.doc(), []).map(c => c.hash))
  const uniqueBytes = new Map(documents.flatMap(d => A.getAllChanges(d.doc()).map(bytes => [A.decodeChange(bytes).hash, bytes.length])))
  console.log(JSON.stringify({ scenario: 'one source and four branches', totalChangeReferences: hashes.length,
    uniqueChanges: new Set(hashes).size, uniqueUnpackedChangeBytes: [...uniqueBytes.values()].reduce((sum, size) => sum + size, 0), totalSerializedBytes: documents.reduce((sum, d) => sum + A.save(d.doc()).length, 0) }))
} finally { await repo.shutdown() }
