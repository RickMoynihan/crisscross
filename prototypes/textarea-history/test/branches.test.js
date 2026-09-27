import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Repo } from '@automerge/automerge-repo'
import * as A from '@automerge/automerge'
import { createBranch } from '../branches.js'

test('branches preserve only selected causal history and edit independently', async () => {
  const repo = new Repo({ network: [] })
  try {
    const source = repo.create({ text: 'original' })
    const fork = A.getHeads(source.doc())[0]
    source.change(d => A.updateText(d, ['text'], 'later source edit'))
    const excluded = A.getHeads(source.doc())[0]
    const branch = createBranch(repo, source, fork, 'Alternative', 'Alice')
    assert.notEqual(branch.url, source.url)
    assert.equal(branch.doc().text, 'original')
    assert.deepEqual({ ...branch.doc().branch }, { name: 'Alternative', source: source.url, forkHash: fork, forkHeads: [fork] })
    const hashes = A.getAllChanges(branch.doc()).map(bytes => A.decodeChange(bytes).hash)
    assert.ok(hashes.includes(fork))
    assert.ok(!hashes.includes(excluded))
    branch.change(d => A.updateText(d, ['text'], 'branch edit'))
    assert.equal(source.doc().text, 'later source edit')
    const nested = createBranch(repo, branch, A.getHeads(branch.doc())[0], 'Nested', 'Bob')
    assert.equal(nested.doc().branch.source, branch.url)
    assert.equal(branch.doc().branch.name, 'Alternative')
  } finally { await repo.shutdown() }
})


test('branching a cumulative snapshot preserves every visible concurrent edit', async () => {
  const repo = new Repo({ network: [] })
  try {
    const source = repo.create({ text: '' })
    const other = repo.clone(source)
    source.change(d => A.updateText(d, ['text'], 'Alice'))
    other.change(d => A.updateText(d, ['text'], 'Bob'))
    source.merge(other)
    const heads = A.getHeads(source.doc())
    assert.equal(heads.length, 2)
    const snapshotText = source.doc().text
    const branch = createBranch(repo, source, heads, 'Combined snapshot', 'Alice')
    assert.equal(branch.doc().text, snapshotText)
    assert.deepEqual([...branch.doc().branch.forkHeads], heads)
  } finally { await repo.shutdown() }
})
