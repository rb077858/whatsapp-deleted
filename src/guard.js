// Keeps the phone cool: caps media size, media rate per user, parallel transfers and memory use.
import v8 from 'node:v8'
import { kvGet } from './db.js'

const MB = 1024 * 1024
const HEAP_LIMIT = v8.getHeapStatistics().heap_size_limit
const MAX_PARALLEL = 2

export const skipped = { size: 0, rate: 0, memory: 0, since: Date.now() }

export function memory () {
  const m = process.memoryUsage()
  const ratio = m.heapUsed / HEAP_LIMIT
  return {
    rssMB: Math.round(m.rss / MB),
    heapMB: Math.round(m.heapUsed / MB),
    limitMB: Math.round(HEAP_LIMIT / MB),
    percent: Math.round(ratio * 100),
    level: ratio > 0.85 ? 'high' : ratio > 0.7 ? 'warn' : 'ok'
  }
}

/** The user's own limit, never above the admin's cap. */
export const maxMediaMB = userMB => Math.max(1, Math.min(Number(userMB) || 16, kvGet('maxMediaMB')))
export const maxMediaBytes = userMB => maxMediaMB(userMB) * MB

const recent = new Map() // userId -> timestamps of media backups in the last minute

/** Whether a media file may be backed up now: 'ok', 'rate' or 'memory'. */
export function mediaAllowed (userId) {
  if (memory().level === 'high') { skipped.memory++; return 'memory' }
  const t = Date.now()
  const list = (recent.get(userId) || []).filter(x => x > t - 60000)
  if (list.length >= kvGet('mediaPerMinute')) { recent.set(userId, list); skipped.rate++; return 'rate' }
  list.push(t)
  recent.set(userId, list)
  return 'ok'
}

let active = 0
const waiting = []
/** At most MAX_PARALLEL media downloads/uploads at once, across all users. */
export async function withMediaSlot (fn) {
  while (active >= MAX_PARALLEL) await new Promise(r => waiting.push(r))
  active++
  try {
    return await fn()
  } finally {
    active--
    waiting.shift()?.()
  }
}

let lastWarn = 0
setInterval(() => {
  const m = memory()
  if (m.level !== 'ok' && Date.now() - lastWarn > 10 * 60000) {
    lastWarn = Date.now()
    console.log(`⚠️ memory ${m.percent}% of limit (${m.heapMB}/${m.limitMB}MB heap, ${m.rssMB}MB total)${m.level === 'high' ? ' – media backups paused until it drops' : ''}`)
  }
}, 30000).unref()
