// Unit tests for the index document, run offline against plain Automerge docs.
// Concurrent edits are simulated by forking a doc and merging the copies.

import assert from "node:assert/strict"
import { initializeBase64Wasm, Automerge as A } from "@automerge/automerge-repo/slim"
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64"
import * as Index from "../src/index.js"

await initializeBase64Wasm(automergeWasmBase64)

const titles = (doc, archived) => Index.entries(doc, archived).map((e) => e.title)

let doc = A.from(Index.newIndex())
doc = A.change(doc, (d) => ["a", "b", "c", "d"].forEach((t) => Index.add(d, `url-${t}`, t)))
assert.deepEqual(titles(doc), ["a", "b", "c", "d"])

// Reorder, with no-ops at the ends.
doc = A.change(doc, (d) => Index.move(d, "url-c", -1))
assert.deepEqual(titles(doc), ["a", "c", "b", "d"])
doc = A.change(doc, (d) => Index.move(d, "url-a", -1))
doc = A.change(doc, (d) => Index.move(d, "url-d", +1))
assert.deepEqual(titles(doc), ["a", "c", "b", "d"])

// Delete moves to the archive; restore appends to the end of the list.
doc = A.change(doc, (d) => Index.archive(d, "url-c"))
assert.deepEqual(titles(doc), ["a", "b", "d"])
assert.deepEqual(titles(doc, true), ["c"])
doc = A.change(doc, (d) => Index.restore(d, "url-c"))
assert.deepEqual(titles(doc), ["a", "b", "d", "c"])
assert.deepEqual(titles(doc, true), [])

// Concurrent reorders and renames merge without duplicating or losing entries.
let left = A.clone(doc)
let right = A.clone(doc)
left = A.change(left, (d) => Index.move(d, "url-a", +1))
left = A.change(left, (d) => Index.rename(d, "url-b", "bee"))
right = A.change(right, (d) => Index.move(d, "url-c", -1))
right = A.change(right, (d) => Index.rename(d, "url-b", "b!"))
right = A.change(right, (d) => Index.archive(d, "url-d"))
const merged = A.merge(left, right)
assert.deepEqual(A.merge(right, left).docs, merged.docs) // same result either way round
assert.equal(Index.entries(merged).length, 3)
assert.deepEqual(titles(merged, true), ["d"])
assert.equal(merged.docs["url-b"].title, "bee!") // both text edits kept
console.log(titles(merged))

// Branches: recording a fork records its heads, and merging a branch's
// changes back in follows normal CRDT merge rules.
doc = A.change(doc, (d) => Index.addBranch(d, "url-a", "feature", "automerge:branch-a", ["head-a"]))
assert.deepEqual(Index.branches(doc, "url-a").map((b) => b.name), ["feature"])
assert.deepEqual(Index.branches(doc, "url-a")[0].forkHeads, ["head-a"])

// A branch of a document that isn't in the list yet is added to it.
assert.equal(doc.docs["url-e"], undefined)
doc = A.change(doc, (d) => Index.addBranch(d, "url-e", "feature", "automerge:branch-e", []))
assert.equal(doc.docs["url-e"].title, "")
assert.deepEqual(Index.branches(doc, "url-e").map((b) => b.name), ["feature"])

// Branches of the index itself: registered on the root, and a branch's
// entries are re-keyed under their clone's URL with fork provenance.
doc = A.change(doc, (d) => Index.addRootBranch(d, "release", "automerge:branch-index", ["head-root"]))
assert.deepEqual(Index.rootBranches(doc).map((b) => b.name), ["release"])
assert.deepEqual(Index.rootBranches(doc)[0].forkHeads, ["head-root"])

let branchDoc = A.clone(doc)
branchDoc = A.change(branchDoc, (d) => {
  Index.rekeyAsFork(d, "url-a", "automerge:branch-a-clone", ["head-a"])
  d.branchOf = { root: "automerge:root", name: "release" }
})
assert.equal(branchDoc.docs["url-a"], undefined)
assert.equal(branchDoc.docs["automerge:branch-a-clone"].forkedFrom, "url-a")
assert.deepEqual(branchDoc.docs["automerge:branch-a-clone"].forkHeads, ["head-a"])
assert.equal(branchDoc.docs["automerge:branch-a-clone"].title, "a")
assert.equal(branchDoc.branchOf.name, "release")

console.log("ok: index")
