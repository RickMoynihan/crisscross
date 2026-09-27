// The index document: the shared, editable list of markdown documents.
//
// Its shape is:
//   {
//     docs: { [docUrl]: { title, order, archived, branches, forkedFrom, forkHeads } },
//     branches: { [name]: { url, createdAt, forkHeads } },
//     branchOf: { root, name },
//   }
//
// Entries live in a map keyed by document URL rather than in a list, and are
// sorted by `order`. Reordering only changes numbers, so concurrent moves by
// different users can never duplicate or drop an entry. "Deleting" sets
// `archived`, so the document itself is never lost.
//
// A document's own URL is its implicit, unnamed "main" branch. Named branches
// are separate Automerge documents created with `repo.clone()`, which share
// causal history with the document as of the fork, so they can later be
// merged back with `handle.merge()`. `forkHeads` records the heads at fork
// time, so the UI can tell whether a branch has any changes yet to merge.
//
// The index document itself can also be branched: this deep-clones the index
// and every document it lists, so the branch is a fully isolated copy of the
// whole list, addressable at its own URL exactly like any other index. Each
// cloned document entry gets `forkedFrom` (the document it was cloned from)
// and its own `forkHeads`, and the branch index itself gets `branchOf` (which
// root index it belongs to, and its name there). Only the root index (the
// one with no `branchOf`) tracks the flat `branches` map of every branch in
// the family, so branches of branches are still siblings for merge purposes.
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

// Named branches of a document, sorted by creation order.
export function branches(doc, url) {
  const map = doc.docs?.[url]?.branches ?? {}
  return Object.keys(map)
    .map((name) => ({ name, url: map[name].url, createdAt: map[name].createdAt, forkHeads: map[name].forkHeads }))
    .sort((a, b) => a.createdAt - b.createdAt || (a.name < b.name ? -1 : 1))
}

// Record a newly created branch. `branchUrl` is the cloned document's URL,
// and `forkHeads` its heads at the moment of cloning (before any changes).
// Vivifies the entry if this document wasn't already in the list.
export function addBranch(d, url, name, branchUrl, forkHeads) {
  if (!d.docs[url]) d.docs[url] = { title: "", order: nextOrder(d), archived: false }
  if (!d.docs[url].branches) d.docs[url].branches = {}
  d.docs[url].branches[name] = { url: branchUrl, createdAt: Date.now(), forkHeads: [...forkHeads] }
}

// Named branches of the index itself, sorted by creation order. Only ever
// populated on a root index (one with no `branchOf`).
export function rootBranches(doc) {
  const map = doc.branches ?? {}
  return Object.keys(map)
    .map((name) => ({ name, url: map[name].url, createdAt: map[name].createdAt, forkHeads: map[name].forkHeads }))
    .sort((a, b) => a.createdAt - b.createdAt || (a.name < b.name ? -1 : 1))
}

// Record a newly created branch of the index, on its root.
export function addRootBranch(d, name, branchUrl, forkHeads) {
  if (!d.branches) d.branches = {}
  d.branches[name] = { url: branchUrl, createdAt: Date.now(), forkHeads: [...forkHeads] }
}

// Used only within a freshly cloned branch index: re-key a document entry
// under its clone's URL, recording where it was forked from (and that
// clone's heads) so a later merge knows where its changes belong.
export function rekeyAsFork(d, oldUrl, newUrl, forkHeads) {
  const e = d.docs[oldUrl]
  if (!e) return
  delete d.docs[oldUrl]
  d.docs[newUrl] = { title: e.title, order: e.order, archived: e.archived, forkedFrom: oldUrl, forkHeads: [...forkHeads] }
}
