import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Repo } from '@automerge/automerge-repo'
import * as A from '@automerge/automerge'
import { createBranch, branchLinks } from '../branches.js'
import { branchHistory } from '../branch-history.js'
import { textEdits } from '../changes.js'

const edit = (handle, text) => handle.change(d => A.updateText(d, ['text'], text), {
  time: 100, message: JSON.stringify({ author: 'Alice' }),
})

test('explicit tracks share ancestry, split runs at saved forks, and preserve snapshot states', async () => {
  const repo = new Repo({ network: [] })
  try {
    const main = repo.create({ text: '' })
    edit(main, 'A'); const first = A.getHeads(main.doc())
    edit(main, 'AB'); const second = A.getHeads(main.doc())
    edit(main, 'ABC')
    const branch = createBranch(repo, main, first, 'Alternative', 'Alice')
    edit(branch, 'A alternative')
    const sibling = createBranch(repo, main, second, 'Second', 'Bob')
    const nested = createBranch(repo, branch, A.getHeads(branch.doc()), 'Nested', 'Bob')
    const { nodes, edges } = branchHistory([main, branch, sibling, nested])
    assert.equal(nodes.filter(n => n.type === 'tip').length, 4)
    assert.equal(nodes.filter(n => n.type === 'fork').length, 3)
    assert.equal(new Set(nodes.filter(n => n.type === 'tip').map(n => n.lane)).size, 4)
    const root = A.getAllChanges(main.doc()).map(A.decodeChange)[0].hash
    assert.equal(nodes.filter(n => n.type === 'edit' && n.changes.some(c => c.hash === root)).length, 1)
    const byId = new Map(nodes.map(n => [n.id, n]))
    for (const edge of edges) assert.ok(byId.get(edge.from).row < byId.get(edge.to).row)
    const fork = nodes.find(n => n.type === 'fork' && n.branchUrl === branch.url)
    assert.equal(A.view(fork.doc, fork.afterHeads).text, 'A')
    const sourceEntry = nodes.find(n => n.type === 'edit' && n.url === main.url && n.hash === first[0])
    assert.ok(sourceEntry)
    assert.deepEqual(textEdits(sourceEntry.doc, sourceEntry), [{ kind: 'inserted', text: 'A' }])
    assert.ok(branchLinks(main).some(link => link.url === branch.url))
    assert.ok(branchLinks(branch).some(link => link.url === main.url))
    assert.ok(!branchLinks(sibling).some(link => link.url === branch.url))
  } finally { await repo.shutdown() }
})

test('simultaneous branch registrations converge without losing a branch', async () => {
  const a = new Repo({ network: [] }), b = new Repo({ network: [] })
  try {
    const main = a.create({ text: 'base' })
    const remote = b.import(A.save(main.doc()), { docId: main.documentId })
    const left = createBranch(a, main, A.getHeads(main.doc()), 'Left', 'Alice')
    const right = createBranch(b, remote, A.getHeads(remote.doc()), 'Right', 'Bob')
    main.merge(remote)
    assert.deepEqual(new Set(branchLinks(main).map(link => link.url)), new Set([left.url, right.url]))
  } finally { await a.shutdown(); await b.shutdown() }
})

test('fork snapshots stay exact when source activity later includes unrelated concurrent changes', async () => {
  const repo = new Repo({ network: [] })
  try {
    const main = repo.create({ text: '' }), other = repo.clone(main)
    edit(main, 'Alice')
    const heads = A.getHeads(main.doc())
    const branch = createBranch(repo, main, heads, 'Before Bob', 'Alice')
    edit(other, 'Bob')
    main.merge(other)
    const { nodes } = branchHistory([main, branch])
    const fork = nodes.find(n => n.type === 'fork')
    assert.equal(A.view(fork.doc, fork.afterHeads).text, 'Alice')
    assert.ok(main.doc().text.includes('Bob'))
  } finally { await repo.shutdown() }
})
