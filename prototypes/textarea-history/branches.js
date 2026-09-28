import { encodeRecord } from './immutable-records.js'
import { encodeHeads } from '@automerge/automerge-repo/slim'

export function branchInfo(handle) {
  const scoped = handle.doc()[`branch-info:${handle.url}`]
  return scoped ? (scoped.source ? scoped : null) : handle.doc().branch
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

export function registerBranch(source, branch, author) {
  const key = `branch:${branch.url}`
  if (source.doc()[key]) return
  // Unique root keys also make concurrent registrations and legacy upgrades safe.
  source.change(doc => {
    doc[key] = { source: source.url, name: branchInfo(branch).name }
  }, { message: JSON.stringify({ author, kind: 'branch-register' }), time: Math.floor(Date.now() / 1000) })
}
