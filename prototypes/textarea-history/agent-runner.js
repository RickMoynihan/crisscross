#!/usr/bin/env node
import { Repo } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'

const usage = () => `Usage: npm run agent -- <automerge-url> [--sync ws://localhost:3030]\n\nEnvironment:\n  AUTOMERGE_DOC_URL  Document URL when not passed as an argument\n  AUTOMERGE_SYNC_URL Sync server URL, default wss://sync.automerge.org\n  AGENT_INTERVAL_MS  Assistant message interval, default 8000\n`

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
const intervalMs = Number(option('--interval') || process.env.AGENT_INTERVAL_MS || 8000)
const retryMs = Number(option('--retry') || process.env.AGENT_RETRY_MS || 5000)

if (!docUrl) {
  console.error(usage())
  process.exit(1)
}

const cannedAssistant = [
  { summary: 'I’m watching for overlapping edits.', thoughts: 'No urgent conflicts detected yet.' },
  { summary: 'This branch has an active open commit.', thoughts: 'Consider checkpointing once the current passage settles.', feedback: 'Was this useful?' },
  { summary: 'Recent history looks merge-heavy.', thoughts: 'Review the merge detail column to compare parent diffs before naming the next checkpoint.' },
  { summary: 'I can help summarize unresolved review work.', thoughts: 'Future assistant feedback could tune which conflicts I surface first.', feedback: 'Tell me what to improve' },
]

const adapter = new WebSocketClientAdapter(syncUrl)
const repo = new Repo({
  network: [adapter],
  peerId: `agent-runner-${crypto.randomUUID()}`,
})

console.log(`agent-runner connecting to ${syncUrl}`)
console.log(`agent-runner subscribing to ${docUrl}`)

let handle = null, stopped = false, index = 0
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function subscribe() {
  while (!stopped && !handle) {
    try {
      const next = await repo.find(docUrl)
      if (stopped) return
      handle = next
      handle.on('heads-changed', () => {
        console.log(`document updated · ${handle.heads().length} head(s) · ${new Date().toISOString()}`)
      })
      console.log('agent-runner subscribed')
      sendAssistantMessage()
    } catch (error) {
      console.error(`document unavailable; retrying in ${retryMs}ms: ${error.message}`)
      await sleep(retryMs)
    }
  }
}

function sendAssistantMessage() {
  if (!handle) return
  const message = cannedAssistant[index++ % cannedAssistant.length]
  handle.broadcast({
    type: 'assistant',
    agent: 'agent-runner',
    sentAt: Date.now(),
    ...message,
  })
  console.log(`assistant ephemeral sent: ${message.summary}`)
}

repo.networkSubsystem.on('peer', peerId => {
  console.log(`connected to peer ${peerId}`)
  sendAssistantMessage()
})
repo.networkSubsystem.on('peer-disconnected', peerId => {
  console.log(`disconnected from peer ${peerId}`)
})

subscribe()
const timer = setInterval(sendAssistantMessage, intervalMs)

process.on('SIGINT', () => {
  stopped = true
  clearInterval(timer)
  adapter.disconnect?.()
  console.log('\nagent-runner stopped')
  process.exit(0)
})
