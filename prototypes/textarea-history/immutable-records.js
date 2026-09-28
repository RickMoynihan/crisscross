import { Automerge as A } from '@automerge/automerge-repo/slim'
import { LruCache } from './analysis-cache.js'
const decoded = new LruCache(2048)
// These records are write-once. A scalar avoids creating a collaborative text
// object (and character operations) for every hash, UUID and metadata string.
export const encodeRecord = record => new A.ImmutableString(JSON.stringify(record))
export function decodeRecord(value) {
  if (!A.isImmutableString(value)) return JSON.parse(JSON.stringify(value))
  const json = String(value)
  return decoded.get(json) || decoded.set(json, JSON.parse(json))
}
