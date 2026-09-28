import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Repo } from '@automerge/automerge-repo'
import * as A from '@automerge/automerge'
import { changeOptions } from '../versioning.js'
import { reviewIssues, resolveIssue } from '../conflicts.js'

const edit = (handle, value, author) => handle.change(d => A.updateText(d, ['text'], value), changeOptions({ author, userId: author }, { kind: 'edit', openCommitId: 'shared' }))
async function setup(run) {
  const repo = new Repo({ network: [] })
  try { await run(repo) } finally { await repo.shutdown() }
}
function typeReplacement(handle, start, count, value, author) {
  for (let i = 0; i < count; i++) {
    const text = handle.doc().text
    edit(handle, text.slice(0, start) + text.slice(start + 1), author)
  }
  for (const char of value) {
    const text = handle.doc().text
    edit(handle, text.slice(0, start) + char + text.slice(start), author)
    start += char.length
  }
}
function choose(handle, issue, value) {
  resolveIssue(handle, issue, value, 'Reviewer', A.getHeads(handle.doc()), 'shared')
}

test('character-by-character replacements become one review of completed words', () => setup(repo => {
  const left = repo.create({ text: 'A cat sleeps.\nKeep this.' }), right = repo.clone(left)
  typeReplacement(left, 2, 3, 'dog', 'Alice')
  typeReplacement(right, 2, 3, 'fox', 'Bob')
  left.merge(right)
  const issues = reviewIssues(left.doc())
  assert.equal(issues.length, 1)
  assert.equal(issues[0].editCount, 12)
  assert.deepEqual(new Set(issues[0].choices.map(c => c.text)), new Set(['dog', 'fox']))
  choose(left, issues[0], 'dog')
  assert.equal(left.doc().text, 'A dog sleeps.\nKeep this.')
  assert.equal(reviewIssues(left.doc()).length, 0, 'one approval acknowledges all character pairs')
}))

test('offline typing shows completed phrases rather than intermediate prefixes', () => setup(repo => {
  const left = repo.create({ text: '' }), right = repo.clone(left)
  typeReplacement(left, 0, 0, 'hello world', 'Alice')
  typeReplacement(right, 0, 0, 'good morning', 'Bob')
  left.merge(right)
  const issues = reviewIssues(left.doc())
  assert.equal(issues.length, 1)
  assert.deepEqual(new Set(issues[0].choices.map(c => c.text)), new Set(['hello world', 'good morning']))
  choose(left, issues[0], 'hello world')
  assert.equal(left.doc().text, 'hello world')
  assert.equal(reviewIssues(left.doc()).length, 0)
}))

test('three authors sharing a passage get one review with three completed alternatives', () => setup(repo => {
  const first = repo.create({ text: 'cat' }), second = repo.clone(first), third = repo.clone(first)
  typeReplacement(first, 0, 3, 'dog', 'Alice')
  typeReplacement(second, 0, 3, 'fox', 'Bob')
  typeReplacement(third, 0, 3, 'owl', 'Charlie')
  first.merge(second); first.merge(third)
  const issues = reviewIssues(first.doc())
  assert.equal(issues.length, 1)
  assert.equal(issues[0].editCount, 18)
  assert.deepEqual(new Set(issues[0].choices.map(c => c.text)), new Set(['dog', 'fox', 'owl']))
  choose(first, issues[0], 'owl')
  assert.equal(first.doc().text, 'owl')
  assert.equal(reviewIssues(first.doc()).length, 0)
}))

test('two passages changed in one input stay independently reviewable', () => setup(repo => {
  const first = repo.create({ text: 'A cat sleeps.\n\nAn owl flies.\nUntouched.' }), second = repo.clone(first)
  edit(first, 'A dog sleeps.\n\nAn eagle flies.\nUntouched.', 'Alice')
  edit(second, 'A fox sleeps.\n\nAn ibis flies.\nUntouched.', 'Bob')
  first.merge(second)
  let issues = reviewIssues(first.doc())
  assert.equal(issues.length, 2)
  assert.equal(new Set(issues.map(i => i.id)).size, 2)
  const cat = issues.find(i => i.base === 'cat')
  assert.ok(cat)
  choose(first, cat, 'dog')
  issues = reviewIssues(first.doc())
  assert.equal(issues.length, 1, 'resolving one passage must not approve the other passage from the same change pair')
  assert.equal(issues[0].base, 'owl')
  choose(first, issues[0], 'eagle')
  assert.equal(first.doc().text, 'A dog sleeps.\n\nAn eagle flies.\nUntouched.')
  assert.equal(reviewIssues(first.doc()).length, 0)
}))

test('separate typing runs preserve unrelated edits outside the reviewed passage', () => setup(repo => {
  const first = repo.create({ text: 'cat\n\nTail.' }), second = repo.clone(first)
  typeReplacement(first, 0, 3, 'dog', 'Alice')
  edit(first, first.doc().text + ' Alice note.', 'Alice')
  typeReplacement(second, 0, 3, 'fox', 'Bob')
  first.merge(second)
  const issues = reviewIssues(first.doc())
  assert.equal(issues.length, 1)
  assert.deepEqual(new Set(issues[0].choices.map(c => c.text)), new Set(['dog', 'fox']))
  choose(first, issues[0], 'fox')
  assert.equal(first.doc().text, 'fox\n\nTail. Alice note.')
}))

test('late typing extends the passage and is not silently approved by an earlier batch decision', () => setup(repo => {
  const first = repo.create({ text: 'cat' }), second = repo.clone(first)
  typeReplacement(first, 0, 3, 'dog', 'Alice')
  typeReplacement(second, 0, 3, 'fox', 'Bob')
  first.merge(second)
  choose(first, reviewIssues(first.doc())[0], 'dog')
  edit(second, 'foxes', 'Bob')
  first.merge(second)
  assert.ok(reviewIssues(first.doc()).length > 0)
}))

test('batch choices and identities converge regardless of merge order', () => setup(repo => {
  const first = repo.create({ text: 'cat' }), second = repo.clone(first), third = repo.clone(first)
  typeReplacement(first, 0, 3, 'dog', 'Alice')
  typeReplacement(second, 0, 3, 'fox', 'Bob')
  typeReplacement(third, 0, 3, 'owl', 'Charlie')
  const other = repo.clone(first)
  first.merge(second); first.merge(third)
  other.merge(third); other.merge(second)
  const summary = handle => reviewIssues(handle.doc()).map(i => ({ id: i.id, choices: i.choices, editCount: i.editCount }))
  assert.deepEqual(summary(first), summary(other))
}))

test('legacy individual approvals are recognized by batched review', () => setup(repo => {
  const first = repo.create({ text: 'cat' }), second = repo.clone(first)
  edit(first, 'dog', 'Alice'); edit(second, 'fox', 'Bob')
  const pair = [A.getHeads(first.doc())[0], A.getHeads(second.doc())[0]].sort()
  first.merge(second)
  first.change(d => { d['resolution:legacy'] = { issueId: `overlap:${pair.join(':')}`, author: 'Reviewer', value: d.text } })
  assert.equal(reviewIssues(first.doc()).length, 0)
}))
