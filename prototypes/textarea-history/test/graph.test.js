import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as A from '@automerge/automerge'
import { layout, activityOrder, sameHeads } from '../graph.js'
import { textEdits } from '../changes.js'
const change = (hash, actor, deps, time = 1) => ({ hash, actor, deps, time, seq: Number(hash.slice(1)) || 1, message: JSON.stringify({ author: actor }) })

test('activity ordering is deterministic and respects dependencies despite clock skew', () => {
  const changes = [change('a1', 'Alice', [], 20), change('b1', 'Bob', ['a1'], 1), change('c1', 'Carol', ['a1'], 1), change('a2', 'Alice', ['b1', 'c1'], 0)]
  const expected = ['a1', 'b1', 'c1', 'a2']
  assert.deepEqual(activityOrder(changes).map(c => c.hash), expected)
  assert.deepEqual(activityOrder([...changes].reverse()).map(c => c.hash), expected)
})

test('adjacent actor runs grow, but split on other actors, inactivity, and selection', () => {
  const changes = [change('a1', 'Alice', []), change('a2', 'Alice', ['a1'], 2), change('a3', 'Alice', ['a2'], 3)]
  const run = layout(changes, { grouped: true }).nodes[0]
  assert.equal(run.hash, 'a3')
  assert.equal(run.changes.length, 3)
  assert.deepEqual(run.beforeHeads, [])
  assert.deepEqual(run.afterHeads, ['a3'])
  assert.equal(layout([...changes, change('a4', 'Alice', ['a3'], 6)], { grouped: true }).nodes.length, 2)
  assert.ok(layout(changes, { grouped: true, selected: 'a2' }).nodes.some(n => n.hash === 'a2'))
  assert.equal(layout([changes[0], change('b1', 'Bob', ['a1']), change('a2', 'Alice', ['b1'])], { grouped: true }).nodes.length, 3)
})

test('concurrent activity accumulates, and entry diffs match adjacent displayed states', () => {
  const base = A.from({ text: '' })
  const options = author => ({ time: 10, message: JSON.stringify({ author }) })
  const alice = A.change(A.clone(base), options('Alice'), d => A.updateText(d, ['text'], 'Alice'))
  const bob = A.change(A.clone(base), options('Bob'), d => A.updateText(d, ['text'], 'Bob'))
  const doc = A.merge(alice, bob)
  const changes = A.getAllChanges(doc).map(A.decodeChange)
  const nodes = layout(changes).nodes.toReversed()
  assert.equal(nodes.at(-1).afterHeads.length, 2)
  assert.ok(sameHeads(nodes.at(-1).afterHeads, A.getHeads(doc)))
  let previousText = ''
  for (const node of nodes) {
    assert.equal(A.view(doc, node.beforeHeads).text || '', previousText)
    const text = A.view(doc, node.afterHeads).text || ''
    assert.ok(text.includes(previousText))
    const edits = textEdits(doc, node)
    if (node.row !== nodes.length - 1) assert.deepEqual(edits, [{ kind: 'inserted', text: A.view(doc, [node.hash]).text }])
    previousText = text
  }
  assert.equal(previousText, doc.text)
  // A late concurrent insertion changes the timeline prefix but not a captured snapshot.
  const captured = [...nodes.at(-1).afterHeads]
  const carol = A.change(A.clone(base), { time: 1 }, d => A.updateText(d, ['text'], 'Carol'))
  const updated = A.merge(doc, carol)
  assert.equal(A.view(updated, captured).text, doc.text)
  const entry = layout(A.getAllChanges(updated).map(A.decodeChange)).nodes.find(n => n.hash === nodes.at(-1).hash)
  assert.ok(!sameHeads(captured, entry.afterHeads))
})
