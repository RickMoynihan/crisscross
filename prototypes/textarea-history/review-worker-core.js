import { Automerge as A } from '@automerge/automerge-repo/slim'
import { headsKey, LruCache } from './analysis-cache.js'
import { reviewIssues } from './conflicts.js'

export function createReviewProcessor(store) {
  const documents = new Map(), cache = new LruCache(128)
  return async message => {
    const { url, changes, heads, persist } = message
    let doc = documents.get(url) || A.init()
    if (changes.length) [doc] = A.applyChanges(doc, changes)
    documents.set(url, doc)
    if (!A.hasHeads(doc, heads)) throw new Error('Review snapshot has not arrived yet')
    const key = headsKey(heads)
    let issues = cache.get(key)
    if (!issues && persist) { try { issues = await store.get(key) } catch { /* Optional derived-data cache. */ } }
    if (!issues) issues = reviewIssues(A.view(doc, heads))
    cache.set(key, issues)
    if (persist) { try { await store.set(key, issues) } catch { /* Quota or storage failure must not disable review. */ } }
    return { heads, issues }
  }
}
