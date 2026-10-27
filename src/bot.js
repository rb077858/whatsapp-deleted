import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { EventEmitter } from 'node:events'
import pino from 'pino'
import makeWASocket, {
  Browsers, DisconnectReason, useMultiFileAuthState, makeCacheableSignalKeyStore,
  normalizeMessageContent, getContentType, downloadMediaMessage, jidDecode, proto, getBinaryNodeChild
} from 'baileys'
import { SESSIONS_DIR, TMP_DIR, BOT_NAME, BACKUP_SUFFIX } from './config.js'
import { users, backups, msgmap, contacts, events } from './db.js'
import * as T from './text.js'
import { SITE_URL } from './config.js'
import { maxMediaBytes, mediaAllowed, withMediaSlot, skipped } from './guard.js'

export const baileysLogger = pino({ level: process.env.BAILEYS_LOG || 'silent' })

const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  ptvMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker'
}

export function textOf (c) {
  if (!c) return ''
  return c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption ||
    c.documentMessage?.caption || c.pollCreationMessage?.name || c.pollCreationMessageV3?.name || ''
}

// what counts as "writing" in the updates group: real content, not reactions, deletes or edits
const NOT_WRITING = ['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pinInChatMessage', 'keepInChatMessage', 'pollUpdateMessage', 'encReactionMessage']
const isWriting = msg => {
  const t = getContentType(normalizeMessageContent(msg.message))
  return !!t && !NOT_WRITING.includes(t)
}

const phoneOf = jid => (jid && jid.endsWith('@s.whatsapp.net') ? jidDecode(jid)?.user : null)

/** One WhatsApp account connected to the service. */
export class Bot extends EventEmitter {
  constructor (userId) {
    super()
    this.userId = userId
    this.dir = path.join(SESSIONS_DIR, userId, 'auth')
    this.status = 'idle'
    this.sock = null
    this.stopped = false
    this.retries = 0
    this.sentIds = new Set()
    this.queue = Promise.resolve()
    this.groupCache = new Map()
    this.groupsList = null
    this.startupChecked = false
  }

  get user () { return users.get(this.userId) }
  log (...a) { console.log(`[${this.userId}]`, ...a) }

  async start () {
    if (this.user?.status === 'blocked') { this.status = 'blocked'; this.stopped = true; return }
    this.stopped = false
    this.status = 'connecting'
    const { state, saveCreds } = await useMultiFileAuthState(this.dir)
    if (!state.creds.me?.id) {
      this.log('no registered credentials, marking as logged out')
      return this.handleLoggedOut()
    }
    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLogger) },
      logger: baileysLogger,
      browser: Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      cachedGroupMetadata: async jid => this.groupCache.get(jid),
      getMessage: async () => undefined
    })
    this.sock = sock
    sock.ev.on('creds.update', saveCreds)
    sock.ev.on('connection.update', u => this.onConnection(sock, u).catch(e => this.log('connection handler error', e.message)))
    sock.ev.on('messages.upsert', ev => this.onMessages(ev).catch(e => this.log('messages handler error', e.message)))
    sock.ev.on('contacts.upsert', list => this.saveContacts(list))
    sock.ev.on('contacts.update', list => this.saveContacts(list))
    sock.ev.on('messaging-history.set', ({ contacts: list, chats }) => {
      this.saveContacts(list || [])
      for (const c of chats || []) if (c.name && !c.id.endsWith('@g.us')) contacts.upsert(this.userId, { jid: c.id, name: c.name })
    })
    sock.ev.on('groups.update', list => { for (const g of list) this.groupCache.delete(g.id); this.groupsList = null })
    sock.ev.on('group-participants.update', ({ id }) => this.groupCache.delete(id))
  }

  async onConnection (sock, { connection, lastDisconnect }) {
    if (sock !== this.sock) return
    if (connection === 'open') {
      this.status = 'open'
      this.retries = 0
      const me = sock.user || {}
      users.update(this.userId, { jid: me.id || null, lid: me.lid || null, name: me.name || me.notify || this.user?.name || null, last_seen: Date.now(), status: 'active' })
      this.log('connected as', phoneOf(me.id?.replace(/:\d+@/, '@')) || me.id)
      if (!this.connectedOnce) events.add(this.userId, 'connected', 'התחבר לוואטסאפ')
      this.connectedOnce = true
      this.emit('open')
      if (!this.startupChecked) {
        this.startupChecked = true
        this.retireControlGroup()
          .then(() => this.ensureUpdatesGroup())
          .catch(e => this.log('updates group error', e.message))
        this.lockExistingBackups().catch(e => this.log('lock backups error', e.message))
      }
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      this.status = 'closed'
      if (this.stopped) return
      if (code === DisconnectReason.loggedOut) return this.handleLoggedOut()
      const delay = code === DisconnectReason.restartRequired ? 500 : Math.min(60000, 2000 * 2 ** this.retries++)
      this.log(`disconnected (${code || 'network'}), reconnecting in ${Math.round(delay / 1000)}s`)
      setTimeout(() => { if (!this.stopped) this.start().catch(e => this.log('restart failed', e.message)) }, delay)
    }
  }

  /** `byRequest`: the user or the admin disconnected on purpose – no alert needed. */
  handleLoggedOut (byRequest = false) {
    events.add(this.userId, 'logged_out', byRequest ? 'נותק מוואטסאפ לפי בקשה' : 'התנתק מוואטסאפ (מכשיר מקושר הוסר)')
    this.status = 'logged_out'
    this.stopped = true
    this.sock = null
    fs.rmSync(this.dir, { recursive: true, force: true })
    users.update(this.userId, { status: 'logged_out' })
    this.log('logged out from WhatsApp')
    this.emit('logged_out')
  }

  async stop () {
    this.stopped = true
    try { this.sock?.end(undefined) } catch {}
    this.sock = null
    this.status = 'stopped'
  }

  /** Log out of WhatsApp (removes the linked device). */
  async logout () {
    this.stopped = true
    try { await this.sock?.logout() } catch {}
    this.handleLoggedOut(true)
  }

  // ---------- sending ----------
  enqueue (fn) {
    const p = this.queue.then(fn)
    this.queue = p.catch(e => this.log('send failed:', e.message))
    return p
  }

  async send (jid, content, opts) {
    if (!this.sock || this.status !== 'open') throw new Error('not connected')
    const m = await this.sock.sendMessage(jid, content, opts)
    if (m?.key?.id) {
      this.sentIds.add(m.key.id)
      if (this.sentIds.size > 3000) this.sentIds.delete(this.sentIds.values().next().value)
    }
    return m
  }

  // ---------- the updates group ----------
  /**
   * A read-only group with service updates (join requests, link joins, login codes, team messages).
   * It is created from the user's own account, so WhatsApp can't stop them from writing in it;
   * writing there blocks the account instead (see onMessages).
   */
  async ensureUpdatesGroup () {
    const jid = this.user.updates_jid
    if (jid) {
      try {
        const meta = await this.sock.groupMetadata(jid)
        if (meta?.id) return jid
      } catch (e) {
        this.log('updates group not reachable, creating a new one:', e.message)
      }
    }
    const meta = await this.sock.groupCreate(T.UPDATES_NAME, [])
    users.update(this.userId, { updates_jid: meta.id })
    await this.lockGroup(meta.id)
    await this.sock.groupUpdateDescription(meta.id, T.updatesDescription).catch(() => {})
    await this.enqueue(() => this.send(meta.id, { text: T.updatesWelcome(process.env.SITE_URL || SITE_URL) }))
    events.add(this.userId, 'updates_group', jid ? 'קבוצת העדכונים נוצרה מחדש' : 'קבוצת העדכונים נוצרה')
    return meta.id
  }

  /** Posts a message in the user's updates group (creating the group if needed). */
  async sendUpdate (text) {
    if (!this.sock || this.status !== 'open') throw new Error('הוואטסאפ של המשתמש לא מחובר כרגע.')
    const jid = this.user.updates_jid || await this.ensureUpdatesGroup()
    return this.enqueue(() => this.send(jid, { text }))
  }

  /** The user wrote in the updates group: block the account (the admin can unblock). */
  async blockForWriting (msg) {
    const what = textOf(normalizeMessageContent(msg.message)) || getContentType(normalizeMessageContent(msg.message)) || ''
    this.log('wrote in the updates group – blocking')
    users.update(this.userId, { status: 'blocked' })
    events.add(this.userId, 'blocked', `נחסם: נכתבה הודעה בקבוצת העדכונים${what ? ` ("${what.slice(0, 60)}")` : ''}`)
    await this.send(this.user.updates_jid, { text: T.blocked(process.env.SITE_URL || SITE_URL) }).catch(() => {})
    await this.stop()
    this.status = 'blocked'
    this.emit('blocked')
  }

  /**
   * Management moved to the website. Users who still have the old bot group get one
   * last message there, and the bot stops using it.
   */
  async retireControlGroup () {
    const jid = this.user.control_jid
    if (!jid) return
    users.update(this.userId, { control_jid: null })
    const site = process.env.SITE_URL || SITE_URL
    await this.enqueue(() => this.send(jid, { text: `🧽 *${BOT_NAME} עבר לאתר*\n\nמעכשיו כל הניהול – מה לגבות, הגדרות, שיתוף ובקשות הצטרפות – נעשה באתר${site ? `:\n${site}/app` : '.'}\n\nעדכונים יגיעו לקבוצה החדשה "${T.UPDATES_NAME}".\nאת הקבוצה הזו כבר אפשר למחוק 👋` })).catch(() => {})
    events.add(this.userId, 'control_group', 'הקבוצה הראשית הוחלפה בניהול דרך האתר')
  }

  // ---------- incoming messages ----------
  async onMessages ({ messages, type }) {
    const u = this.user
    if (!u) return
    for (const msg of messages) {
      if (!msg.message || !msg.key?.remoteJid) continue
      const jid = msg.key.remoteJid
      if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue
      if (this.sentIds.has(msg.key.id)) continue
      this.rememberSender(msg)
      if (jid === u.updates_jid) {
        if (type === 'notify' && msg.key.fromMe && isWriting(msg)) await this.blockForWriting(msg)
        continue
      }
      if (type !== 'notify') continue
      if (backups.byBackupJid(this.userId, jid)) continue
      const b = backups.bySource(this.userId, jid) || (msg.key.remoteJidAlt && backups.bySource(this.userId, msg.key.remoteJidAlt))
      if (!b || !b.active || u.settings.paused) continue
      this.enqueue(() => this.backupMessage(msg, b, u.settings))
    }
  }

  rememberSender (msg) {
    if (msg.key.fromMe || !msg.pushName) return
    const isGroup = msg.key.remoteJid.endsWith('@g.us')
    const a = isGroup ? msg.key.participant : msg.key.remoteJid
    const b = isGroup ? msg.key.participantAlt : msg.key.remoteJidAlt
    const pn = [a, b].find(j => j?.endsWith('@s.whatsapp.net'))
    const lid = [a, b].find(j => j?.endsWith('@lid'))
    if (pn || lid) contacts.upsert(this.userId, { jid: pn || lid, alt: pn ? lid : null, notify: msg.pushName })
  }

  saveContacts (list) {
    for (const c of list) {
      const pn = c.phoneNumber || (c.id?.endsWith('@s.whatsapp.net') ? c.id : null)
      const lid = c.lid || (c.id?.endsWith('@lid') ? c.id : null)
      const jid = pn || lid
      if (!jid) continue
      contacts.upsert(this.userId, { jid, alt: pn ? lid : null, name: c.name || null, notify: c.notify || c.verifiedName || null })
    }
  }

  senderName (msg) {
    if (msg.key.fromMe) return this.user?.name ? `${this.user.name} (אני)` : 'אני'
    const isGroup = msg.key.remoteJid.endsWith('@g.us')
    const ids = isGroup ? [msg.key.participant, msg.key.participantAlt] : [msg.key.remoteJid, msg.key.remoteJidAlt]
    let notify = null
    for (const id of ids.filter(Boolean)) {
      const c = contacts.get(this.userId, id)
      if (c?.name) return c.name
      notify = notify || c?.notify
    }
    if (msg.pushName || notify) return msg.pushName || notify
    const pn = ids.map(phoneOf).find(Boolean)
    return pn ? '+' + pn : 'לא ידוע'
  }

  // ---------- the backup itself ----------
  async backupMessage (msg, b, settings) {
    const content = normalizeMessageContent(msg.message)
    const ctype = getContentType(content)
    if (!ctype) return
    const sender = this.senderName(msg)
    if (ctype === 'protocolMessage') return this.handleProtocol(msg, b, settings, content.protocolMessage, sender)
    if (msg.key.fromMe && !settings.includeOwn) return
    if (['reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage', 'pinInChatMessage'].includes(ctype)) return

    const inner = content[ctype]
    const ctx = inner?.contextInfo
    const quotedMap = ctx?.stanzaId ? msgmap.get(this.userId, ctx.stanzaId) : null
    const opts = quotedMap
      ? { quoted: { key: { remoteJid: b.backup_jid, id: quotedMap.backup_id, fromMe: true }, message: { conversation: quotedMap.preview || '' } } }
      : undefined
    let header = `*${sender}*`
    if (!quotedMap && ctx?.quotedMessage) {
      const q = textOf(normalizeMessageContent(ctx.quotedMessage)) || '[מדיה]'
      header += `\n↩️ _בתגובה ל: "${q.slice(0, 80)}${q.length > 80 ? '…' : ''}"_`
    }
    if (ctx?.isForwarded) header += '\n_↪️ הועברה_'

    const record = (sent, preview) => {
      if (!sent?.key?.id) return
      msgmap.put(this.userId, msg.key.id, { backup_jid: b.backup_jid, backup_id: sent.key.id, sender, preview })
      backups.bump(b.id)
    }
    const sendText = async (text, preview = text) => record(await this.send(b.backup_jid, { text: `${header}\n${text}` }, opts), preview)

    if (ctype === 'conversation' || ctype === 'extendedTextMessage') {
      if (!settings.types.text) return
      return sendText(textOf(content))
    }
    if (ctype.startsWith('pollCreationMessage')) {
      if (!settings.types.text) return
      const opts2 = (inner.options || []).map(o => `▫️ ${o.optionName}`).join('\n')
      return sendText(`📊 *סקר:* ${inner.name}\n${opts2}`, `סקר: ${inner.name}`)
    }
    if (ctype === 'locationMessage' || ctype === 'liveLocationMessage') {
      if (!settings.types.location) return
      const head = await this.send(b.backup_jid, { text: `${header}\n${T.typeNames.location}${inner.name ? ': ' + inner.name : ''}` }, opts)
      record(head, '📍 מיקום')
      await this.send(b.backup_jid, { location: { degreesLatitude: inner.degreesLatitude, degreesLongitude: inner.degreesLongitude, name: inner.name || undefined, address: inner.address || undefined } })
      return
    }
    if (ctype === 'contactMessage' || ctype === 'contactsArrayMessage') {
      if (!settings.types.contact) return
      const list = ctype === 'contactMessage' ? [inner] : (inner.contacts || [])
      const head = await this.send(b.backup_jid, { text: `${header}\n${T.typeNames.contact}: ${list.map(c => c.displayName).join(', ')}` }, opts)
      record(head, '👤 איש קשר')
      await this.send(b.backup_jid, { contacts: { displayName: list[0]?.displayName || 'איש קשר', contacts: list.map(c => ({ vcard: c.vcard })) } })
      return
    }
    const mtype = MEDIA_TYPES[ctype]
    if (mtype) {
      if (!settings.types[mtype]) return
      return this.backupMedia(msg, b, settings, { ctype, mtype, inner, header, opts, record })
    }
    // anything else (events, buttons, etc.) – keep a short note so the backup stays complete
    if (settings.types.text) {
      const t = textOf(content)
      if (t) return sendText(t)
    }
  }

  async backupMedia (msg, b, settings, { ctype, mtype, inner, header, opts, record }) {
    const size = Number(inner.fileLength || 0)
    const caption = inner.caption ? `\n${inner.caption}` : ''
    const label = T.typeNames[mtype]
    const note = why => this.send(b.backup_jid, { text: `${header}\n${label} _(${why})_${caption}` }, opts).then(sent => record(sent, label))
    if (size && size > maxMediaBytes(settings.maxMediaMB)) skipped.size++
    if (size && size > maxMediaBytes(settings.maxMediaMB)) return note(`הקובץ לא גובה – ${Math.round(size / 1048576)}MB, מעל המגבלה`)
    const allowed = mediaAllowed(this.userId)
    if (allowed === 'rate') return note('הקובץ לא גובה – יותר מדי קבצים בדקה האחרונה')
    if (allowed === 'memory') return note('הקובץ לא גובה – עומס זמני על השרת')
    return withMediaSlot(() => this.transferMedia(msg, b, { mtype, inner, header, caption, label, opts, record }))
  }

  /** Downloads a media file to a temp file and sends it to the backup group. */
  async transferMedia (msg, b, { mtype, inner, header, caption, label, opts, record }) {
    const file = path.join(TMP_DIR, `${this.userId}-${msg.key.id}`)
    try {
      const stream = await downloadMediaMessage(msg, 'stream', {}, { logger: baileysLogger, reuploadRequest: this.sock.updateMediaMessage })
      await pipeline(stream, fs.createWriteStream(file))
      const media = { url: file }
      const thumb = inner.jpegThumbnail ? Buffer.from(inner.jpegThumbnail) : undefined
      let sent
      if (mtype === 'image') {
        sent = await this.send(b.backup_jid, { image: media, caption: header + caption, mimetype: inner.mimetype, jpegThumbnail: thumb }, opts)
      } else if (mtype === 'video') {
        sent = await this.send(b.backup_jid, { video: media, caption: header + caption, mimetype: inner.mimetype, gifPlayback: !!inner.gifPlayback, jpegThumbnail: thumb, seconds: inner.seconds || undefined }, opts)
      } else if (mtype === 'document') {
        sent = await this.send(b.backup_jid, { document: media, caption: header + caption, mimetype: inner.mimetype || 'application/octet-stream', fileName: inner.fileName || 'file', jpegThumbnail: thumb }, opts)
      } else {
        // audio and stickers cannot carry a caption: announce the sender first
        sent = await this.send(b.backup_jid, { text: `${header}\n${label}` }, opts)
        if (mtype === 'audio') {
          await this.send(b.backup_jid, { audio: media, mimetype: inner.mimetype || 'audio/ogg; codecs=opus', ptt: !!inner.ptt, seconds: inner.seconds || 1, waveform: inner.waveform || undefined })
        } else {
          await this.send(b.backup_jid, { sticker: media, isAnimated: !!inner.isAnimated })
        }
      }
      record(sent, inner.caption || label)
    } catch (e) {
      this.log('media backup failed:', e.message)
      record(await this.send(b.backup_jid, { text: `${header}\n${label} _(לא הצלחתי להוריד את הקובץ)_${caption}` }, opts), label)
    } finally {
      fs.rm(file, { force: true }, () => {})
    }
  }

  async handleProtocol (msg, b, settings, pm, sender) {
    const target = pm.key?.id
    const mm = target && msgmap.get(this.userId, target)
    if (!mm) return
    const quoted = { quoted: { key: { remoteJid: b.backup_jid, id: mm.backup_id, fromMe: true }, message: { conversation: mm.preview || '' } } }
    if (pm.type === proto.Message.ProtocolMessage.Type.REVOKE && settings.alertDeleted) {
      await this.send(b.backup_jid, { text: `🗑️ *${sender}* מחק/ה את ההודעה הזו` }, quoted)
    } else if (pm.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && settings.alertEdited) {
      const t = textOf(normalizeMessageContent(pm.editedMessage))
      await this.send(b.backup_jid, { text: `✏️ *${sender}* ערך/ה את ההודעה הזו ל:\n${t}` }, quoted)
    }
  }

  // ---------- backup group permissions & members ----------
  /** Only admins (the user) may send, edit the group info, or add members. */
  async lockGroup (jid) {
    for (const [fn, arg] of [['groupSettingUpdate', 'announcement'], ['groupSettingUpdate', 'locked'], ['groupMemberAddMode', 'admin_add']]) {
      await this.sock[fn](jid, arg).catch(e => this.log(`${fn}(${arg}) failed:`, e.message))
    }
  }

  /** One-time: lock backup groups created before groups were locked automatically. */
  async lockExistingBackups () {
    const u = this.user
    if (u.settings.groupsLocked) return
    for (const b of backups.list(this.userId)) await this.lockGroup(b.backup_jid)
    users.update(this.userId, { settings: { ...this.user.settings, groupsLocked: true } })
  }

  /**
   * Adds a phone number to a backup group. When the person's privacy settings
   * don't allow being added, WhatsApp hands back a personal invite, which is sent to them.
   * Returns 'added' | 'invited' | 'already'.
   */
  async addToGroup (b, phone) {
    if (!this.sock || this.status !== 'open') throw new Error('הוואטסאפ לא מחובר כרגע')
    const [found] = await this.sock.onWhatsApp(phone + '@s.whatsapp.net').catch(() => [])
    if (!found?.exists) throw new Error('המספר הזה לא רשום בוואטסאפ')
    const [res] = await this.sock.groupParticipantsUpdate(b.backup_jid, [found.jid], 'add')
    const status = String(res?.status || '')
    if (status === '200') return 'added'
    if (status === '409') return 'already'
    if (status === '403') {
      const req = getBinaryNodeChild(res.content, 'add_request')
      if (!req?.attrs?.code) throw new Error('לא ניתן להוסיף את המספר הזה')
      const subject = (this.groupCache.get(b.backup_jid)?.subject) || `${b.source_name}${BACKUP_SUFFIX}`
      // relayed directly (not sendMessage) so no group-picture lookup is needed
      const msg = proto.Message.fromObject({
        groupInviteMessage: {
          groupJid: b.backup_jid,
          inviteCode: req.attrs.code,
          inviteExpiration: Number(req.attrs.expiration) || Math.floor(Date.now() / 1000) + 3 * 86400,
          groupName: subject,
          caption: `הוזמנת לקבוצת הגיבוי "${subject}" 🧽`
        }
      })
      await this.enqueue(() => this.sock.relayMessage(found.jid, msg, {}))
      return 'invited'
    }
    throw new Error(status === '408' ? 'המספר יצא מהקבוצה לאחרונה, נסו שוב מאוחר יותר' : `וואטסאפ דחה את הבקשה (${status})`)
  }

  async groupMembers (b) {
    const meta = await this.sock.groupMetadata(b.backup_jid)
    this.groupCache.set(meta.id, meta)
    const me = phoneOf(this.user.jid?.replace(/:\d+@/, '@'))
    return meta.participants.map(p => {
      const pnJid = [p.phoneNumber, p.id, p.jid].find(j => j?.endsWith('@s.whatsapp.net'))
      const phone = phoneOf(pnJid) || null
      const c = contacts.get(this.userId, pnJid || p.id)
      return { id: p.id, phone, name: c?.name || c?.notify || null, admin: !!p.admin, me: !!phone && phone === me }
    })
  }

  async removeFromGroup (b, participantId) {
    const [res] = await this.sock.groupParticipantsUpdate(b.backup_jid, [participantId], 'remove')
    if (String(res?.status) !== '200') throw new Error('לא הצלחתי להסיר')
  }

  // ---------- searching & creating backups ----------
  async allGroups () {
    if (this.groupsList && Date.now() - this.groupsList.at < 120000) return this.groupsList.list
    const res = await this.sock.groupFetchAllParticipating()
    const list = Object.values(res)
    for (const g of list) this.groupCache.set(g.id, g)
    this.groupsList = { at: Date.now(), list }
    return list
  }

  /** Groups and private chats matching a free-text query. */
  async search (query, limit = 15) {
    const q = String(query || '').trim().toLowerCase()
    const u = this.user
    const own = new Set(backups.list(this.userId).map(b => b.backup_jid))
    own.add(u.updates_jid)
    const results = []
    const groups = await this.allGroups().catch(() => [])
    for (const g of groups) {
      if (own.has(g.id) || !g.subject) continue
      if (g.subject.endsWith(BACKUP_SUFFIX.trim()) || g.subject === BOT_NAME) continue
      if (!q || g.subject.toLowerCase().includes(q)) results.push({ jid: g.id, name: g.subject, kind: 'group', size: g.participants?.length || 0 })
    }
    if (q) {
      for (const c of contacts.search(this.userId, q, limit)) {
        if (c.jid.endsWith('@g.us') || c.jid.includes('broadcast')) continue
        const name = c.name || c.notify || '+' + (phoneOf(c.jid) || c.jid.split('@')[0])
        results.push({ jid: c.jid, alt: c.alt, name, kind: 'private' })
      }
      const digits = q.replace(/\D/g, '')
      if (digits.length >= 9 && !results.some(r => r.kind === 'private')) {
        const pn = (digits.startsWith('0') ? '972' + digits.slice(1) : digits) + '@s.whatsapp.net'
        const [found] = await this.sock.onWhatsApp(pn).catch(() => [])
        if (found?.exists) results.push({ jid: found.jid, name: '+' + phoneOf(found.jid), kind: 'private' })
      }
    }
    for (const r of results) r.backedUp = !!backups.bySource(this.userId, r.jid)
    results.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'he') : a.kind === 'group' ? -1 : 1))
    return results.slice(0, limit)
  }

  async createBackup ({ jid, alt, name, kind }) {
    const existing = backups.bySource(this.userId, jid)
    if (existing) {
      backups.setActive(this.userId, existing.id, true)
      return existing
    }
    if (kind === 'private' && !alt && jid.endsWith('@s.whatsapp.net')) {
      alt = await this.sock.signalRepository?.lidMapping?.getLIDForPN(jid).catch(() => null) || null
    }
    const subject = name.slice(0, 100 - BACKUP_SUFFIX.length) + BACKUP_SUFFIX
    const meta = await this.sock.groupCreate(subject, [])
    const b = backups.add(this.userId, { source_jid: jid, source_alt: alt, source_name: name, kind, backup_jid: meta.id })
    this.groupsList = null
    await this.sock.groupUpdateDescription(meta.id, `גיבוי אוטומטי של "${name}" ע"י ${BOT_NAME}`).catch(() => {})
    await this.lockGroup(meta.id)
    await this.enqueue(() => this.send(meta.id, { text: T.backupIntro(name, kind) }))
    this.log('backup created for', kind, name)
    events.add(this.userId, 'backup', `גיבוי חדש: ${name}`)
    return b
  }
}
