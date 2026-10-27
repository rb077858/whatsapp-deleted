// Web Push notifications to the users' (and the admin's) phones and browsers.
// Standard VAPID keys generated once and kept in DATA_DIR, so no push setup is needed in Firebase.
import webpush from 'web-push'
import { kvGet, kvSet, pushSubs, users, events } from './db.js'
import { BOT_NAME, SITE_URL } from './config.js'

let keys = kvGet('vapid')
if (!keys) {
  keys = webpush.generateVAPIDKeys()
  kvSet('vapid', keys)
}
webpush.setVapidDetails(SITE_URL || 'https://al-mahik.web.app', keys.publicKey, keys.privateKey)

export const publicKey = () => keys.publicKey

// replaceable in tests
export const transport = { send: (sub, body, opts) => webpush.sendNotification(sub, body, opts) }

/** What each kind of notification is, and the user setting that can turn it off. */
export const KINDS = {
  request: 'notifyRequests', // someone asked to join a backup group
  disconnect: 'notifyDisconnect', // WhatsApp got unlinked
  join: 'notifyJoins', // someone joined through a link
  admin: null // messages from the service – always delivered
}

async function deliver (subs, payload) {
  const body = JSON.stringify({ title: BOT_NAME, ...payload })
  let delivered = 0
  await Promise.all(subs.map(async s => {
    try {
      await transport.send({ endpoint: s.endpoint, keys: JSON.parse(s.keys) }, body, { TTL: 24 * 3600, urgency: payload.urgent ? 'high' : 'normal' })
      delivered++
    } catch (e) {
      // the browser unsubscribed or the subscription expired
      if (e.statusCode === 404 || e.statusCode === 410) pushSubs.remove(s.endpoint)
      else console.log('[push] failed:', e.statusCode || '', e.message)
    }
  }))
  return delivered
}

/**
 * Sends a notification to every device of a user (or 'admin').
 * payload: { title?, body, url?, tag?, actions?: [{action, title, url}] }
 */
export async function notifyUser (userId, kind, payload) {
  if (userId !== 'admin') {
    const u = users.get(userId)
    if (!u) return 0
    const setting = KINDS[kind]
    if (setting && u.settings[setting] === false) return 0
  }
  return deliver(pushSubs.forUser(userId), payload)
}

/** Admin broadcast to every user who enabled notifications. */
export async function notifyAll (payload) {
  const subs = pushSubs.all().filter(s => s.user_id !== 'admin')
  const n = await deliver(subs, payload)
  events.add(null, 'push', `התראה לכולם: ${payload.body.slice(0, 80)}`)
  return n
}
