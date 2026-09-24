// End-to-end check: two independent repos edit the same document through the
// public sync server and converge, with authorship preserved.
// Run with: npm test

import assert from "node:assert/strict"
import { Repo, initializeBase64Wasm } from "@automerge/automerge-repo/slim"
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64"
import { applyEdit, join, segments } from "../src/doc.js"

const SYNC_URL = process.env.SYNC_URL ?? "wss://sync.automerge.org"

await initializeBase64Wasm(automergeWasmBase64)

const newRepo = () => new Repo({ network: [new WebSocketClientAdapter(SYNC_URL)] })
const until = async (fn, ms = 15000) => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for sync")
    await new Promise((r) => setTimeout(r, 100))
  }
}

const alice = newRepo()
const bob = newRepo()

const a = alice.create({ text: "", users: {} })
join(a, "alice")
applyEdit(a, "alice", "# Hello\n")

// Alice's upload to the server races Bob's request, so retry until it lands.
let b
for (let tries = 0; !b; tries++) {
  try {
    b = await bob.find(a.url)
  } catch (e) {
    if (tries >= 5) throw e
    await new Promise((r) => setTimeout(r, 1000))
  }
}
join(b, "bob")
await until(() => b.doc().text === "# Hello\n")

// Concurrent edits from both sides.
applyEdit(a, "alice", "# Hello\nfrom alice\n")
applyEdit(b, "bob", "# Hello world\n")

await until(() => a.doc().text === b.doc().text && a.doc().text.includes("alice") && a.doc().text.includes("world"))

const text = a.doc().text
console.log(JSON.stringify(text))
console.log(segments(a.doc()))
assert.equal(text, "# Hello world\nfrom alice\n")
assert.deepEqual(segments(a.doc()), segments(b.doc()))
assert.deepEqual(
  segments(a.doc()).map(([, who]) => who),
  ["alice", "bob", "alice"],
)
assert.deepEqual(Object.keys(a.doc().users).sort(), ["alice", "bob"])

console.log("ok: synced via", SYNC_URL)
alice.shutdown()
bob.shutdown()
process.exit(0)
