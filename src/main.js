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

// Order-independent comparison of two sets of Automerge heads.
const sameHeads = (a, b) => {
  if (!a || !b || a.length !== b.length) return false
  const [as, bs] = [[...a].sort(), [...b].sort()]
  return as.every((x, i) => x === bs[i])
}

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

// URLs are #<index url> for the document list, #<index url>/<doc url> for a
// document's main branch, and #<index url>/<doc url>/<branch name> for a
// named branch of that document.
async function route() {
  const id = ++routeId
  leaveView()
  leaveView = () => {}
  show(null)

  const [indexUrl, docUrl, branchSeg] = location.hash.slice(1).split("/")
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
    if (!isValidAutomergeUrl(docUrl)) return
    const branchName = branchSeg ? decodeURIComponent(branchSeg) : null
    const branch = branchName ? Index.branches(index.doc(), docUrl).find((b) => b.name === branchName) : null
    if (branchName && !branch) {
      message.textContent = `Branch not found: "${branchName}".`
      message.hidden = false
      return
    }
    const doc = await load(branch ? branch.url : docUrl)
    if (!doc || id !== routeId) return
    leaveView = showDoc(index, docUrl, branchName, doc)
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

  // Branching the index deep-clones it and every document it lists, so the
  // branch is a fully independent copy until it's merged back (see
  // createRootBranch). `root` holds the flat list of sibling branches: it's
  // `index` itself unless this index is a branch, in which case it's loaded
  // asynchronously below.
  let left = false
  let root = index
  let stopRoot = () => {}

  // A branch has something to merge once either the index itself, or any
  // document it forked, has changed since the branch was created.
  const checkDiverged = async (mine) => {
    if (!sameHeads(index.heads(), mine.forkHeads)) return true
    for (const [url, entry] of Object.entries(index.doc().docs ?? {})) {
      if (!entry.forkedFrom || !entry.forkHeads) continue
      const h = await repo.find(url).catch(() => null)
      if (h && !sameHeads(h.heads(), entry.forkHeads)) return true
    }
    return false
  }

  const renderBranches = () => {
    const family = Index.rootBranches(root.doc())
    const isRoot = root.url === index.url
    $("index-branch-select").replaceChildren(
      el("option", { value: root.url, selected: isRoot }, "main"),
      ...family.map((b) => el("option", { value: b.url, selected: b.url === index.url }, b.name)),
      el("option", { value: "__new__" }, "+ New branch…"),
    )
    $("index-branch-note").hidden = isRoot

    const mine = !isRoot && family.find((b) => b.url === index.url)
    if (!mine) {
      $("index-merge-controls").hidden = true
      return
    }
    checkDiverged(mine).then((diverged) => {
      if (left) return
      $("index-merge-controls").hidden = !diverged
      if (diverged) {
        $("index-merge-target").replaceChildren(
          el("option", { value: root.url }, "main"),
          ...family.filter((b) => b.url !== index.url).map((b) => el("option", { value: b.url }, b.name)),
        )
      }
    })
  }

  $("index-branch-select").onchange = async (e) => {
    const value = e.target.value
    if (value !== "__new__") {
      location.hash = `#${value}`
      return
    }
    renderBranches() // reset the select back to the current branch
    const name = (prompt("New branch name") ?? "").trim()
    if (!name) return
    if (name === "main" || Index.rootBranches(root.doc()).some((b) => b.name === name)) {
      alert(`A branch called "${name}" already exists.`)
      return
    }
    await createRootBranch(root, index, name)
  }

  $("index-merge-btn").onclick = async () => {
    const targetUrl = $("index-merge-target").value
    const targetHandle = await repo.find(targetUrl)
    await mergeRootBranch(targetHandle, index)
    location.hash = `#${targetUrl}`
  }

  document.title = "Automerge Markdown"
  render()
  renderBranches()
  show(indexView)
  const stopItems = listen(index, () => {
    render()
    renderBranches()
  })

  ;(async () => {
    const branchOf = index.doc().branchOf
    if (!branchOf) return
    const r = await repo.find(branchOf.root).catch(() => null)
    if (left || !r) return
    root = r
    stopRoot = listen(root, renderBranches)
    renderBranches()
  })()

  return () => {
    left = true
    stopItems()
    stopRoot()
  }
}

// Deep-clone `source` (an index, possibly itself a branch) and every
// document it lists into a brand new named branch, registered on `root`'s
// flat sibling list, then navigate to it. Each cloned document records
// `forkedFrom` and its own fork heads, so a later merge knows where its
// changes belong and the UI can tell whether it has diverged.
async function createRootBranch(root, source, name) {
  const newIndex = repo.clone(source)

  const rekeyed = []
  for (const [url] of Object.entries(source.doc().docs ?? {})) {
    const src = await repo.find(url).catch(() => null)
    if (!src) continue
    const cloned = repo.clone(src)
    rekeyed.push({ oldUrl: url, newUrl: cloned.url, forkHeads: cloned.heads() })
  }
  // Re-keying and stamping `branchOf` are themselves changes, so the fork
  // heads (what "no changes yet" is measured against) are taken afterwards.
  newIndex.change((d) => {
    for (const r of rekeyed) Index.rekeyAsFork(d, r.oldUrl, r.newUrl, r.forkHeads)
    d.branchOf = { root: root.url, name }
  })
  const forkHeads = newIndex.heads()
  root.change((d) => Index.addRootBranch(d, name, newIndex.url, forkHeads))
  location.hash = `#${newIndex.url}`
}

// Merge every document a branch index lists back into its counterpart in
// `target` (matched via `forkedFrom`) with normal CRDT merge rules, and add
// any document the branch created that target doesn't have yet.
async function mergeRootBranch(target, branch) {
  for (const [url, entry] of Object.entries(branch.doc().docs ?? {})) {
    const branchDoc = await repo.find(url).catch(() => null)
    if (!branchDoc) continue
    if (entry.forkedFrom) {
      const targetDoc = await repo.find(entry.forkedFrom).catch(() => null)
      if (!targetDoc) continue
      targetDoc.merge(branchDoc) // real CRDT merge of the document's own content
      target.change((d) => {
        if (!d.docs[entry.forkedFrom]) return
        Index.rename(d, entry.forkedFrom, entry.title)
        d.docs[entry.forkedFrom].archived = entry.archived
      })
    } else if (!target.doc().docs?.[url]) {
      target.change((d) => Index.add(d, url, entry.title))
    }
  }
}

// ---- Markdown document ----

// `docUrl` identifies the document's family (its main branch, and the key
// its title/branches are tracked under in the index). `branchName` is null
// for the main branch, or the name of the branch `handle` holds otherwise.
function showDoc(index, docUrl, branchName, handle) {
  join(handle, me)
  const path = Index.titlePath(docUrl)
  $("back").href = `#${index.url}`
  const branchHash = (name) => `#${index.url}/${docUrl}${name ? "/" + encodeURIComponent(name) : ""}`

  // This document's own branches (below) are separate from whether the list
  // it's in is itself a branch, so surface that too, or it looks like it was
  // silently dropped when following a link into a document.
  const listBranchOf = index.doc().branchOf
  $("doc-list-branch-note").hidden = !listBranchOf
  if (listBranchOf) $("doc-list-branch-name").textContent = listBranchOf.name

  const renderTitle = (doc, before) => {
    updateField(titleInput, path, doc, before)
    const entry = doc.docs[docUrl]
    document.title = `${displayTitle(entry?.title)} - Automerge Markdown`
    $("archived-note").hidden = !entry?.archived
  }
  titleInput.oninput = () => index.change((d) => Index.rename(d, docUrl, titleInput.value))

  // The branch picker (existing branches + "new branch") and, once the
  // current branch has diverged from its fork point, the merge controls.
  const renderBranches = (indexDoc) => {
    const family = Index.branches(indexDoc, docUrl)
    $("branch-select").replaceChildren(
      el("option", { value: "", selected: !branchName }, "main"),
      ...family.map((b) => el("option", { value: b.name, selected: b.name === branchName }, b.name)),
      el("option", { value: "__new__" }, "+ New branch…"),
    )

    const fork = branchName && family.find((b) => b.name === branchName)
    const diverged = !!fork && !sameHeads(handle.heads(), fork.forkHeads)
    $("merge-controls").hidden = !diverged
    if (diverged) {
      $("merge-target").replaceChildren(
        el("option", { value: "" }, "main"),
        ...family.filter((b) => b.name !== branchName).map((b) => el("option", { value: b.name }, b.name)),
      )
    }
  }

  $("branch-select").onchange = (e) => {
    const value = e.target.value
    if (value !== "__new__") {
      location.hash = branchHash(value || null)
      return
    }
    renderBranches(index.doc()) // reset the select back to the current branch
    const name = (prompt("New branch name") ?? "").trim()
    if (!name) return
    if (name === "main" || Index.branches(index.doc(), docUrl).some((b) => b.name === name)) {
      alert(`A branch called "${name}" already exists.`)
      return
    }
    const branchHandle = repo.clone(handle)
    index.change((d) => Index.addBranch(d, docUrl, name, branchHandle.url, branchHandle.heads()))
    location.hash = branchHash(name)
  }

  $("merge-btn").onclick = async () => {
    const targetName = $("merge-target").value
    const target = targetName ? Index.branches(index.doc(), docUrl).find((b) => b.name === targetName) : null
    const targetHandle = await repo.find(target ? target.url : docUrl)
    targetHandle.merge(handle) // applies the branch's changes following normal CRDT merge rules
    location.hash = branchHash(targetName || null)
  }

  textarea.oninput = () => applyEdit(handle, me, textarea.value)
  textarea.value = handle.doc().text ?? ""
  renderTitle(index.doc())
  renderDoc(handle.doc())
  renderBranches(index.doc())
  show(docView)

  const stopDoc = listen(handle, ({ doc, patchInfo }) => {
    updateField(textarea, TEXT, doc, patchInfo.before)
    renderDoc(doc)
    renderBranches(index.doc()) // divergence from the fork point may have changed
  })
  const stopIndex = listen(index, ({ doc, patchInfo }) => {
    renderTitle(doc, patchInfo.before)
    renderBranches(doc)
  })
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
