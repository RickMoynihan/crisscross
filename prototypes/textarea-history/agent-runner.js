#!/usr/bin/env node
import { Repo, Automerge as A, initializeBase64Wasm } from '@automerge/automerge-repo/slim'
import { automergeWasmBase64 } from '@automerge/automerge/automerge.wasm.base64'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { changeOptions, commitState } from './versioning.js'

const usage = () => `Usage: npm run agent -- <automerge-url> [--sync ws://localhost:3030]\n\nEnvironment:\n  AUTOMERGE_DOC_URL  Document URL when not passed as an argument\n  AUTOMERGE_SYNC_URL Sync server URL, default wss://sync.automerge.org\n  AGENT_INTERVAL_MS  Assistant status interval, default 12000\n  AGENT_RIFF_COOLDOWN_MS Minimum time between riffs, default 30000\n`

function option(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(usage())
  process.exit(0)
}

const docUrl = process.argv.find(arg => arg.startsWith('automerge:')) || process.env.AUTOMERGE_DOC_URL
const syncUrl = option('--sync') || process.env.AUTOMERGE_SYNC_URL || 'wss://sync.automerge.org'
const intervalMs = Number(option('--interval') || process.env.AGENT_INTERVAL_MS || 12000)
const retryMs = Number(option('--retry') || process.env.AGENT_RETRY_MS || 5000)
const riffCooldownMs = Number(option('--riff-cooldown') || process.env.AGENT_RIFF_COOLDOWN_MS || 30000)
const agent = { author: 'Assistant', userId: 'agent:runner' }

if (!docUrl) {
  console.error(usage())
  process.exit(1)
}

await initializeBase64Wasm(automergeWasmBase64)

const adapter = new WebSocketClientAdapter(syncUrl)
const repo = new Repo({
  network: [adapter],
  peerId: `agent-runner-${crypto.randomUUID()}`,
})

console.log(`agent-runner connecting to ${syncUrl}`)
console.log(`agent-runner subscribing to ${docUrl}`)

let handle = null, stopped = false, paused = false, lastUserCursor = null, lastUserName = 'a collaborator'
let debounceTimer = null, lastRiffAt = 0, lastRiffedParagraph = '', writing = false, typingOffset = null, abortTyping = false
const paragraphCooldowns = new Map()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function sendAssistantStatus(status, summary, thoughts = '', extra = {}) {
  if (!handle) return
  handle.broadcast({ type: 'assistant', agent: 'agent-runner', status, summary, thoughts, sentAt: Date.now(), ...extra })
}

function changeMetadata(change) {
  try { return JSON.parse(change.message) || {} } catch { return {} }
}

function latestChangeIsAgent() {
  if (!handle) return false
  const changes = A.getAllChanges(handle.doc())
  if (!changes.length) return false
  const metadata = changeMetadata(A.decodeChange(changes.at(-1)))
  return metadata.userId === agent.userId || metadata.kind === 'agent-riff'
}

function paragraphKey(value) {
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0
  return `${value.length}:${hash}`
}

function cursorPosition(doc) {
  if (lastUserCursor) {
    try { return A.getCursorPosition(doc, ['text'], lastUserCursor) } catch {}
  }
  return Math.max(0, (doc.text || '').length)
}

function paragraphBounds(text, position) {
  const previousBreak = text.lastIndexOf('\n\n', Math.max(0, position - 1))
  const start = previousBreak < 0 ? 0 : previousBreak + 2
  let end = text.indexOf('\n\n', position)
  if (end < 0) end = text.length
  return { start, end }
}

function adjacentCursorPosition(doc, { writing = false } = {}) {
  const text = doc.text || ''
  if (!text) return 0
  const userPos = Math.min(text.length, cursorPosition(doc))
  if (writing) return latestParagraph(doc)?.end ?? text.length
  const current = paragraphBounds(text, userPos)
  const nextStart = current.end + 2
  if (nextStart < text.length) return nextStart
  if (current.start > 1) {
    const previous = paragraphBounds(text, current.start - 2)
    return previous.start
  }
  const nearby = current.end === userPos ? Math.max(current.start, userPos - 1) : current.end
  return Math.max(0, Math.min(text.length, nearby))
}

function sendAgentCursor(status = 'watching', position = null) {
  if (!handle || paused) return
  const doc = handle.doc()
  let cursor = null
  try { cursor = A.getCursor(doc, ['text'], position ?? adjacentCursorPosition(doc, { writing: status === 'writing' })) } catch {}
  handle.broadcast({ type: 'cursor', name: status === 'writing' ? 'Assistant writing' : 'Assistant', role: 'agent', cursor })
}

async function typeTextAt(position, value, options) {
  let offset = position
  typingOffset = offset; abortTyping = false
  console.log(`typing assistant riff · ${value.length} chars at offset ${position}`)
  for (let i = 0; i < value.length && !stopped && !paused && !abortTyping; ) {
    const remaining = value.length - i
    const size = Math.min(remaining, value[i] === '\n' ? 1 : 2 + Math.floor(Math.random() * 3))
    const chunk = value.slice(i, i + size)
    handle.change(doc => { A.splice(doc, ['text'], offset, 0, chunk) }, options)
    offset += chunk.length; i += chunk.length; typingOffset = offset
    sendAgentCursor('writing', offset)
    // Around 70–90wpm equivalent, with small bursts instead of perfectly even keystrokes.
    await sleep(55 + chunk.length * 80 + Math.random() * 70)
  }
  const stoppedByUser = abortTyping
  typingOffset = null; abortTyping = false
  console.log(stoppedByUser ? 'assistant riff typing stopped by user cursor' : paused ? 'assistant riff typing paused' : 'assistant riff typing complete')
  return !stoppedByUser && !paused && !stopped
}

function paragraphNear(text, position) {
  if (!text.trim()) return null
  const previousBreak = text.lastIndexOf('\n\n', Math.max(0, position - 1))
  const start = previousBreak < 0 ? 0 : previousBreak + 2
  let end = text.indexOf('\n\n', position)
  if (end < 0) end = text.length
  const value = text.slice(start, end).trim()
  if (!value || value.includes('Assistant riff:')) return null
  return { start, end, value }
}

function latestParagraph(doc) {
  const text = doc.text || ''
  const near = paragraphNear(text, cursorPosition(doc))
  if (near) return near
  const parts = text.split(/\n\n+/)
  let offset = 0, best = null
  for (const part of parts) {
    const value = part.trim()
    if (value && !value.includes('Assistant riff:')) best = { start: offset, end: offset + part.length, value }
    offset += part.length + 2
  }
  return best
}

async function generateRiff({ paragraph }) {
  // LLM integration point: replace this deterministic response with a model call
  // that returns a short, validated string.
  return `\n\nAssistant riff:\n- clarify the user-facing outcome\n- name one tradeoff or constraint\n- add one concrete example to make “${paragraph.slice(0, 32).replace(/\s+/g, ' ')}${paragraph.length > 32 ? '…' : ''}” easier to act on`
}

function scheduleInspiredResponse() {
  if (!handle || writing || paused || latestChangeIsAgent()) return
  clearTimeout(debounceTimer)
  sendAgentCursor('watching')
  sendAssistantStatus('watching', `Watching ${lastUserName}'s latest paragraph.`)
  debounceTimer = setTimeout(async () => {
    if (!handle || writing || paused || latestChangeIsAgent() || Date.now() - lastRiffAt < riffCooldownMs) return
    const doc = handle.doc(), text = doc.text || '', paragraph = latestParagraph(doc)
    if (!paragraph || paragraph.value.length < 40 || paragraph.value === lastRiffedParagraph) return
    const key = paragraphKey(paragraph.value)
    if (Date.now() - (paragraphCooldowns.get(key) || 0) < riffCooldownMs * 3) return
    lastRiffedParagraph = paragraph.value
    sendAssistantStatus('thinking', 'Thinking about a short adjacent riff…', 'I will keep it brief and write below the paragraph.')
    sendAgentCursor('writing')
    await sleep(900)
    const current = handle.doc(), currentText = current.text || ''
    const fresh = latestParagraph(current)
    if (!fresh || fresh.value !== paragraph.value || currentText.slice(fresh.end, fresh.end + 40).includes('Assistant riff:')) return
    const riff = await generateRiff({ paragraph: fresh.value, doc: current })
    if (!riff || riff.length > 600) return
    writing = true
    try {
      const insertAt = fresh.end
      const options = changeOptions(agent, { kind: 'agent-riff', mode: 'riff', openCommitId: commitState(handle).open.id })
      lastRiffAt = Date.now(); paragraphCooldowns.set(key, lastRiffAt)
      sendAssistantStatus('writing', 'Typing a short riff below the current paragraph…', 'Edit or delete it like any other text.')
      const completed = await typeTextAt(insertAt, riff, options)
      if (completed) sendAssistantStatus('writing', 'Added a short riff below the current paragraph.', 'Edit or delete it like any other text.', { event: 'riff-added' })
      else sendAssistantStatus('watching', 'Stopped typing to stay out of your way.', 'Move your cursor away and keep writing; I will wait before trying again.')
    } finally {
      writing = false
      sendAgentCursor('watching')
    }
  }, 4000)
}

async function subscribe() {
  while (!stopped && !handle) {
    try {
      const next = await repo.find(docUrl)
      if (stopped) return
      handle = next
      await handle.whenReady()
      handle.on('ephemeral-message', ({ message }) => {
        if (!message) return
        if (message.type === 'agent-control') {
          paused = message.action === 'mute' ? true : message.action === 'resume' ? false : paused
          clearTimeout(debounceTimer)
          sendAssistantStatus(paused ? 'idle' : 'watching', paused ? 'Assistant muted.' : 'Assistant resumed.')
          if (!paused) sendAgentCursor('watching')
          return
        }
        if (message.type !== 'cursor' || message.role === 'agent') return
        if (typeof message.cursor === 'string') lastUserCursor = message.cursor
        if (typeof message.name === 'string') lastUserName = message.name.slice(0, 60) || 'a collaborator'
        if (writing && typingOffset != null) {
          try {
            const userPos = A.getCursorPosition(handle.doc(), ['text'], lastUserCursor)
            if (Math.abs(userPos - typingOffset) <= 3) {
              abortTyping = true
              sendAssistantStatus('watching', 'Backing off while you edit there.', 'I stopped typing because your cursor moved onto my insertion point.')
            }
          } catch {}
          return
        }
        sendAgentCursor('watching')
      })
      handle.on('heads-changed', () => {
        console.log(`document updated · ${handle.heads().length} head(s) · ${new Date().toISOString()}`)
        if (!writing && !paused && !latestChangeIsAgent()) scheduleInspiredResponse()
      })
      console.log('agent-runner subscribed')
      sendAssistantStatus('watching', 'Assistant joined as a dynamic collaborator.', 'I will watch nearby text and occasionally add a short riff.')
      sendAgentCursor('watching')
      if ((handle.doc().text || '').trim()) scheduleInspiredResponse()
    } catch (error) {
      console.error(`document unavailable; retrying in ${retryMs}ms: ${error.message}`)
      await sleep(retryMs)
    }
  }
}

repo.networkSubsystem.on('peer', peerId => {
  console.log(`connected to peer ${peerId}`)
  sendAssistantStatus('watching', 'Assistant connected to the document.')
  sendAgentCursor('watching')
})
repo.networkSubsystem.on('peer-disconnected', peerId => {
  console.log(`disconnected from peer ${peerId}`)
})

subscribe()
const timer = setInterval(() => {
  if (!paused) {
    sendAssistantStatus('watching', lastUserCursor ? `Watching near ${lastUserName}'s cursor.` : 'Watching for document changes.')
    sendAgentCursor('watching')
  }
}, intervalMs)

process.on('SIGINT', () => {
  stopped = true
  clearInterval(timer)
  clearTimeout(debounceTimer)
  adapter.disconnect?.()
  console.log('\nagent-runner stopped')
  process.exit(0)
})
