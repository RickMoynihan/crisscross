import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as A from '@automerge/automerge'
import { textEdits, describeEdits } from '../changes.js'
const latest = doc => A.decodeChange(A.getLastLocalChange(doc))

test('reports insertions, deletions, Unicode and whitespace without unrelated text', () => {
  let doc = A.from({ text: 'hello 😀 world' })
  doc = A.change(doc, d => A.updateText(d, ['text'], 'hello 🌍 world\n'))
  assert.deepEqual(new Set(textEdits(doc, latest(doc)).map(e => JSON.stringify(e))), new Set([
    { kind: 'deleted', text: '😀' },
    { kind: 'inserted', text: '🌍' },
    { kind: 'inserted', text: '\n' },
  ].map(e => JSON.stringify(e))))
  assert.match(describeEdits(textEdits(doc, latest(doc))), /Inserted: "\\n"/)
})

test('isolates concurrent edits and compares a joining change with all its dependencies', () => {
  const base = A.from({ text: 'hello' })
  const alice = A.change(A.clone(base), d => A.updateText(d, ['text'], 'hello Alice'))
  const bob = A.change(A.clone(base), d => A.updateText(d, ['text'], 'hello Bob'))
  let merged = A.merge(alice, bob)
  assert.deepEqual(textEdits(merged, latest(bob)), [{ kind: 'inserted', text: ' Bob' }])
  merged = A.change(merged, d => A.updateText(d, ['text'], d.text + '!'))
  assert.equal(latest(merged).deps.length, 2)
  assert.deepEqual(textEdits(merged, latest(merged)), [{ kind: 'inserted', text: '!' }])
})

test('handles initialization, non-text changes and multiple deletion offsets', () => {
  let doc = A.from({ text: 'hello world' })
  assert.deepEqual(textEdits(doc, latest(doc)), [{ kind: 'inserted', text: 'hello world' }])
  doc = A.change(doc, d => A.updateText(d, ['text'], 'hi world!'))
  const edits = textEdits(doc, latest(doc))
  assert.equal(edits.filter(e => e.kind === 'deleted').map(e => e.text).join(''), 'ello')
  doc = A.change(doc, d => { d.name = 'Alice' })
  assert.equal(describeEdits(textEdits(doc, latest(doc))), 'No text changes')
  const empty = A.from({ text: '' })
  assert.deepEqual(textEdits(empty, latest(empty)), [])
})

test('a run tooltip reports its net edit rather than intermediate typing', async () => {
  const { layout } = await import('../graph.js')
  let doc = A.from({ text: '' })
  for (const value of ['a', 'ab', 'abc', 'ab']) {
    doc = A.change(doc, { time: 10, message: JSON.stringify({ author: 'Alice' }) }, d => A.updateText(d, ['text'], value))
  }
  const { nodes } = layout(A.getAllChanges(doc).map(A.decodeChange), { grouped: true })
  assert.equal(nodes[0].changes.length, 4)
  assert.deepEqual(textEdits(doc, nodes[0]), [{ kind: 'inserted', text: 'ab' }])
})
