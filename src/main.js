import { Repo, isValidAutomergeUrl, initializeBase64Wasm, Automerge as A } from "@automerge/automerge-repo/slim"
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64"
import { marked } from "marked"
import { TEXT, applyEdit, join, newDoc, segments } from "./doc.js"
import * as Index from "./index.js"

// Override with ?sync=wss://your-server to use a self-hosted sync server.
const SYNC_URL = new URLSearchParams(location.search).get("sync") ?? "wss://sync.automerge.org"

const $ = (id) => document.getElementById(id)
const loginForm = $("login")
const nameInput = $("name")
const status = $("status")
const message = $("message")
const indexView = $("index-view")
const docView = $("doc-view")
const textarea = $("text")
const backdrop = $("backdrop")
const titleInput = $("title")

// The package collaborators install to give their AI agent access (see README).
const AGENT_PACKAGE = "github:RickMoynihan/amexp"

// Don't render raw HTML from the shared document; show it as text instead.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
marked.use({ renderer: { html: ({ text }) => escapeHtml(text) } })

const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props)
  e.append(...children)
  return e
}
const get = (obj, path) => path.reduce((o, k) => o?.[k], obj)
const displayTitle = (title) => title?.trim() || "Untitled"

let repo, me
let leaveView = () => {} // removes the current view's listeners
let routeId = 0

nameInput.value = localStorage.getItem("username") ?? ""

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault()
  me = nameInput.value.trim()
  if (!me) return
  localStorage.setItem("username", me)
  loginForm.hidden = true
  $("app").hidden = false
  $("me").textContent = me
  await start()
})

async function start() {
  status.textContent = "Loading…"
  await initializeBase64Wasm(automergeWasmBase64)
  // Every document is also saved in this browser (IndexedDB), so it loads and
  // can be edited offline. The websocket adapter keeps retrying, and on
  // reconnect Automerge syncs whatever changed on either side.
  const network = new WebSocketClientAdapter(SYNC_URL)
  repo = new Repo({ network: [network], storage: new IndexedDBStorageAdapter() })
  const online = () => (status.textContent = `Online: syncing via ${SYNC_URL}. Share this page's URL to collaborate.`)
  const offline = () => (status.textContent = "Offline: edits are saved in this browser and will sync when reconnected.")
  let connected = false
  network.on("peer-candidate", () => {
    connected = true
    online()
    if (!message.hidden) route() // retry a "not found" now the server is connected
  })
  network.on("peer-disconnected", () => ((connected = false), offline()))
  Object.assign(window, { repo, network }) // handy for poking at from the console

  textarea.addEventListener("scroll", () => {
    backdrop.scrollTop = textarea.scrollTop
    backdrop.scrollLeft = textarea.scrollLeft
  })
  $("copy-agent").addEventListener("click", copyForAgent)
  window.addEventListener("hashchange", route)
  await route()
  if (!connected) offline()
}

// Copy this page's URL with instructions for giving an AI agent access.
async function copyForAgent(e) {
  const text = `Collaborative wiki: ${location.href}

To let Claude read and edit it, add its MCP server once:
  claude mcp add -s user automerge-wiki -- npx -y ${AGENT_PACKAGE} mcp

Then ask, e.g.: "Summarise the wiki at ${location.href}"`
  try {
    await navigator.clipboard.writeText(text)
    e.target.textContent = "Copied"
  } catch {
    e.target.textContent = "Couldn't copy"
  }
  setTimeout(() => (e.target.textContent = "Copy link for an AI agent"), 2000)
}

// URLs are #<index url> for the document list, and #<index url>/<doc url>
// for a markdown document.
async function route() {
  const id = ++routeId
  leaveView()
  leaveView = () => {}
  show(null)

  const [indexUrl, docUrl] = location.hash.slice(1).split("/")
  if (!isValidAutomergeUrl(indexUrl)) {
    location.replace(`#${repo.create(Index.newIndex()).url}`)
    return
  }
  const index = await load(indexUrl)
  if (!index || id !== routeId) return

  if (!Index.isIndex(index.doc())) {
    // A link from before there was an index: wrap that document in a new one.
    const wrapper = repo.create(Index.newIndex())
    wrapper.change((d) => Index.add(d, indexUrl, ""))
    location.replace(`#${wrapper.url}/${indexUrl}`)
    return
  }

  if (docUrl) {
    const doc = isValidAutomergeUrl(docUrl) && (await load(docUrl))
    if (!doc || id !== routeId) return
    leaveView = showDoc(index, doc)
  } else {
    leaveView = showIndex(index)
  }
}

async function load(url) {
  try {
    return await repo.find(url)
  } catch {
    message.textContent = "Document not found: it isn't saved in this browser and the sync server doesn't have it (or is unreachable)."
    message.hidden = false
    return null
  }
}

function show(view) {
  message.hidden = true
  indexView.hidden = view !== indexView
  docView.hidden = view !== docView
}

// Subscribe to a handle's changes; returns the unsubscribe function.
function listen(handle, fn) {
  handle.on("change", fn)
  return () => handle.off("change", fn)
}

// Set a text field from the document after a change. For remote changes the
// caret/selection stays anchored to the same characters using Automerge cursors.
function updateField(field, path, doc, before) {
  const value = get(doc, path) ?? ""
  if (field.value === value) return
  let restore = () => {}
  if (before && document.activeElement === field) {
    try {
      const len = get(before, path).length
      const [s, e] = [field.selectionStart, field.selectionEnd].map((pos) =>
        pos >= len ? null : A.getCursor(before, path, pos),
      )
      const at = (c) => (c === null ? value.length : A.getCursorPosition(doc, path, c))
      restore = () => field.setSelectionRange(at(s), at(e))
    } catch {
      // The field didn't exist before this change; leave the caret alone.
    }
  }
  field.value = value
  restore()
}

// ---- Document list ----

function showIndex(index) {
  const link = (e) => el("a", { href: `#${index.url}/${e.url}` }, displayTitle(e.title))
  const button = (label, onclick, props = {}) => el("button", { type: "button", onclick, ...props }, label)
  const edit = (fn) => index.change(fn)

  const render = () => {
    const doc = index.doc()
    const active = Index.entries(doc)
    $("items").replaceChildren(
      ...active.map((e, i) =>
        el(
          "li",
          {},
          link(e),
          " ",
          button("Rename", () => {
            const title = prompt("Title", e.title ?? "")
            if (title !== null) edit((d) => Index.rename(d, e.url, title))
          }),
          " ",
          button("↑", () => edit((d) => Index.move(d, e.url, -1)), { disabled: i === 0, title: "Move up" }),
          button("↓", () => edit((d) => Index.move(d, e.url, +1)), { disabled: i === active.length - 1, title: "Move down" }),
          " ",
          button("Delete", () => edit((d) => Index.archive(d, e.url)), { title: "Move to the archive" }),
        ),
      ),
    )
    $("empty").hidden = active.length > 0

    const archived = Index.entries(doc, true)
    $("archive-count").textContent = archived.length
    $("archive").replaceChildren(
      ...archived.map((e) => el("li", {}, link(e), " ", button("Restore", () => edit((d) => Index.restore(d, e.url))))),
    )
  }

  $("add").onsubmit = (ev) => {
    ev.preventDefault()
    const doc = repo.create(newDoc())
    edit((d) => Index.add(d, doc.url, $("new-title").value.trim()))
    $("new-title").value = ""
  }

  document.title = "Automerge Markdown"
  render()
  show(indexView)
  return listen(index, render)
}

// ---- Markdown document ----

function showDoc(index, handle) {
  join(handle, me)
  const path = Index.titlePath(handle.url)
  $("back").href = `#${index.url}`

  const renderTitle = (doc, before) => {
    updateField(titleInput, path, doc, before)
    const entry = doc.docs[handle.url]
    document.title = `${displayTitle(entry?.title)} - Automerge Markdown`
    $("archived-note").hidden = !entry?.archived
  }
  titleInput.oninput = () => index.change((d) => Index.rename(d, handle.url, titleInput.value))

  textarea.oninput = () => applyEdit(handle, me, textarea.value)
  textarea.value = handle.doc().text ?? ""
  renderTitle(index.doc())
  renderDoc(handle.doc())
  show(docView)

  const stopDoc = listen(handle, ({ doc, patchInfo }) => {
    updateField(textarea, TEXT, doc, patchInfo.before)
    renderDoc(doc)
  })
  const stopIndex = listen(index, ({ doc, patchInfo }) => renderTitle(doc, patchInfo.before))
  return () => (stopDoc(), stopIndex())
}

function renderDoc(doc) {
  const users = doc.users ?? {}
  const color = (who) => users[who]?.color ?? ""

  // Coloured copy of the text, shown behind the (transparent) textarea.
  backdrop.replaceChildren(
    ...segments(doc).map(([text, who]) => el("span", { textContent: text, title: who ?? "", style: `color: ${color(who)}` })),
    " ", // lets a trailing newline take up a line, as it does in the textarea
  )
  backdrop.scrollTop = textarea.scrollTop

  $("users").replaceChildren(
    ...Object.keys(users)
      .sort()
      .map((who) => el("span", { textContent: who === me ? `${who} (you)` : who, style: `color: ${color(who)}` })),
  )

  $("preview").innerHTML = marked.parse(doc.text ?? "")
}
