import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { Repo, NetworkAdapter } from '@automerge/automerge-repo'
import * as A from '@automerge/automerge'
import { createBranch, registerBranch } from '../branches.js'
import { watchBranches } from '../branch-documents.js'
import { branchHistory } from '../branch-history.js'

async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for branch sync')
    await delay(10)
  }
}

function observe(repo, author) {
  let graph = { nodes: [] }, updates = 0
  const watcher = watchBranches(repo, { author: () => author, onUpdate: () => {
    graph = branchHistory([...watcher.documents.values()])
    updates++
  } })
  return { watcher, graph: () => graph, updates: () => updates }
}

const edit = (doc, text) => doc.change(d => A.updateText(d, ['text'], text))

// Exercise the real Repo sync protocol with asynchronous delivery, without
// depending on the public relay or sharing document objects between users.
class TestNetwork extends NetworkAdapter {
  isReady() { return true }
  whenReady() { return Promise.resolve() }
  connect(peerId) { this.peerId = peerId; this.connected = true }
  disconnect() { this.connected = false }
  peerCandidate(peerId) { this.emit('peer-candidate', { peerId, peerMetadata: {} }) }
  send(message) {
    const copy = structuredClone(message)
    setTimeout(() => {
      if (this.connected && this.other.connected) this.other.emit('message', copy)
    }, 1)
  }
}

test('branch observers update for commits without visible document patches', async () => {
  const repo = new Repo({ network: [] }), view = observe(repo, 'Alice')
  try {
    const main = repo.create({ text: 'base' })
    view.watcher.watch(main)
    await until(() => view.updates() === 1)
    let patches = 0
    main.on('change', () => patches++)
    main.update(doc => A.emptyChange(doc, { message: JSON.stringify({ author: 'Alice', kind: 'commit' }) }))
    const hash = A.getHeads(main.doc())[0]
    await until(() => view.graph().nodes.some(n => n.hash === hash))
    assert.equal(patches, 0, 'the old change subscription misses this commit')
    assert.deepEqual(view.graph().nodes.find(n => n.type === 'tip').afterHeads, [hash])
  } finally { view.watcher.stop(); await repo.shutdown() }
})

test('two users discover new and nested branches and receive live edits and commits on every track', async () => {
  const left = new TestNetwork(), right = new TestNetwork()
  left.other = right; right.other = left
  const alice = new Repo({ network: [left] }), bob = new Repo({ network: [right] })
  left.peerCandidate(bob.peerId); right.peerCandidate(alice.peerId)
  const a = observe(alice, 'Alice'), b = observe(bob, 'Bob')
  try {
    const main = alice.create({ text: 'base' })
    a.watcher.watch(main)
    b.watcher.watch(await bob.find(main.url))
    const branch = createBranch(alice, main, A.getHeads(main.doc()), 'Alternative', 'Alice')
    await until(() => b.watcher.documents.has(branch.url) && a.watcher.documents.has(branch.url))
    const remoteBranch = b.watcher.documents.get(branch.url)
    edit(branch, 'Alice live edit')
    await until(() => remoteBranch.doc().text === 'Alice live edit')
    edit(remoteBranch, 'Alice live edit + Bob')
    await until(() => branch.doc().text === 'Alice live edit + Bob')
    const pinnedHeads = A.getHeads(branch.doc())
    const pinnedText = branch.doc().text
    const nested = createBranch(bob, remoteBranch, pinnedHeads, 'Nested', 'Bob')
    await until(() => a.watcher.documents.has(nested.url))
    edit(nested, 'nested live edit')
    edit(main, 'main live edit')
    branch.change(doc => { doc.checkpoint = 'Saved by Alice' }, {
      message: JSON.stringify({ author: 'Alice', kind: 'commit' }),
    })
    const commit = A.getHeads(branch.doc())[0]
    await until(() => b.graph().nodes.some(n => n.hash === commit) &&
      a.watcher.documents.get(nested.url).doc().text === 'nested live edit' &&
      b.watcher.documents.get(main.url).doc().text === 'main live edit')
    for (const view of [a, b]) {
      assert.equal(view.graph().nodes.filter(n => n.type === 'tip').length, 3)
      assert.deepEqual(view.graph().nodes.find(n => n.type === 'tip' && n.url === branch.url).afterHeads, [commit])
      assert.equal(A.view(view.watcher.documents.get(branch.url).doc(), pinnedHeads).text, pinnedText)
    }
  } finally {
    a.watcher.stop(); b.watcher.stop()
    await alice.shutdown(); await bob.shutdown()
  }
})

test('a branch link arriving before its document recovers without a reload', async () => {
  const repo = new Repo({ network: [] }), offline = new Repo({ network: [] })
  const view = observe(repo, 'Alice')
  try {
    const main = repo.create({ text: 'base' })
    const source = offline.import(A.save(main.doc()), { docId: main.documentId })
    const branch = createBranch(offline, source, A.getHeads(source.doc()), 'Delayed', 'Bob')
    view.watcher.watch(main)
    registerBranch(main, branch, 'Bob')
    await until(() => view.watcher.unavailable.has(branch.url))
    repo.import(A.save(branch.doc()), { docId: branch.documentId })
    view.watcher.unavailable.set(branch.url, 0)
    view.watcher.retry()
    await until(() => view.graph().nodes.some(n => n.type === 'tip' && n.url === branch.url))
    assert.equal(view.watcher.unavailable.size, 0)
    edit(view.watcher.documents.get(branch.url), 'recovered live edit')
    await until(() => view.graph().nodes.some(n => n.type === 'edit' && n.doc.text === 'recovered live edit'))
  } finally { view.watcher.stop(); await repo.shutdown(); await offline.shutdown() }
})

test('independent users sync checkpoints and converge on the same shared open commit', async () => {
  const { commitState, checkpoint, changeOptions } = await import('../versioning.js')
  const left = new TestNetwork(), right = new TestNetwork()
  left.other = right; right.other = left
  const alice = new Repo({ network: [left] }), bob = new Repo({ network: [right] })
  left.peerCandidate(bob.peerId); right.peerCandidate(alice.peerId)
  try {
    const main = alice.create({ text: 'base' }), remote = await bob.find(main.url)
    await until(() => remote.doc()?.text === 'base')
    // Synchronous local actions on both replicas precede asynchronous delivery.
    const firstContext = commitState(main).open.id
    main.change(d => A.updateText(d, ['text'], 'Alice base'), changeOptions({ author: 'Alice', userId: 'alice' }, { openCommitId: firstContext }))
    remote.change(d => A.updateText(d, ['text'], 'base Bob'), changeOptions({ author: 'Bob', userId: 'bob' }, { openCommitId: firstContext }))
    const first = checkpoint(main, 'Alice checkpoint', 'Alice')
    const second = checkpoint(remote, 'Bob checkpoint', 'Bob')
    await until(() => commitState(main).closed.length === 2 && commitState(remote).closed.length === 2)
    assert.deepEqual(commitState(main).open.parentIds, [first.id, second.id].sort())
    assert.equal(commitState(main).open.id, commitState(remote).open.id)
    assert.equal(main.doc().text, remote.doc().text)
    const nextContext = commitState(remote).open.id
    remote.change(d => A.updateText(d, ['text'], d.text + '!'), changeOptions({ author: 'Bob', userId: 'bob' }, { openCommitId: nextContext }))
    await until(() => commitState(main).open.edits.length === 1)
    assert.equal(commitState(main).open.contributors[0].name, 'Bob')
    const joined = checkpoint(main, 'Joined', 'Alice')
    await until(() => commitState(remote).open.parentIds.length === 1 && commitState(remote).open.parentIds[0] === joined.id)
    assert.equal(A.view(remote.doc(), first.snapshotHeads).text, 'Alice base')
    assert.equal(A.view(remote.doc(), second.snapshotHeads).text, 'base Bob')
    // Reload into a new actor without losing commit records or immutable membership.
    const reloaded = bob.import(A.save(remote.doc()))
    assert.equal(A.view(reloaded.doc(), joined.snapshotHeads).text, main.doc().text)
  } finally { await alice.shutdown(); await bob.shutdown() }
})
