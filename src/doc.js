// Document logic shared by the browser app and the sync test.
//
// The document shape is:
//   { text: "<markdown>", users: { [username]: { color } } }
//
// Authorship is recorded with Automerge "marks": every insert is marked with
// { author: username } over the inserted range, and the marks merge like the
// rest of the CRDT when users edit concurrently.

import { Automerge as A } from "@automerge/automerge-repo/slim"

export const TEXT = ["text"]

// Deterministic colour for a username, so the same user always gets the same colour.
export function colorFor(name) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return `hsl(${h % 360} 70% 38%)`
}

export function join(handle, name) {
  handle.change((d) => {
    if (!d.users) d.users = {}
    if (!d.users[name]) d.users[name] = { color: colorFor(name) }
    if (typeof d.text !== "string") d.text = ""
  })
}

// Turn an edit of the whole string (old -> new) into a single splice by
// trimming the common prefix and suffix. Good enough for textarea input
// events, which are always one contiguous change.
export function diff(oldText, newText) {
  let start = 0
  const max = Math.min(oldText.length, newText.length)
  while (start < max && oldText[start] === newText[start]) start++
  let oldEnd = oldText.length
  let newEnd = newText.length
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  return { start, del: oldEnd - start, insert: newText.slice(start, newEnd) }
}

export function applyEdit(handle, name, newText) {
  handle.change((d) => {
    const { start, del, insert } = diff(d.text, newText)
    if (del === 0 && insert === "") return
    A.splice(d, TEXT, start, del, insert)
    if (insert.length) {
      A.mark(d, TEXT, { start, end: start + insert.length, expand: "none" }, "author", name)
    }
  })
}

// Split the text into runs of [text, author|null] for rendering.
export function segments(doc) {
  const text = doc.text ?? ""
  const authors = new Array(text.length).fill(null)
  for (const m of A.marks(doc, TEXT)) {
    if (m.name !== "author") continue
    for (let i = m.start; i < m.end && i < text.length; i++) authors[i] = m.value
  }
  const runs = []
  for (let i = 0; i < text.length; i++) {
    const last = runs[runs.length - 1]
    if (last && last[1] === authors[i]) last[0] += text[i]
    else runs.push([text[i], authors[i]])
  }
  return runs
}
