import { encodeRecord } from './immutable-records.js'
import { encodeHeads } from '@automerge/automerge-repo/slim'

export function branchInfo(handle) {
  const scoped = handle.doc()[`branch-info:${handle.url}`]
  return scoped ? (scoped.source ? scoped : null) : handle.doc().branch
}

export function branchName(handle) {
  return handle.doc()[`branch-name:${handle.url}`] || branchInfo(handle)?.name || 'Main'
}

export function branchRemoved(handle) {
  return Boolean(handle.doc()[`branch-removed:${handle.url}`])
}

export function createBranch(repo, source, point, name, author, checkpoint = null) {
  const heads = typeof point === 'string' ? [point] : [...point]
  const branch = repo.clone(source.view(encodeHeads(heads)))
  branch.change(doc => {
    doc.branch = { name, source: source.url, forkHash: heads.at(-1), forkHeads: heads }
    doc[`branch-info:${branch.url}`] = { name, source: source.url, forkHash: heads.at(-1), forkHeads: [...heads], ...(checkpoint ? { forkCommitId: checkpoint.id } : {}) }
    if (checkpoint) doc[`commit:${checkpoint.id}`] = encodeRecord(checkpoint)
  }, { message: JSON.stringify({ author, kind: 'branch-create' }), time: Math.floor(Date.now() / 1000) })
  registerBranch(source, branch, author)
  return branch
}

export function branchLinks(handle) {
  const doc = handle.doc(), links = []
  const branch = branchInfo(handle)
  if (branch) links.push({ url: branch.source, name: 'Source' })
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('branch:') && value?.source === handle.url) {
      links.push({ url: key.slice(7), name: value.name })
    }
  }
  return links
}

export function renameBranch(handle, name, author) {
  const next = name.trim()
  if (!next) return
  handle.change(doc => {
    doc[`branch-name:${handle.url}`] = next
    if (doc.branch) doc.branch = { ...doc.branch, name: next }
    const key = `branch-info:${handle.url}`
    if (doc[key]) doc[key] = { ...doc[key], name: next }
  }, { message: JSON.stringify({ author, kind: 'branch-rename' }), time: Math.floor(Date.now() / 1000) })
}

export function renameBranchLink(source, branchUrl, name, author) {
  const key = `branch:${branchUrl}`
  if (!source.doc()[key]) return
  source.change(doc => { doc[key] = { ...doc[key], name } }, { message: JSON.stringify({ author, kind: 'branch-rename-link' }), time: Math.floor(Date.now() / 1000) })
}

export function removeBranchLink(source, branchUrl, author) {
  const key = `branch:${branchUrl}`
  if (!source.doc()[key]) return
  source.change(doc => { delete doc[key] }, { message: JSON.stringify({ author, kind: 'branch-remove' }), time: Math.floor(Date.now() / 1000) })
}

export function removeBranchOpenCommit(handle, author) {
  handle.change(doc => { doc[`branch-removed:${handle.url}`] = true }, { message: JSON.stringify({ author, kind: 'branch-remove-open' }), time: Math.floor(Date.now() / 1000) })
}

export function registerBranch(source, branch, author) {
  const key = `branch:${branch.url}`
  if (source.doc()[key]) return
  // Unique root keys also make concurrent registrations and legacy upgrades safe.
  source.change(doc => {
    doc[key] = { source: source.url, name: branchInfo(branch).name }
  }, { message: JSON.stringify({ author, kind: 'branch-register' }), time: Math.floor(Date.now() / 1000) })
}
