import { events, links, joinRequests, users, backups, sessions, loginCodes, kvGet, kvSet, normalizePhone, randomCode, sha, checkPassword, hashPassword } from './db.js'
import { bots, startBot, stopBot, registrationError, startJoin, cancelJoin } from './manager.js'
import { mergeSettings, BOT_NAME, TYPE_LABELS } from './config.js'
import * as T from './text.js'
import { memory, skipped } from './guard.js'
import { publicLinkInfo, joinByLink, decideRequest, linkView, linkFields } from './sharing.js'

export class ApiError extends Error {}
const inviteFailures = []
const linkTries = new Map()
const relinks = new Map() // userId -> { status, code, error, joinId, at }
const fail = msg => { throw new ApiError(msg) }

function requireUser (token) {
  const s = sessions.get(token)
  if (!s || s.role !== 'user') fail('AUTH')
  const user = users.get(s.user_id)
  if (!user) fail('AUTH')
  return user
}
function requireAdmin (token) {
  const s = sessions.get(token)
  if (!s || s.role !== 'admin') fail('AUTH')
}
function requireBot (user) {
  const bot = bots.get(user.id)
  if (!bot || bot.status !== 'open') fail('הוואטסאפ שלך לא מחובר כרגע. נסו שוב בעוד רגע.')
  return bot
}

const publicUser = (u) => {
  const bot = bots.get(u.id)
  return {
    phone: u.phone,
    name: u.name,
    status: u.status === 'logged_out' ? 'logged_out' : (bot?.status || 'stopped'),
    settings: u.settings,
    createdAt: u.created_at
  }
}

const userStatus = u => (u.status === 'logged_out' ? 'logged_out' : (bots.get(u.id)?.status || 'stopped'))

export function publicStatus () {
  const mode = kvGet('regMode')
  return {
    botName: BOT_NAME,
    siteUrl: process.env.SITE_URL || null,
    regMode: mode,
    full: mode === 'closed' || (mode === 'limit' && users.count() >= kvGet('regLimit')),
    typeLabels: TYPE_LABELS
  }
}

// rpc name -> handler(args)
export const handlers = {
  status: () => publicStatus(),

  // checked by the join page before pairing starts; wrong guesses are throttled globally
  checkInvite ({ invite }) {
    const t = Date.now()
    while (inviteFailures.length && inviteFailures[0] < t - 10 * 60000) inviteFailures.shift()
    if (inviteFailures.length >= 30) fail('יותר מדי ניסיונות שגויים. נסו שוב בעוד כמה דקות.')
    const err = registrationError(invite)
    if (err) {
      if (/הזמנה/.test(err)) inviteFailures.push(t)
      fail(err)
    }
    return { ok: true }
  },

  // ---------- login with a code sent to the bot group ----------
  async loginStart ({ phone }) {
    const pn = normalizePhone(phone)
    if (!pn) fail('מספר הטלפון לא תקין.')
    const user = users.byPhone(pn)
    if (!user) fail('המספר הזה עוד לא רשום. הצטרפו קודם 🙂')
    const bot = bots.get(user.id)
    if (!bot || bot.status !== 'open' || !user.control_jid) fail('הוואטסאפ של המספר הזה לא מחובר כרגע. אפשר להתחבר מחדש דרך "הצטרפות".')
    const prev = loginCodes.get(pn)
    if (prev && prev.expires - 4 * 60000 > Date.now()) fail('כבר שלחתי קוד לפני רגע, בדקו בקבוצה.')
    const code = randomCode()
    loginCodes.set(pn, code)
    await bot.sendControl(T.loginCode(code))
    return { sent: true, botName: BOT_NAME }
  },

  async loginVerify ({ phone, code }) {
    const pn = normalizePhone(phone)
    const row = pn && loginCodes.get(pn)
    if (!row || row.expires < Date.now()) fail('הקוד פג תוקף. בקשו קוד חדש.')
    if (row.attempts >= 5) { loginCodes.clear(pn); fail('יותר מדי ניסיונות. בקשו קוד חדש.') }
    if (row.code_hash !== sha(String(code || '').trim())) { loginCodes.fail(pn); fail('הקוד שגוי.') }
    loginCodes.clear(pn)
    const user = users.byPhone(pn)
    return { token: sessions.create(user.id) }
  },

  async logout ({ token }) { sessions.revoke(token); return {} },

  // ---------- dashboard ----------
  async me ({ token }) {
    const user = requireUser(token)
    const list = backups.list(user.id)
    const names = Object.fromEntries(list.map(b => [b.id, b.source_name]))
    return {
      user: publicUser(user),
      limits: { maxMediaMB: kvGet('maxMediaMB') },
      backups: list.map(b => ({ id: b.id, name: b.source_name, kind: b.kind, active: !!b.active, count: b.count, createdAt: b.created_at, links: links.forBackup(user.id, b.id).filter(l => l.active).length })),
      requests: joinRequests.pending(user.id).map(r => ({ id: r.id, phone: r.phone, name: r.name, group: names[r.backup_id] || '', createdAt: r.created_at }))
    }
  },

  async searchChats ({ token, query }) {
    const bot = requireBot(requireUser(token))
    return { results: await bot.search(query || '', 60) }
  },

  async addBackups ({ token, chats }) {
    const user = requireUser(token)
    const bot = requireBot(user)
    if (!Array.isArray(chats) || !chats.length || chats.length > 20) fail('בחירה לא תקינה.')
    const out = []
    for (const c of chats) {
      if (typeof c?.jid !== 'string' || typeof c?.name !== 'string') continue
      try {
        await bot.createBackup({ jid: c.jid, alt: c.alt || null, name: c.name.slice(0, 90), kind: c.jid.endsWith('@g.us') ? 'group' : 'private' })
        out.push({ name: c.name, ok: true })
      } catch (e) {
        out.push({ name: c.name, ok: false, error: e.message })
      }
    }
    const ok = out.filter(o => o.ok).map(o => `✅ ${o.name}`)
    if (ok.length) bot.sendControl(`💻 נוספו גיבויים מהממשק:\n${ok.join('\n')}`).catch(() => {})
    return { results: out }
  },

  async setBackupActive ({ token, id, active }) {
    const user = requireUser(token)
    backups.setActive(user.id, Number(id), !!active)
    return {}
  },

  async removeBackup ({ token, id }) {
    const user = requireUser(token)
    backups.remove(user.id, Number(id))
    links.removeForBackup(user.id, Number(id))
    return {}
  },

  // ---------- sharing a backup group ----------
  async groupMembers ({ token, id }) {
    const user = requireUser(token)
    const b = backups.get(user.id, Number(id)) || fail('הקבוצה לא נמצאה.')
    return { members: await requireBot(user).groupMembers(b) }
  },

  async addMember ({ token, id, phone }) {
    const user = requireUser(token)
    const b = backups.get(user.id, Number(id)) || fail('הקבוצה לא נמצאה.')
    const pn = normalizePhone(phone) || fail('מספר הטלפון לא תקין.')
    const bot = requireBot(user)
    try {
      return { status: await bot.addToGroup(b, pn) }
    } catch (e) { fail(e.message) }
  },

  async removeMember ({ token, id, participant }) {
    const user = requireUser(token)
    const b = backups.get(user.id, Number(id)) || fail('הקבוצה לא נמצאה.')
    const bot = requireBot(user)
    try { await bot.removeFromGroup(b, String(participant)) } catch (e) { fail(e.message) }
    return {}
  },

  async listLinks ({ token, id }) {
    const user = requireUser(token)
    return { links: links.forBackup(user.id, Number(id)).map(linkView) }
  },

  async createLink ({ token, id, options }) {
    const user = requireUser(token)
    const b = backups.get(user.id, Number(id)) || fail('הקבוצה לא נמצאה.')
    if (links.forBackup(user.id, b.id).length >= 20) fail('אפשר עד 20 קישורים לקבוצה.')
    return { link: linkView(links.create(user.id, b.id, linkFields({ who: 'anyone', ...options }))) }
  },

  async updateLink ({ token, linkId, options }) {
    const user = requireUser(token)
    const l = links.get(String(linkId))
    if (!l || l.user_id !== user.id) fail('הקישור לא נמצא.')
    links.update(user.id, l.id, linkFields(options))
    return { link: linkView(links.get(l.id)) }
  },

  async deleteLink ({ token, linkId }) {
    const user = requireUser(token)
    links.remove(user.id, String(linkId))
    return {}
  },

  async decideRequest ({ token, requestId, approve }) {
    const user = requireUser(token)
    return { status: (await decideRequest(user.id, requestId, !!approve)).status }
  },

  // public join-link page (no login)
  linkInfo ({ link }) { return publicLinkInfo(link) },

  async linkJoin ({ link, phone, name }) {
    const t = Date.now()
    const tries = (linkTries.get(link) || []).filter(x => x > t - 10 * 60000)
    if (tries.length >= 20) fail('יותר מדי ניסיונות בקישור הזה. נסו שוב בעוד כמה דקות.')
    linkTries.set(link, [...tries, t])
    return joinByLink(link, phone, name)
  },

  async saveSettings ({ token, settings }) {
    const user = requireUser(token)
    const s = mergeSettings(user.settings)
    const inc = settings || {}
    for (const k of Object.keys(s.types)) if (typeof inc.types?.[k] === 'boolean') s.types[k] = inc.types[k]
    for (const k of ['alertDeleted', 'alertEdited', 'includeOwn', 'paused']) if (typeof inc[k] === 'boolean') s[k] = inc[k]
    if (Number.isFinite(inc.maxMediaMB)) s.maxMediaMB = Math.max(1, Math.min(100, Math.round(inc.maxMediaMB)))
    users.update(user.id, { settings: s })
    return { settings: s }
  },

  /** The user deletes their account: unlink WhatsApp and remove everything stored about them. */
  async deleteAccount ({ token }) {
    const user = requireUser(token)
    const bot = bots.get(user.id)
    if (bot) await bot.logout()
    bots.delete(user.id)
    users.remove(user.id)
    events.add(null, 'deleted', `${user.name || user.phone} מחק/ה את החשבון`)
    return {}
  },

  async disconnect ({ token }) {
    const user = requireUser(token)
    const bot = bots.get(user.id)
    if (bot) await bot.logout()
    bots.delete(user.id)
    users.update(user.id, { status: 'logged_out' })
    sessions.revoke(token)
    return {}
  },

  // ---------- admin ----------
  async adminLogin ({ username, password }) {
    if (username !== kvGet('adminUser') || !checkPassword(password, kvGet('adminPass'))) fail('שם משתמש או סיסמה שגויים.')
    return { token: sessions.create('admin', 'admin', 7) }
  },

  async adminOverview ({ token }) {
    requireAdmin(token)
    const list = users.all().map(u => {
      const b = backups.list(u.id)
      return { id: u.id, phone: u.phone, name: u.name, status: userStatus(u), backups: b.length, messages: b.reduce((a, x) => a + x.count, 0), createdAt: u.created_at, lastSeen: u.last_seen, paused: !!u.settings.paused, requests: joinRequests.pending(u.id).length, note: u.admin_note || '' }
    })
    const names = Object.fromEntries(list.map(u => [u.id, u.name || u.phone]))
    return {
      users: list,
      settings: { regMode: kvGet('regMode'), regLimit: kvGet('regLimit'), inviteCode: kvGet('inviteCode'), adminUser: kvGet('adminUser'), maxMediaMB: kvGet('maxMediaMB'), mediaPerMinute: kvGet('mediaPerMinute') },
      guard: { memory: memory(), skipped, connections: [...bots.values()].filter(b => b.status === 'open').length },
      totals: backups.totals(),
      events: events.recent(40).map(e => ({ ...e, who: names[e.user_id] || null })),
      server: { uptime: Math.round(process.uptime()), rssMB: memory().rssMB, heapMB: memory().heapMB, node: process.version }
    }
  },

  async adminSaveSettings ({ token, settings }) {
    requireAdmin(token)
    const s = settings || {}
    if (['open', 'limit', 'invite', 'closed'].includes(s.regMode)) kvSet('regMode', s.regMode)
    if (Number.isFinite(s.regLimit)) kvSet('regLimit', Math.max(0, Math.round(s.regLimit)))
    if (typeof s.inviteCode === 'string' && s.inviteCode.trim()) kvSet('inviteCode', s.inviteCode.trim().slice(0, 40))
    if (Number.isFinite(s.maxMediaMB)) kvSet('maxMediaMB', Math.max(1, Math.min(100, Math.round(s.maxMediaMB))))
    if (Number.isFinite(s.mediaPerMinute)) kvSet('mediaPerMinute', Math.max(1, Math.min(120, Math.round(s.mediaPerMinute))))
    if (typeof s.adminUser === 'string' && s.adminUser.trim()) kvSet('adminUser', s.adminUser.trim())
    if (typeof s.newPassword === 'string' && s.newPassword) {
      if (s.newPassword.length < 6) fail('הסיסמה צריכה להיות לפחות 6 תווים.')
      kvSet('adminPass', hashPassword(s.newPassword))
    }
    return {}
  },

  // ---------- customer service ----------
  async adminUser ({ token, userId }) {
    requireAdmin(token)
    const u = users.get(userId) || fail('משתמש לא נמצא.')
    const bot = bots.get(u.id)
    return {
      user: { id: u.id, phone: u.phone, name: u.name, status: userStatus(u), createdAt: u.created_at, lastSeen: u.last_seen, note: u.admin_note || '', settings: u.settings, hasControl: !!u.control_jid, list: u.list_id === '-' ? 'deleted' : u.list_id ? 'active' : 'none' },
      backups: backups.list(u.id).map(b => ({ id: b.id, name: b.source_name, kind: b.kind, active: !!b.active, count: b.count, createdAt: b.created_at, links: links.forBackup(u.id, b.id).length })),
      requests: joinRequests.pending(u.id).length,
      events: events.recent(60, u.id),
      online: bot?.status === 'open'
    }
  },

  async adminUserAction ({ token, userId, action }) {
    requireAdmin(token)
    const user = users.get(userId) || fail('משתמש לא נמצא.')
    const bot = bots.get(user.id)
    const live = () => (bot?.status === 'open' ? bot : fail('הוואטסאפ של המשתמש לא מחובר כרגע.'))
    const log = text => events.add(user.id, 'admin', text)
    switch (action) {
      case 'restart':
        await stopBot(user.id)
        if (user.status !== 'logged_out') startBot(user.id)
        log('המנהל הפעיל מחדש את החיבור')
        return { message: 'החיבור הופעל מחדש' }
      case 'disconnect':
        if (bot) await bot.logout()
        bots.delete(user.id)
        users.update(user.id, { status: 'logged_out' })
        log('המנהל ניתק את המשתמש מוואטסאפ')
        return { message: 'נותק מוואטסאפ' }
      case 'delete':
        if (bot) await bot.logout()
        bots.delete(user.id)
        users.remove(user.id)
        return { message: 'המשתמש נמחק' }
      case 'recreateControl':
        await live().createControlGroup('צוות אל-מחיק יצר לך קבוצה ראשית חדשה.')
        return { message: 'נוצרה קבוצה ראשית חדשה' }
      case 'relock':
        for (const b of backups.list(user.id)) await live().lockGroup(b.backup_jid)
        log('המנהל נעל מחדש את קבוצות הגיבוי')
        return { message: 'ההרשאות עודכנו בכל הקבוצות' }
      case 'pause':
      case 'resume':
        users.update(user.id, { settings: { ...user.settings, paused: action === 'pause' } })
        log(action === 'pause' ? 'המנהל השהה את הגיבוי' : 'המנהל חידש את הגיבוי')
        return { message: action === 'pause' ? 'הגיבוי הושהה' : 'הגיבוי חודש' }
      case 'resetSettings':
        users.update(user.id, { settings: { ...mergeSettings(), groupsLocked: user.settings.groupsLocked } })
        log('המנהל איפס את ההגדרות')
        return { message: 'ההגדרות אופסו' }
      case 'diagnoseLists':
        return { diagnosis: await live().diagnoseLists() }
      case 'loginAs':
        log('המנהל נכנס לממשק של המשתמש')
        return { token: sessions.create(user.id, 'user', 1) }
      default:
        fail('פעולה לא מוכרת.')
    }
  },

  /**
   * Customer service: reconnect a user whose WhatsApp got unlinked, keeping the same account.
   * Returns an 8-character pairing code for the admin to send to the user.
   */
  async adminRelink ({ token, userId }) {
    requireAdmin(token)
    const user = users.get(userId) || fail('משתמש לא נמצא.')
    const prev = relinks.get(user.id)
    if (prev?.joinId && ['starting', 'code'].includes(prev.status)) cancelJoin(prev.joinId)
    const joinId = `relink-${user.id}-${Date.now()}`
    const state = { status: 'starting', joinId, at: Date.now() }
    relinks.set(user.id, state)
    events.add(user.id, 'admin', 'המנהל יצר קוד לחיבור מחדש')
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 25000)
      startJoin(joinId, { method: 'code', phone: user.phone, relink: true }, fields => {
        Object.assign(state, fields)
        if (fields.status === 'connected') events.add(user.id, 'joined', 'חובר מחדש בעזרת קוד מהמנהל')
        if (['code', 'error', 'connected'].includes(fields.status)) { clearTimeout(timer); resolve() }
      })
    })
    if (state.status === 'error') fail(state.error)
    if (state.status !== 'code') fail('לא הצלחתי לקבל קוד מוואטסאפ. נסו שוב.')
    return { code: state.code, phone: user.phone }
  },

  adminRelinkStatus ({ token, userId }) {
    requireAdmin(token)
    const s = relinks.get(String(userId))
    return s ? { status: s.status, code: s.code || null, error: s.error || null } : { status: 'none' }
  },

  async adminBackupAction ({ token, userId, backupId, action }) {
    requireAdmin(token)
    const b = backups.get(String(userId), Number(backupId)) || fail('הגיבוי לא נמצא.')
    if (action === 'remove') {
      backups.remove(b.user_id, b.id)
      links.removeForBackup(b.user_id, b.id)
    } else {
      backups.setActive(b.user_id, b.id, action === 'resume')
    }
    events.add(b.user_id, 'admin', `המנהל ${action === 'remove' ? 'הסיר' : action === 'resume' ? 'חידש' : 'השהה'} את הגיבוי של ${b.source_name}`)
    return {}
  },

  async adminSaveNote ({ token, userId, note }) {
    requireAdmin(token)
    users.update(String(userId), { admin_note: String(note || '').slice(0, 2000) })
    return {}
  },

  async adminMessage ({ token, userId, text }) {
    requireAdmin(token)
    const msg = String(text || '').trim().slice(0, 2000) || fail('כתבו הודעה.')
    const targets = userId ? [bots.get(String(userId))] : [...bots.values()]
    let sent = 0
    for (const bot of targets) {
      if (bot?.status !== 'open') continue
      try {
        await bot.sendControl(`📣 *הודעה מצוות ${BOT_NAME}*\n\n${msg}`)
        sent++
        events.add(bot.userId, 'admin', `הודעה מהמנהל: ${msg.slice(0, 80)}`)
      } catch {}
    }
    if (!sent) fail(userId ? 'הוואטסאפ של המשתמש לא מחובר כרגע.' : 'אין משתמשים מחוברים כרגע.')
    return { sent }
  }
}
