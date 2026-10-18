// Firestore relay: the website (Firebase Hosting) writes requests, this process answers them.
// The phone never needs to be reachable from the internet.
import fs from 'node:fs'
import { initializeApp, cert, deleteApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { SERVICE_ACCOUNT_FILE } from './config.js'
import { handlers, ApiError, publicStatus } from './api.js'
import { ShareError } from './sharing.js'
import { startJoin, cancelJoin } from './manager.js'
import { sessions, msgmap } from './db.js'

let app = null
let fsdb = null
let unsubs = []
let timers = []
export let relayState = { configured: false, connected: false, projectId: null, error: null }

export function loadServiceAccount () {
  try {
    if (fs.existsSync(SERVICE_ACCOUNT_FILE)) return JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8'))
    const env = process.env.FIREBASE_SERVICE_ACCOUNT
    if (env) return JSON.parse(env.trim().startsWith('{') ? env : Buffer.from(env, 'base64').toString('utf8'))
  } catch (e) {
    relayState.error = 'קובץ ה-service account לא תקין: ' + e.message
  }
  return null
}

const rate = new Map()
function limited (uid) {
  const t = Date.now()
  const r = rate.get(uid) || { n: 0, at: t }
  if (t - r.at > 60000) { r.n = 0; r.at = t }
  r.n++
  rate.set(uid, r)
  return r.n > 40
}

const isFresh = doc => {
  const at = doc.get('createdAt')?.toMillis?.()
  return !at || Date.now() - at < 120000
}

async function handleRpc (doc) {
  const ref = doc.ref
  const { op, args, uid } = doc.data()
  if (!isFresh(doc)) return ref.update({ status: 'error', error: 'expired' })
  if (limited(uid)) return ref.update({ status: 'error', error: 'יותר מדי בקשות, חכו דקה.' })
  const fn = Object.hasOwn(handlers, op) ? handlers[op] : null
  try {
    if (!fn) throw new ApiError('unknown op')
    const result = await fn({ ...(args || {}), token: doc.get('token') || args?.token })
    await ref.update({ status: 'done', result: JSON.parse(JSON.stringify(result ?? {})), token: FieldValue.delete() })
  } catch (e) {
    if (!(e instanceof ApiError || e instanceof ShareError)) console.log(`[rpc] ${op} failed:`, e.message)
    await ref.update({ status: 'error', error: (e instanceof ApiError || e instanceof ShareError) ? e.message : 'שגיאה בשרת, נסו שוב.', token: FieldValue.delete() }).catch(() => {})
  }
}

function handleJoin (doc) {
  const ref = doc.ref
  const d = doc.data()
  if (!isFresh(doc)) return ref.update({ status: 'error', error: 'expired' })
  if (limited(d.uid)) return ref.update({ status: 'error', error: 'יותר מדי בקשות, חכו דקה.' })
  const method = d.method === 'code' ? 'code' : 'qr'
  const phone = String(d.phone || '').replace(/\D/g, '').replace(/^0/, '972')
  if (method === 'code' && phone.length < 9) return ref.update({ status: 'error', error: 'מספר הטלפון לא תקין.' })
  // stop pairing if the visitor closes the page (the website deletes the doc or sets status=cancel)
  const unsub = ref.onSnapshot(s => { if (!s.exists || s.get('status') === 'cancel') { cancelJoin(doc.id); unsub() } }, () => {})
  startJoin(doc.id, { method, phone, invite: d.invite }, (fields) => {
    if (fields.userId) {
      fields.token = sessions.create(fields.userId)
      delete fields.userId
    }
    if (['connected', 'error'].includes(fields.status)) unsub()
    ref.update({ ...fields, updatedAt: FieldValue.serverTimestamp() }).catch(() => {})
  })
}

// Each request is handled once, whether it arrives through the live listener or the watchdog.
const seen = new Map()
function handleOnce (collection, handler, d) {
  if (seen.has(d.id)) return
  seen.set(d.id, Date.now())
  Promise.resolve(handler(d)).catch(e => console.log(`[${collection}]`, e.message))
}

const listeners = {}
function listen (collection, handler) {
  const sub = () => {
    listeners[collection]?.()
    listeners[collection] = fsdb.collection(collection).where('status', '==', 'pending').onSnapshot(
      snap => {
        relayState.connected = true
        for (const ch of snap.docChanges()) if (ch.type === 'added') handleOnce(collection, handler, ch.doc)
      },
      err => {
        relayState.connected = false
        console.log(`[relay] ${collection} listener error: ${err.message} – retrying in 10s`)
        setTimeout(sub, 10000)
      }
    )
  }
  sub()
  unsubs.push(() => listeners[collection]?.())
  return sub
}

/**
 * A live listener can stall silently (e.g. after the phone switches networks) while
 * the heartbeat still works. Every 30s, look for requests nobody answered: handle them
 * and re-open the listener.
 */
async function watchdog (subs) {
  const cutoff = Date.now() - 12000
  for (const [c, handler] of [['rpc', handleRpc], ['joins', handleJoin]]) {
    const snap = await fsdb.collection(c).where('status', '==', 'pending').limit(50).get().catch(() => null)
    if (!snap) continue
    const stuck = snap.docs.filter(d => (d.get('createdAt')?.toMillis?.() || 0) < cutoff && !seen.has(d.id))
    if (!stuck.length) continue
    console.log(`[relay] watchdog: ${stuck.length} unanswered ${c} request(s), reconnecting listener`)
    stuck.forEach(d => handleOnce(c, handler, d))
    subs[c]()
  }
  for (const [id, t] of seen) if (t < Date.now() - 10 * 60000) seen.delete(id)
}

async function heartbeat (online = true) {
  if (!fsdb) return
  await fsdb.doc('public/status').set({ ...publicStatus(), online, updatedAt: FieldValue.serverTimestamp() }).catch(e => console.log('[relay] heartbeat failed:', e.message))
}

async function cleanup () {
  const cutoff = new Date(Date.now() - 15 * 60000)
  for (const c of ['rpc', 'joins']) {
    const snap = await fsdb.collection(c).where('createdAt', '<', cutoff).limit(300).get().catch(() => null)
    if (!snap || snap.empty) continue
    const batch = fsdb.batch()
    snap.docs.forEach(d => batch.delete(d.ref))
    await batch.commit().catch(() => {})
  }
  sessions.prune()
  msgmap.prune(60)
}

export async function startRelay () {
  await stopRelay()
  const sa = loadServiceAccount()
  relayState = { configured: !!sa, connected: false, projectId: sa?.project_id || null, error: relayState.error }
  if (!sa) {
    console.log('⚠️  Firebase is not configured yet: open the "הגדרת שרת" page in the app to upload the service account.')
    return
  }
  process.env.SITE_URL ||= `https://${sa.project_id}.web.app`
  app = initializeApp({ credential: cert(sa), projectId: sa.project_id }, 'relay-' + Date.now())
  fsdb = getFirestore(app)
  const subs = { rpc: listen('rpc', handleRpc), joins: listen('joins', handleJoin) }
  timers.push(setInterval(() => watchdog(subs).catch(e => console.log('[relay] watchdog:', e.message)), 30000))
  await heartbeat()
  timers.push(setInterval(() => heartbeat(), 60000))
  timers.push(setInterval(() => cleanup().catch(() => {}), 10 * 60000))
  console.log(`relay listening on Firebase project "${sa.project_id}"`)
}

export async function stopRelay () {
  timers.forEach(clearInterval)
  timers = []
  unsubs.forEach(u => { try { u() } catch {} })
  unsubs = []
  if (app) {
    await heartbeat(false)
    await deleteApp(app).catch(() => {})
  }
  app = null
  fsdb = null
}
