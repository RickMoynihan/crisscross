// End-to-end check of the MCP server: start it over stdio as Claude would,
// then list and call its tools against a fresh wiki on the public sync server.

import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const client = new Client({ name: "test", version: "0" })
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../bin/automerge-wiki.js", import.meta.url).pathname, "mcp"],
    env: { ...process.env, AUTOMERGE_WIKI_AUTHOR: "test agent" },
  }),
)

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args })
  return { text: r.content[0].text, isError: !!r.isError }
}

const tools = (await client.listTools()).tools.map((t) => t.name).sort()
assert.deepEqual(tools, [
  "append_to_document",
  "archive_document",
  "create_document",
  "edit_document",
  "list_documents",
  "read_document",
  "rename_document",
  "restore_document",
  "write_document",
])

// A wiki to work in, created through the CLI's library.
const { Wiki } = await import("../src/wiki.js")
const setup = new Wiki({ author: "setup" })
const { url } = await setup.createWiki()
setup.close()
const page = `https://example.test/wiki/#${url}`

let r = await call("create_document", { url: page, title: "Plan", text: "# Plan\n\nStep one.\n" })
assert.match(r.text, /Saved to the sync server/)
const docPage = r.text.match(/Page: (\S+)/)[1]
assert.ok(docPage.startsWith(`https://example.test/wiki/#${url}/automerge:`))

r = await call("edit_document", { url: page, doc: "plan", old_text: "Step one.", new_text: "Step one.\nStep two." })
assert.match(r.text, /Edited "Plan"/)

// A document page URL on its own is enough to read that document.
r = await call("read_document", { url: docPage })
assert.match(r.text, /<document>\n# Plan\n\nStep one.\nStep two.\n\n<\/document>/)
assert.match(r.text, /Authors: test agent/)

r = await call("edit_document", { url: page, doc: "Plan", old_text: "missing", new_text: "x" })
assert.ok(r.isError)

r = await call("list_documents", { url: page })
assert.match(r.text, /1\. "Plan"/)

await client.close()
console.log("ok: mcp")
process.exit(0)
