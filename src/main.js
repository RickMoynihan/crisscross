import { Repo, isValidAutomergeUrl, initializeBase64Wasm, Automerge as A } from "@automerge/automerge-repo/slim"
import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64"
import { marked } from "marked"
import { TEXT, applyEdit, join, segments } from "./doc.js"

// Override with ?sync=wss://your-server to use a self-hosted sync server.
const SYNC_URL = new URLSearchParams(location.search).get("sync") ?? "wss://sync.automerge.org"

const $ = (id) => document.getElementById(id)
const loginForm = $("login")
const nameInput = $("name")
const app = $("app")
const textarea = $("text")
const backdrop = $("backdrop")
const preview = $("preview")
const usersList = $("users")
const status = $("status")

// Don't render raw HTML from the shared document; show it as text instead.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
marked.use({ renderer: { html: ({ text }) => escapeHtml(text) } })

nameInput.value = localStorage.getItem("username") ?? ""

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault()
  const name = nameInput.value.trim()
  if (!name) return
  localStorage.setItem("username", name)
  loginForm.hidden = true
  app.hidden = false
  await start(name)
})

async function start(name) {
  status.textContent = "Loading…"
  await initializeBase64Wasm(automergeWasmBase64)
  // Every document is also saved in this browser (IndexedDB), so it loads and
  // can be edited offline. The websocket adapter keeps retrying, and on
  // reconnect Automerge syncs whatever changed on either side.
  const network = new WebSocketClientAdapter(SYNC_URL)
  const repo = new Repo({ network: [network], storage: new IndexedDBStorageAdapter() })
  const online = () => (status.textContent = `Online: syncing via ${SYNC_URL}. Share this page's URL to collaborate.`)
  const offline = () => (status.textContent = "Offline: edits are saved in this browser and will sync when reconnected.")
  let connected = false
  network.on("peer-candidate", () => ((connected = true), online()))
  network.on("peer-disconnected", () => ((connected = false), offline()))

  const hash = location.hash.slice(1)
  let handle
  if (isValidAutomergeUrl(hash)) {
    try {
      handle = await repo.find(hash)
    } catch {
      status.textContent = "Document not found: it isn't saved in this browser and the sync server doesn't have it (or is unreachable)."
      return
    }
  } else {
    handle = repo.create({ text: "", users: {} })
    location.hash = handle.url
  }
  Object.assign(window, { repo, handle, network }) // handy for poking at from the console

  join(handle, name)
  $("me").textContent = name

  textarea.addEventListener("input", () => applyEdit(handle, name, textarea.value))
  textarea.addEventListener("scroll", () => {
    backdrop.scrollTop = textarea.scrollTop
    backdrop.scrollLeft = textarea.scrollLeft
  })

  handle.on("change", ({ doc, patchInfo }) => {
    // Remote edit: update the textarea, keeping the caret/selection anchored
    // to the same characters using Automerge cursors.
    if (doc.text !== textarea.value) {
      const [s, e] = [textarea.selectionStart, textarea.selectionEnd].map((pos) => {
        if (pos >= patchInfo.before.text.length) return null
        return A.getCursor(patchInfo.before, TEXT, pos)
      })
      const focused = document.activeElement === textarea
      textarea.value = doc.text
      const at = (c) => (c === null ? doc.text.length : A.getCursorPosition(doc, TEXT, c))
      if (focused) textarea.setSelectionRange(at(s), at(e))
    }
    render(doc, name)
  })

  textarea.value = handle.doc().text
  render(handle.doc(), name)
  if (!connected) offline()
  textarea.focus()
}

function render(doc, me) {
  const users = doc.users ?? {}
  const color = (who) => users[who]?.color ?? ""

  // Coloured copy of the text, shown behind the (transparent) textarea.
  backdrop.replaceChildren(
    ...segments(doc).map(([text, who]) => {
      const span = document.createElement("span")
      span.textContent = text
      span.style.color = color(who)
      if (who) span.title = who
      return span
    }),
    " ", // lets a trailing newline take up a line, as it does in the textarea
  )
  backdrop.scrollTop = textarea.scrollTop

  usersList.replaceChildren(
    ...Object.keys(users).sort().map((who) => {
      const el = document.createElement("span")
      el.textContent = who === me ? `${who} (you)` : who
      el.style.color = color(who)
      return el
    }),
  )

  preview.innerHTML = marked.parse(doc.text ?? "")
}
