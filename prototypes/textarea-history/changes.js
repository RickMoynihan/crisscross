import { Automerge as A } from '@automerge/automerge-repo/slim'

// Patch offsets refer to the progressively updated text, not the initial text.
// Timeline entries compare cumulative states; raw changes compare their causal states.
export function textEdits(doc, change) {
  const before = change.beforeHeads ?? change.deps
  const after = change.afterHeads ?? [change.hash]
  let text = A.view(doc, before).text || ''
  const edits = []
  for (const patch of A.diff(doc, before, after)) {
    if (patch.path[0] !== 'text') continue
    if (patch.path.length === 1) {
      if (patch.action === 'put' || patch.action === 'del') {
        const next = patch.action === 'put' && typeof patch.value === 'string' ? patch.value : ''
        if (text) edits.push({ kind: 'deleted', text })
        if (next) edits.push({ kind: 'inserted', text: next })
        text = next
      }
    } else if (patch.path.length === 2) {
      const index = patch.path[1]
      if (patch.action === 'del') {
        const length = patch.length ?? 1
        edits.push({ kind: 'deleted', text: text.slice(index, index + length) })
        text = text.slice(0, index) + text.slice(index + length)
      } else if (patch.action === 'splice') {
        edits.push({ kind: 'inserted', text: patch.value })
        text = text.slice(0, index) + patch.value + text.slice(index)
      }
    }
  }
  return edits
}

export function describeEdits(edits) {
  // Quoting makes spaces, newlines, tabs and empty-looking edits visible.
  return edits.length ? edits.map(edit => `${edit.kind === 'inserted' ? '+ Inserted' : '− Deleted'}: ${JSON.stringify(edit.text)}`).join('\n') : 'No text changes'
}
