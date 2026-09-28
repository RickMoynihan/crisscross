import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Repo } from '@automerge/automerge-repo'
import * as A from '@automerge/automerge'
import { commitState, checkpoint, branchFromCommit, mergeBranch, changeOptions } from '../versioning.js'
import { branchInfo } from '../branches.js'
import { reviewIssues, resolveIssue, currentPassage } from '../conflicts.js'

const alice = { author: 'Alice', userId: 'alice' }, bob = { author: 'Bob', userId: 'bob' }
function edit(handle, value, who = alice) {
  handle.change(d => A.updateText(d, ['text'], value), changeOptions(who, { kind: 'edit', openCommitId: commitState(handle).open.id }))
}
async function setup(run) {
  const repo = new Repo({ network: [] })
  try { await run(repo) } finally { await repo.shutdown() }
}

test('shared open commit counts both authors, excludes control changes, and freezes a checkpoint', () => setup(repo => {
  const main = repo.create({ text: '' }), remote = repo.clone(main)
  edit(main, 'Hello', alice); edit(remote, 'World', bob)
  main.merge(remote)
  const before = main.doc().text
  assert.deepEqual(commitState(main).open.contributors.map(p => [p.name, p.count]).sort(), [['Alice', 1], ['Bob', 1]])
  const saved = checkpoint(main, 'Greeting', alice)
  assert.equal(A.view(main.doc(), saved.snapshotHeads).text, before)
  assert.equal(commitState(main).closed[0].edits.length, 2)
  assert.equal(commitState(main).open.edits.length, 0)
  edit(main, before + '!')
  assert.equal(A.view(main.doc(), saved.snapshotHeads).text, before)
  assert.equal(commitState(main).open.edits.length, 1)
  assert.equal(commitState(main).open.lateEdits.length, 0)
}))

test('late offline edits enter the successor without changing checkpoint membership', () => setup(repo => {
  const main = repo.create({ text: 'base' }), remote = repo.clone(main)
  edit(main, 'base A')
  const saved = checkpoint(main, 'First', alice)
  edit(remote, 'base B', bob)
  main.merge(remote)
  const state = commitState(main)
  assert.equal(A.view(main.doc(), saved.snapshotHeads).text, 'base A')
  assert.equal(state.closed[0].edits.length, 1)
  assert.equal(state.open.edits.length, 1)
  assert.equal(state.open.lateEdits.length, 1)
}))

test('simultaneous checkpoints survive and converge to one open successor with two parents', () => setup(repo => {
  const main = repo.create({ text: 'base' }), remote = repo.clone(main)
  // Same URL on separate replicas: branch identity is distinct from actor identity.
  const replica = { url: main.url, doc: () => remote.doc(), change: (...args) => remote.change(...args) }
  edit(main, 'left'); edit(replica, 'right', bob)
  const a = checkpoint(main, 'A', alice), b = checkpoint(replica, 'B', bob)
  main.merge(remote); remote.merge(main)
  const state = commitState(main), other = commitState(replica)
  assert.deepEqual(state.open.parentIds, [a.id, b.id].sort())
  assert.equal(state.open.id, other.open.id)
  assert.equal(state.open.edits.length, 0)
  const joined = checkpoint(main, 'Joined', alice)
  assert.deepEqual(joined.parentIds, [a.id, b.id].sort())
  assert.deepEqual(commitState(main).open.parentIds, [joined.id])
}))

test('head branching closes the source and historic branching does not touch it', () => setup(repo => {
  const main = repo.create({ text: 'base' })
  edit(main, 'checkpoint me')
  const branch = branchFromCommit(repo, main, null, 'Alternative', alice)
  const saved = commitState(main).closed[0]
  assert.equal(branch.doc().text, 'checkpoint me')
  assert.deepEqual(commitState(branch).open.parentIds, [saved.id])
  assert.equal(commitState(branch).open.edits.length, 0)
  edit(main, 'later'); edit(branch, 'alternative', bob)
  const before = commitState(main).closed.length
  const old = branchFromCommit(repo, main, saved, 'Historic', alice)
  assert.equal(old.doc().text, 'checkpoint me')
  assert.equal(commitState(main).closed.length, before)
  assert.equal(main.doc().text, 'later')
  assert.equal(checkpoint(old, '', alice).id, saved.id, 'empty successor reuses its parent')
}))

test('merge captures both parents, keeps identity, excludes future source edits, and is idempotent', () => setup(repo => {
  const main = repo.create({ text: 'base' })
  const branch = branchFromCommit(repo, main, null, 'Alternative', alice)
  edit(main, 'base main')
  edit(branch, 'branch base', bob)
  const result = mergeBranch(main, branch, alice)
  assert.ok(result)
  assert.equal(branchInfo(main), null)
  assert.equal(branchInfo(branch).name, 'Alternative')
  assert.deepEqual(commitState(main).open.parentIds, [result.left.id, result.right.id].sort())
  assert.ok(main.doc().text.includes('main'))
  assert.ok(main.doc().text.includes('branch'))
  const joined = checkpoint(main, 'Merged', alice)
  assert.deepEqual(joined.parentIds, [result.left.id, result.right.id].sort())
  assert.deepEqual(commitState(main).open.parentIds, [joined.id])
  const heads = A.getHeads(main.doc())
  assert.equal(mergeBranch(main, branch, alice), null)
  assert.deepEqual(A.getHeads(main.doc()), heads)
  edit(branch, branch.doc().text + ' future', bob)
  assert.ok(!main.doc().text.includes('future'))
}))

test('overlapping text edits are reviewable and resolution preserves unrelated text and history', () => setup(repo => {
  const main = repo.create({ text: 'A cat sleeps. Tail.' }), remote = repo.clone(main)
  edit(main, 'A dog sleeps. Tail.', alice); edit(remote, 'A fox sleeps. Tail.', bob)
  main.merge(remote)
  const issues = reviewIssues(main.doc())
  assert.equal(issues.length, 1)
  const issue = issues[0]
  assert.equal(issue.kind, 'review')
  assert.ok(issue.choices.some(c => c.text.includes('dog')))
  const closed = checkpoint(main, 'Conflicted', alice)
  const current = currentPassage(main.doc(), issue)
  const expected = main.doc().text.slice(0, current.start) + issue.choices[0].text + main.doc().text.slice(current.end)
  resolveIssue(main, issue, issue.choices[0].text, alice, A.getHeads(main.doc()), commitState(main).open.id)
  assert.equal(main.doc().text, expected)
  assert.ok(main.doc().text.endsWith(' sleeps. Tail.'))
  assert.equal(reviewIssues(main.doc()).length, 0)
  assert.equal(reviewIssues(A.view(main.doc(), closed.snapshotHeads)).length, 1)
  assert.equal(commitState(main).open.edits.length, 1)
}))

test('non-overlapping concurrent edits do not create review issues; stale resolutions are rejected', () => setup(repo => {
  const main = repo.create({ text: 'cat and dog' }), remote = repo.clone(main)
  edit(main, 'fox and dog'); edit(remote, 'cat and owl', bob)
  main.merge(remote)
  assert.equal(reviewIssues(main.doc()).length, 0)
  const fork = repo.clone(main)
  edit(main, 'rat and owl'); edit(fork, 'bat and owl', bob)
  main.merge(fork)
  const issue = reviewIssues(main.doc())[0], heads = A.getHeads(main.doc())
  assert.ok(issue)
  edit(main, main.doc().text + '!')
  const before = main.doc().text
  assert.throws(() => resolveIssue(main, issue, 'cat', alice, heads), /document changed/)
  assert.equal(main.doc().text, before)
}))

test('simultaneous differing resolutions create a new review issue', () => setup(repo => {
  const main = repo.create({ text: 'cat' }), remote = repo.clone(main)
  edit(main, 'dog'); edit(remote, 'fox', bob); main.merge(remote)
  const issue = reviewIssues(main.doc())[0], other = repo.clone(main)
  resolveIssue(main, issue, 'wolf', alice, A.getHeads(main.doc()), commitState(main).open.id)
  resolveIssue(other, issue, 'bear', bob, A.getHeads(other.doc()), commitState(other).open.id)
  main.merge(other)
  assert.ok(reviewIssues(main.doc()).length > 0)
  assert.ok(reviewIssues(main.doc()).every(i => i.id !== issue.id))
}))

test('Unicode review keeps whole characters and surrounding text intact', () => setup(repo => {
  const main = repo.create({ text: 'Hi 😀! 🌲' }), remote = repo.clone(main)
  edit(main, 'Hi 😁! 🌲'); edit(remote, 'Hi 😂! 🌲', bob); main.merge(remote)
  const issue = reviewIssues(main.doc())[0]
  assert.ok(issue)
  assert.deepEqual(new Set(issue.choices.map(c => c.text)), new Set(['😁', '😂']))
  resolveIssue(main, issue, '😎', alice, A.getHeads(main.doc()), commitState(main).open.id)
  assert.equal(main.doc().text, 'Hi 😎! 🌲')
}))

test('choosing the displayed property value still resolves its competing values', () => setup(repo => {
  const main = repo.create({ text: 'base' }), remote = repo.clone(main)
  main.change(d => { d.text = 'left' }, changeOptions(alice))
  remote.change(d => { d.text = 'right' }, changeOptions(bob))
  main.merge(remote)
  const issue = reviewIssues(main.doc()).find(i => i.kind === 'conflict')
  assert.ok(issue)
  const value = main.doc().text, conflictingHeads = A.getHeads(main.doc())
  resolveIssue(main, issue, value, alice, A.getHeads(main.doc()), commitState(main).open.id)
  assert.equal(main.doc().text, value)
  assert.equal(A.getConflicts(main.doc(), 'text'), undefined)
  assert.equal(reviewIssues(main.doc()).length, 0)
  assert.equal(reviewIssues(A.view(main.doc(), conflictingHeads))[0].kind, 'conflict')
}))

test('accepting a merged passage with no text changes can still be checkpointed', () => setup(repo => {
  const main = repo.create({ text: 'cat' }), remote = repo.clone(main)
  edit(main, 'dog'); edit(remote, 'fox', bob); main.merge(remote)
  const first = checkpoint(main, 'Review needed', alice)
  const issue = reviewIssues(main.doc())[0]
  resolveIssue(main, issue, currentPassage(main.doc(), issue).text, alice, A.getHeads(main.doc()), commitState(main).open.id)
  assert.equal(reviewIssues(main.doc()).length, 0)
  const second = checkpoint(main, '', alice)
  assert.notEqual(first.id, second.id)
  assert.equal(reviewIssues(A.view(main.doc(), second.snapshotHeads)).length, 0)
}))

test('fast-forward merge records both parents and can be checkpointed without another edit', () => setup(repo => {
  const main = repo.create({ text: 'base' })
  const branch = branchFromCommit(repo, main, null, 'Alternative', alice)
  edit(branch, 'changed', bob)
  const merged = mergeBranch(main, branch, alice)
  assert.deepEqual(commitState(main).open.parentIds, [merged.left.id, merged.right.id].sort())
  const saved = checkpoint(main, '', alice)
  assert.notEqual(saved.id, merged.right.id)
  assert.equal(A.view(main.doc(), saved.snapshotHeads).text, 'changed')
}))

test('IME edit against an earlier frontier arrives after closure with its original context', () => setup(repo => {
  const main = repo.create({ text: 'start' })
  const compositionHeads = main.heads(), context = commitState(main).open.id
  const closed = checkpoint(main, 'During composition', bob)
  main.changeAt(compositionHeads, d => A.updateText(d, ['text'], 'start 日本語'), changeOptions(alice, { kind: 'edit', openCommitId: context }))
  assert.equal(A.view(main.doc(), closed.snapshotHeads).text, 'start')
  assert.equal(commitState(main).open.edits.length, 1)
  assert.equal(commitState(main).open.lateEdits.length, 1)
  assert.equal(main.doc().text, 'start 日本語')
}))

test('merging imports review decisions even when the source text has not changed', () => setup(repo => {
  const main = repo.create({ text: 'cat' }), remote = repo.clone(main)
  edit(main, 'dog'); edit(remote, 'fox', bob); main.merge(remote)
  const branch = branchFromCommit(repo, main, null, 'Review', alice)
  const issue = reviewIssues(branch.doc())[0]
  resolveIssue(branch, issue, currentPassage(branch.doc(), issue).text, bob, A.getHeads(branch.doc()), commitState(branch).open.id)
  assert.equal(reviewIssues(main.doc()).length, 1)
  assert.equal(branch.doc().text, main.doc().text)
  assert.ok(mergeBranch(main, branch, alice))
  assert.equal(reviewIssues(main.doc()).length, 0)
}))

test('new checkpoints do not repeat already-consumed merge IDs', () => setup(repo => {
  const main = repo.create({ text: 'base' }), branch = branchFromCommit(repo, main, null, 'Alternative', alice)
  edit(branch, 'base branch', bob)
  mergeBranch(main, branch, alice)
  const merged = checkpoint(main, 'Merged', alice)
  assert.equal(merged.mergeIds.length, 1)
  edit(main, main.doc().text + '!')
  assert.deepEqual(checkpoint(main, 'Later checkpoint', alice).mergeIds, [])
  edit(branch, branch.doc().text + ' again', bob)
  mergeBranch(main, branch, alice)
  const again = checkpoint(main, 'Merged again', alice)
  assert.equal(again.mergeIds.length, 1)
  assert.notEqual(again.mergeIds[0], merged.mergeIds[0])
}))
