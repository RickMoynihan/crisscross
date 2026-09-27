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

// Branches of the index itself: registered on the root, and a branch's
// entries are re-keyed under their clone's URL with fork provenance and a
// stable family identity.
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
assert.equal(branchDoc.docs["automerge:branch-a-clone"].rootDoc, "url-a")
assert.equal(branchDoc.branchOf.name, "release")

// familyOf/findByFamily let the UI find "the same document" across
// branches: a never-forked document is its own family.
assert.equal(Index.familyOf(doc, "url-a"), "url-a")
assert.equal(Index.familyOf(branchDoc, "automerge:branch-a-clone"), "url-a")
assert.equal(Index.findByFamily(branchDoc, "url-a"), "automerge:branch-a-clone")
assert.equal(Index.findByFamily(branchDoc, "url-nonexistent"), undefined)

// Re-forking a branch's document carries the original family forward, so
// finding "the same document" still works across a branch of a branch.
let rebranchDoc = A.clone(branchDoc)
rebranchDoc = A.change(rebranchDoc, (d) => Index.rekeyAsFork(d, "automerge:branch-a-clone", "automerge:branch-a-clone-2", ["head-a-2"]))
assert.equal(rebranchDoc.docs["automerge:branch-a-clone-2"].rootDoc, "url-a")
assert.equal(Index.findByFamily(rebranchDoc, "url-a"), "automerge:branch-a-clone-2")

console.log("ok: index")
