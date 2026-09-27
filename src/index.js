// The index document: the shared, editable list of markdown documents.
//
// Its shape is:
//   { docs: { [docUrl]: { title, order, archived } } }
//
// Entries live in a map keyed by document URL rather than in a list, and are
// sorted by `order`. Reordering only changes numbers, so concurrent moves by
// different users can never duplicate or drop an entry. "Deleting" sets
// `archived`, so the document itself is never lost.
//
// These functions take a mutable doc, e.g. handle.change((d) => add(d, ...)).

import { Automerge as A } from "@automerge/automerge-repo/slim"

export const newIndex = () => ({ docs: {} })

export const isIndex = (doc) => !!doc && typeof doc.docs === "object"

export const titlePath = (url) => ["docs", url, "title"]

// Entries sorted for display. Ties (possible after concurrent moves) are
// broken by URL, so every user sees the same order.
export function entries(doc, archived = false) {
  return Object.keys(doc.docs ?? {})
    .map((url) => ({ url, title: doc.docs[url].title, order: doc.docs[url].order, archived: !!doc.docs[url].archived }))
    .filter((e) => e.archived === archived)
    .sort((a, b) => a.order - b.order || (a.url < b.url ? -1 : 1))
}

const nextOrder = (d) => Math.max(0, ...Object.values(d.docs).map((e) => e.order)) + 1

export function add(d, url, title) {
  d.docs[url] = { title, order: nextOrder(d), archived: false }
}

export function rename(d, url, title) {
  if (d.docs[url]) A.updateText(d, titlePath(url), title)
}

// Move an entry up (delta -1) or down (+1) in the active list.
export function move(d, url, delta) {
  const list = entries(d)
  const i = list.findIndex((e) => e.url === url)
  const j = i + delta
  if (i < 0 || j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j], list[i]]
  list.forEach((e, k) => {
    if (d.docs[e.url].order !== k + 1) d.docs[e.url].order = k + 1
  })
}

export function archive(d, url) {
  if (d.docs[url]) d.docs[url].archived = true
}

export function restore(d, url) {
  if (!d.docs[url]) return
  d.docs[url].archived = false
  d.docs[url].order = nextOrder(d)
}
