import fs from 'node:fs'
import path from 'node:path'
import QRCode from 'qrcode'
import makeWASocket, { Browsers, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore, jidDecode } from 'baileys'
import { PENDING_DIR, SESSIONS_DIR } from './config.js'
import { users, kvGet } from './db.js'
import { Bot, baileysLogger } from './bot.js'

const JOIN_TIMEOUT = 3 * 60000
const MAX_PENDING_JOINS = 3

export const bots = new Map()
const joins = new Map()

export function startBot (userId) {
  let bot = bots.get(userId)
  if (bot) return bot
  bot = new Bot(userId)
  bots.set(userId, bot)
  bot.on('logged_out', () => bots.delete(userId))
  bot.start().catch(e => bot.log('start failed', e.message))
  return bot
}

export async function stopBot (userId) {
  const bot = bots.get(userId)
  if (bot) await bot.stop()
  bots.delete(userId)
}

export function startAll () {
  for (const u of users.all()) if (u.status === 'active') startBot(u.id)
  console.log(`started ${bots.size} WhatsApp connection(s)`)
}

export async function stopAll () {
  await Promise.all([...bots.values()].map(b => b.stop()))
  for (const j of joins.values()) j.cancel()
}

/** Is a new sign-up allowed right now? Returns an error message or null. */
export function registrationError (invite, phone) {
  if (phone && users.byPhone(phone)) return null // existing users can always reconnect
  const mode = kvGet('regMode')
  if (mode === 'closed') return 'ההרשמה סגורה כרגע.'
  if (mode === 'invite' && String(invite || '').trim() !== String(kvGet('inviteCode'))) return 'קוד ההזמנה שגוי.'
  if (mode === 'limit' && users.count() >= kvGet('regLimit')) return 'כל המקומות תפוסים כרגע 😕 נסו שוב בהמשך.'
  return null
}

/**
 * Starts a pairing session (QR or phone-number code).
 * `update(fields)` is called whenever there is something new to show the user.
 */
export async function startJoin (joinId, { method, phone, invite }, update) {
  if (joins.size >= MAX_PENDING_JOINS) return update({ status: 'error', error: 'יש עומס כרגע, נסו שוב בעוד דקה.' })
  const err = registrationError(invite, phone)
  if (err) return update({ status: 'error', error: err })

  const dir = path.join(PENDING_DIR, joinId)
  fs.rmSync(dir, { recursive: true, force: true })
  let sock = null
  let finished = false
  let codeRequested = false
  let attempts = 0

  const cleanup = () => {
    joins.delete(joinId)
    try { sock?.end(undefined) } catch {}
    sock = null
  }
  const fail = (error) => {
    if (finished) return
    finished = true
    cleanup()
    fs.rmSync(dir, { recursive: true, force: true })
    update({ status: 'error', error })
  }
  const timer = setTimeout(() => fail('הזמן לחיבור נגמר. נסו שוב.'), JOIN_TIMEOUT)
  joins.set(joinId, { cancel: () => { clearTimeout(timer); fail('בוטל') } })

  const finalize = async (creds, saveCreds) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    await saveCreds().catch(() => {})
    cleanup()
    const pn = jidDecode(creds.me?.id)?.user
    if (!pn) {
      fs.rmSync(dir, { recursive: true, force: true })
      return update({ status: 'error', error: 'החיבור נכשל, נסו שוב.' })
    }
    // the phone number registered on WhatsApp might not match the one entered: re-check sign-up rules
    const regErr = registrationError(invite, pn)
    if (regErr) {
      fs.rmSync(dir, { recursive: true, force: true })
      return update({ status: 'error', error: regErr })
    }
    let user = users.byPhone(pn)
    if (user) await stopBot(user.id)
    else user = users.create(pn)
    users.update(user.id, { status: 'active', name: creds.me?.name || user.name })
    const target = path.join(SESSIONS_DIR, user.id, 'auth')
    fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(dir, target)
    startBot(user.id)
    console.log(`[join] ${pn} connected (${user.id})`)
    update({ status: 'connected', userId: user.id, phone: pn, name: creds.me?.name || '' })
  }

  const connect = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(dir)
    sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    })
    const mySock = sock
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', async ({ connection, qr, lastDisconnect }) => {
      if (finished || mySock !== sock) return
      try {
        if (qr) {
          if (method === 'code') {
            if (!codeRequested) {
              codeRequested = true
              const code = await sock.requestPairingCode(phone)
              update({ status: 'code', code: code.match(/.{1,4}/g).join('-') })
            }
          } else {
            update({ status: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }) })
          }
        }
        if (connection === 'open') return finalize(state.creds, saveCreds)
        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode
          if (state.creds.me?.id) return finalize(state.creds, saveCreds)
          if (code === DisconnectReason.restartRequired) return connect()
          if (code === DisconnectReason.loggedOut) return fail('החיבור נדחה בוואטסאפ. נסו שוב.')
          if (++attempts > 4) return fail('בעיית תקשורת עם וואטסאפ. נסו שוב.')
          setTimeout(() => !finished && connect().catch(e => fail(e.message)), 1500)
        }
      } catch (e) {
        console.log('[join] error', e.message)
        fail(method === 'code' ? 'לא הצלחתי לייצר קוד. בדקו את מספר הטלפון ונסו שוב.' : 'משהו השתבש, נסו שוב.')
      }
    })
  }

  update({ status: 'starting' })
  connect().catch(e => fail(e.message))
}

export function cancelJoin (joinId) {
  joins.get(joinId)?.cancel()
}
