#!/usr/bin/env node
// Command-line access to an Automerge wiki, and an MCP server for AI agents.
// Run with no arguments for usage.

import { readFileSync } from "node:fs"
import { userInfo } from "node:os"
import { Wiki, DEFAULT_SYNC_URL } from "../src/wiki.js"
import { formatDoc, formatList, formatWrite } from "../src/format.js"

const USAGE = `Usage: automerge-wiki <command> [args]

  mcp                               Run an MCP server on stdio (for Claude Desktop / Claude Code)

  new                               Create an empty wiki and print its URL
  ls      <url>                     List documents and the archive
  cat     <url> [doc]               Print a document's markdown (--info for title, authors, etc.)
  edit    <url> <doc> <old> <new>   Replace one unique occurrence of <old> with <new>
  append  <url> <doc> [text]        Add text to the end (reads stdin if text is omitted)
  write   <url> <doc>               Replace the whole document with stdin
  create  <url> <title> [text]      Add a new document (reads stdin if text is "-")
  rename  <url> <doc> <title>       Change a document's title
  archive <url> <doc>               Move a document to the archive
  restore <url> <doc>               Move a document back from the archive

<url> is the web app's page URL (https://...#automerge:...) or a bare automerge: URL.
<doc> is a document's title or automerge: URL. Use "" to mean the document in <url>.

Environment:
  AUTOMERGE_WIKI_AUTHOR   name your edits are attributed to (default: "agent (${userInfo().username})")
  AUTOMERGE_WIKI_SYNC     sync server (default: ${DEFAULT_SYNC_URL})`

// automerge-repo's websocket adapter can trigger this harmless Node warning.
const emitWarning = process.emitWarning
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type
  if (type === "TimeoutNegativeWarning" || warning?.name === "TimeoutNegativeWarning") return
  return emitWarning.call(process, warning, ...rest)
}

const [command, ...args] = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith("--")))
const pos = args.filter((a) => !a.startsWith("--"))
const stdin = () => readFileSync(0, "utf8")

const wiki = new Wiki({
  syncUrl: process.env.AUTOMERGE_WIKI_SYNC || DEFAULT_SYNC_URL,
  author: process.env.AUTOMERGE_WIKI_AUTHOR || `agent (${userInfo().username})`,
})

function need(n) {
  if (pos.length < n) {
    console.error(USAGE)
    process.exit(2)
  }
}

// Writes must reach the sync server before we exit, or they'd be lost.
function done(verb, result) {
  const text = formatWrite(verb, result)
  if (result.confirmed) return console.log(text)
  console.error(`Error: the sync server did not confirm the change to "${result.title ?? ""}", so it was not saved.`)
  process.exitCode = 1
}

const commands = {
  async mcp() {
    const { serveMcp } = await import("../src/mcp.js")
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    await serveMcp(wiki, version)
    return "keep-running"
  },
  async new() {
    const r = await wiki.createWiki()
    if (!r.confirmed) throw new Error("The sync server did not confirm the new wiki.")
    console.log(r.url)
  },
  async ls() {
    need(1)
    console.log(formatList(await wiki.list(pos[0])))
  },
  async cat() {
    need(1)
    const d = await wiki.read(pos[0], pos[1])
    if (flags.has("--info")) console.log(formatDoc(d))
    else process.stdout.write(d.text)
  },
  async edit() {
    need(4)
    done("Edited", await wiki.edit(pos[0], pos[1], pos[2], pos[3]))
  },
  async append() {
    need(2)
    done("Appended to", await wiki.append(pos[0], pos[1], pos[2] ?? stdin()))
  },
  async write() {
    need(2)
    done("Rewrote", await wiki.replace(pos[0], pos[1], stdin()))
  },
  async create() {
    need(2)
    done("Created", await wiki.create(pos[0], pos[1], pos[2] === "-" ? stdin() : (pos[2] ?? "")))
  },
  async rename() {
    need(3)
    done("Renamed", await wiki.rename(pos[0], pos[1], pos[2]))
  },
  async archive() {
    need(2)
    done("Archived", await wiki.archive(pos[0], pos[1]))
  },
  async restore() {
    need(2)
    done("Restored", await wiki.restore(pos[0], pos[1]))
  },
}

if (!commands[command]) {
  console.error(USAGE)
  process.exit(command ? 2 : 0)
}

try {
  if ((await commands[command]()) === "keep-running") {
    // The MCP server runs until the client closes stdin.
  } else {
    wiki.close()
    process.exit()
  }
} catch (e) {
  console.error(`Error: ${e.message}`)
  process.exit(1)
}
