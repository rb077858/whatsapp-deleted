import { users, backups, sessions, loginCodes, kvGet, kvSet, normalizePhone, randomCode, sha, checkPassword, hashPassword } from './db.js'
import { bots, startBot, stopBot, registrationError } from './manager.js'
import { mergeSettings, BOT_NAME, TYPE_LABELS } from './config.js'
import * as T from './text.js'

export class ApiError extends Error {}
const inviteFailures = []
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

export function publicStatus () {
  const mode = kvGet('regMode')
  return {
    botName: BOT_NAME,
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
    return { user: publicUser(user), backups: backups.list(user.id).map(b => ({ id: b.id, name: b.source_name, kind: b.kind, active: !!b.active, count: b.count, createdAt: b.created_at })) }
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
    return {}
  },

  async saveSettings ({ token, settings }) {
    const user = requireUser(token)
    const s = mergeSettings(user.settings)
    const inc = settings || {}
    for (const k of Object.keys(s.types)) if (typeof inc.types?.[k] === 'boolean') s.types[k] = inc.types[k]
    for (const k of ['alertDeleted', 'alertEdited', 'muteBackups', 'includeOwn', 'paused']) if (typeof inc[k] === 'boolean') s[k] = inc[k]
    if (Number.isFinite(inc.maxMediaMB)) s.maxMediaMB = Math.max(1, Math.min(100, Math.round(inc.maxMediaMB)))
    users.update(user.id, { settings: s })
    return { settings: s }
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
      return { id: u.id, phone: u.phone, name: u.name, status: u.status === 'logged_out' ? 'logged_out' : (bots.get(u.id)?.status || 'stopped'), backups: b.length, messages: b.reduce((a, x) => a + x.count, 0), createdAt: u.created_at, lastSeen: u.last_seen }
    })
    const mem = process.memoryUsage()
    return {
      users: list,
      settings: { regMode: kvGet('regMode'), regLimit: kvGet('regLimit'), inviteCode: kvGet('inviteCode'), adminUser: kvGet('adminUser') },
      totals: backups.totals(),
      server: { uptime: Math.round(process.uptime()), rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576), node: process.version }
    }
  },

  async adminSaveSettings ({ token, settings }) {
    requireAdmin(token)
    const s = settings || {}
    if (['open', 'limit', 'invite', 'closed'].includes(s.regMode)) kvSet('regMode', s.regMode)
    if (Number.isFinite(s.regLimit)) kvSet('regLimit', Math.max(0, Math.round(s.regLimit)))
    if (typeof s.inviteCode === 'string' && s.inviteCode.trim()) kvSet('inviteCode', s.inviteCode.trim().slice(0, 40))
    if (typeof s.adminUser === 'string' && s.adminUser.trim()) kvSet('adminUser', s.adminUser.trim())
    if (typeof s.newPassword === 'string' && s.newPassword) {
      if (s.newPassword.length < 6) fail('הסיסמה צריכה להיות לפחות 6 תווים.')
      kvSet('adminPass', hashPassword(s.newPassword))
    }
    return {}
  },

  async adminUserAction ({ token, userId, action }) {
    requireAdmin(token)
    const user = users.get(userId)
    if (!user) fail('משתמש לא נמצא.')
    if (action === 'restart') { await stopBot(user.id); if (user.status !== 'logged_out') startBot(user.id) }
    if (action === 'disconnect') { const b = bots.get(user.id); if (b) await b.logout(); bots.delete(user.id); users.update(user.id, { status: 'logged_out' }) }
    if (action === 'delete') { const b = bots.get(user.id); if (b) await b.logout(); bots.delete(user.id); users.remove(user.id) }
    return {}
  }
}
