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

console.log("ok: index")
