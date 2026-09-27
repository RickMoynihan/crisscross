// Read and edit a wiki (a list document plus its markdown documents) from
// Node. Used by the CLI and the MCP server in bin/automerge-wiki.js.
//
// Wikis are addressed by any of:
//   https://host/path/#automerge:<list>                 the web app's list page
//   https://host/path/#automerge:<list>/automerge:<doc> a document page
//   automerge:<list>
// A document within a wiki is addressed by its title or its automerge: URL.

import { Repo, isValidAutomergeUrl, initializeBase64Wasm, Automerge as A } from "@automerge/automerge-repo/slim"
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64"
import { authors, diff, join, newDoc, spliceAuthored } from "./doc.js"
import * as Index from "./index.js"

export const DEFAULT_SYNC_URL = "wss://sync.automerge.org"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function parseUrl(input) {
  const s = String(input ?? "").trim()
  const hash = s.indexOf("#")
  const base = hash >= 0 ? s.slice(0, hash) : null
  const [listUrl, docUrl] = (hash >= 0 ? s.slice(hash + 1) : s).split("/")
  if (!isValidAutomergeUrl(listUrl)) throw new Error(`Not a wiki URL: ${s}`)
  if (docUrl && !isValidAutomergeUrl(docUrl)) throw new Error(`Not a valid document URL: ${docUrl}`)
  return { base: base || null, listUrl, docUrl: docUrl || null }
}

export class Wiki {
  constructor({ syncUrl = DEFAULT_SYNC_URL, author } = {}) {
    this.syncUrl = syncUrl
    this.author = author
    this.ready = initializeBase64Wasm(automergeWasmBase64)
    this.repo = null
    this.checker = null // a second connection, used to confirm writes reached the server
  }

  newRepo() {
    const network = new WebSocketClientAdapter(this.syncUrl)
    const repo = new Repo({ network: [network] })
    // The adapter reports itself ready after 1s even if the socket hasn't
    // opened yet, and a find() before then says "unavailable". So wait for
    // the server to actually connect (or give up after a while, if offline).
    repo.connected = new Promise((resolve) => {
      network.once("peer-candidate", () => resolve(true))
      setTimeout(() => resolve(false), 10000)
    })
    return repo
  }

  async find(repo, url) {
    await repo.connected
    // The server may not have a just-created document yet, so retry a few times.
    for (let tries = 1; ; tries++) {
      try {
        return await repo.find(url)
      } catch (e) {
        if (tries >= 3) throw new Error(`Couldn't load ${url} from ${this.syncUrl}: ${e.message}`)
        await sleep(1000)
      }
    }
  }

  // Load a wiki's list document. Returns { index, base, docUrl }.
  async open(input) {
    await this.ready
    this.repo ??= this.newRepo()
    const { base, listUrl, docUrl } = parseUrl(input)
    const index = await this.find(this.repo, listUrl)
    if (!Index.isIndex(index.doc())) throw new Error(`${listUrl} is not a wiki list document`)
    return { index, base, docUrl }
  }

  pageUrl(base, index, docUrl) {
    if (!base) return null
    return `${base}#${index.url}${docUrl ? `/${docUrl}` : ""}`
  }

  // Find a document in the wiki by automerge URL or (case-insensitive) title.
  resolve(index, ref) {
    const all = [...Index.entries(index.doc()), ...Index.entries(index.doc(), true)]
    const key = String(ref ?? "").trim()
    if (!key) throw new Error("Which document? Give its title or automerge: URL.")
    const byUrl = all.find((e) => e.url === key)
    if (byUrl) return byUrl
    const byTitle = all.filter((e) => (e.title ?? "").trim().toLowerCase() === key.toLowerCase())
    if (byTitle.length === 1) return byTitle[0]
    if (byTitle.length > 1) throw new Error(`Several documents are titled "${key}"; use its URL: ${byTitle.map((e) => e.url).join(", ")}`)
    throw new Error(`No document "${key}" in this wiki. Titles: ${all.map((e) => `"${e.title}"`).join(", ")}`)
  }

  async list(input) {
    const { index, base } = await this.open(input)
    const describe = (e) => ({ title: e.title ?? "", url: e.url, page: this.pageUrl(base, index, e.url) })
    return {
      wiki: index.url,
      page: this.pageUrl(base, index),
      documents: Index.entries(index.doc()).map(describe),
      archived: Index.entries(index.doc(), true).map(describe),
    }
  }

  // Open one document: the doc argument wins, else the one named in the page URL.
  async openDoc(input, ref) {
    const { index, base, docUrl } = await this.open(input)
    const entry = this.resolve(index, ref || docUrl)
    const handle = await this.find(this.repo, entry.url)
    return { index, base, entry, handle }
  }

  async read(input, ref) {
    const { index, base, entry, handle } = await this.openDoc(input, ref)
    const doc = handle.doc()
    return {
      title: entry.title ?? "",
      url: entry.url,
      page: this.pageUrl(base, index, entry.url),
      archived: entry.archived,
      authors: authors(doc),
      text: doc.text ?? "",
    }
  }

  // Replace exactly one occurrence of oldText with newText.
  async edit(input, ref, oldText, newText) {
    const { entry, handle } = await this.openDoc(input, ref)
    const text = handle.doc().text ?? ""
    if (!oldText) throw new Error("old_text must not be empty; use append to add to the end.")
    const at = text.indexOf(oldText)
    if (at < 0) throw new Error(`old_text was not found in "${entry.title}". Read the document again to get its current text.`)
    if (text.indexOf(oldText, at + 1) >= 0) throw new Error("old_text appears more than once; include more surrounding text so it is unique.")
    const { start, del, insert } = diff(oldText, newText)
    this.write(handle, (d) => spliceAuthored(d, this.author, at + start, del, insert))
    return { title: entry.title, confirmed: await this.confirm(handle) }
  }

  async append(input, ref, extra) {
    const { entry, handle } = await this.openDoc(input, ref)
    this.write(handle, (d) => spliceAuthored(d, this.author, d.text.length, 0, extra))
    return { title: entry.title, confirmed: await this.confirm(handle) }
  }

  // Replace the whole text (as a single splice over the part that changed).
  async replace(input, ref, newText) {
    const { entry, handle } = await this.openDoc(input, ref)
    this.write(handle, (d) => {
      const { start, del, insert } = diff(d.text, newText)
      spliceAuthored(d, this.author, start, del, insert)
    })
    return { title: entry.title, confirmed: await this.confirm(handle) }
  }

  async create(input, title, text = "") {
    const { index, base } = await this.open(input)
    const handle = this.repo.create(newDoc())
    this.write(handle, (d) => spliceAuthored(d, this.author, 0, 0, text))
    index.change((d) => Index.add(d, handle.url, title))
    const confirmed = (await this.confirm(handle)) && (await this.confirm(index))
    return { title, url: handle.url, page: this.pageUrl(base, index, handle.url), confirmed }
  }

  async rename(input, ref, title) {
    return this.changeIndex(input, ref, (d, url) => Index.rename(d, url, title))
  }

  async archive(input, ref) {
    return this.changeIndex(input, ref, (d, url) => Index.archive(d, url))
  }

  async restore(input, ref) {
    return this.changeIndex(input, ref, (d, url) => Index.restore(d, url))
  }

  async changeIndex(input, ref, fn) {
    const { index, docUrl } = await this.open(input)
    const entry = this.resolve(index, ref || docUrl)
    index.change((d) => fn(d, entry.url))
    return { title: entry.title, confirmed: await this.confirm(index) }
  }

  // Start a new, empty wiki. Returns its list URL.
  async createWiki() {
    await this.ready
    this.repo ??= this.newRepo()
    const index = this.repo.create(Index.newIndex())
    return { url: index.url, confirmed: await this.confirm(index) }
  }

  write(handle, fn) {
    if (!this.author) throw new Error("No author name set")
    join(handle, this.author)
    handle.change(fn)
  }

  // Wait until a separate connection to the sync server sees our latest
  // changes, which proves the server has them. Returns false on timeout.
  async confirm(handle, ms = 15000) {
    const heads = A.getHeads(handle.doc())
    this.checker ??= this.newRepo()
    const deadline = Date.now() + ms
    try {
      const other = await this.find(this.checker, handle.url)
      while (!A.hasHeads(other.doc(), heads)) {
        if (Date.now() > deadline) return false
        await sleep(100)
      }
      return true
    } catch {
      return false
    }
  }

  close() {
    this.repo?.shutdown()
    this.checker?.shutdown()
  }
}
