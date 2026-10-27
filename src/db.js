import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { DATA_DIR, mergeSettings } from './config.js'

export const db = new DatabaseSync(path.join(DATA_DIR, 'bot.db'))
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 3000')

db.exec(`
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  jid TEXT, lid TEXT, name TEXT,
  control_jid TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  settings TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  source_jid TEXT NOT NULL,
  source_alt TEXT,
  source_name TEXT,
  kind TEXT NOT NULL,
  backup_jid TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, source_jid)
);
CREATE TABLE IF NOT EXISTS msgmap (
  user_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  backup_jid TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  sender TEXT,
  preview TEXT,
  ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, source_id)
);
CREATE INDEX IF NOT EXISTS msgmap_ts ON msgmap (ts);
CREATE TABLE IF NOT EXISTS contacts (
  user_id TEXT NOT NULL,
  jid TEXT NOT NULL,
  name TEXT, notify TEXT, alt TEXT,
  PRIMARY KEY (user_id, jid)
);
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  backup_id INTEGER NOT NULL,
  label TEXT,
  max_uses INTEGER NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  expires INTEGER,
  who TEXT NOT NULL DEFAULT 'anyone',
  allowed TEXT,
  approval INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS join_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  backup_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS join_requests_user ON join_requests (user_id, status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id TEXT,
  type TEXT NOT NULL,
  text TEXT
);
CREATE INDEX IF NOT EXISTS events_user ON events (user_id, ts);
CREATE TABLE IF NOT EXISTS login_codes (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
`)

// columns added after the first release
for (const sql of ['ALTER TABLE users ADD COLUMN admin_note TEXT', 'ALTER TABLE users ADD COLUMN updates_jid TEXT']) {
  try { db.exec(sql) } catch {}
}

// ---------- helpers ----------
export const now = () => Date.now()
export const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex')
export const randomToken = () => crypto.randomBytes(32).toString('base64url')
export const randomCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0')

export function hashPassword (password) {
  const salt = crypto.randomBytes(16).toString('hex')
  return salt + ':' + crypto.scryptSync(password, salt, 32).toString('hex')
}
export function checkPassword (password, stored) {
  const [salt, hash] = String(stored || '').split(':')
  if (!salt || !hash) return false
  const test = crypto.scryptSync(String(password), salt, 32)
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'))
}

// ---------- kv / admin settings ----------
const ADMIN_DEFAULTS = {
  adminUser: 'rb077858',
  adminPass: '0095a5e4300830c1ef8abea446db79fa:dd9c2f943c9d84f117fedc591dce48f73d807a50c94b576beb0d485fa62c1550',
  regMode: 'invite', // open | limit | invite | closed
  regLimit: 20,
  inviteCode: '123456',
  maxMediaMB: 16, // cap for every user's media size
  mediaPerMinute: 10 // media backups per user per minute
}

export function kvGet (key) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
  if (row) return JSON.parse(row.value)
  return ADMIN_DEFAULTS[key]
}
export function kvSet (key, value) {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
}

// ---------- users ----------
function rowToUser (r) {
  if (!r) return null
  return { ...r, settings: mergeSettings(r.settings ? JSON.parse(r.settings) : null) }
}
export const users = {
  get: id => rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)),
  byPhone: phone => rowToUser(db.prepare('SELECT * FROM users WHERE phone = ?').get(phone)),
  all: () => db.prepare('SELECT * FROM users ORDER BY created_at').all().map(rowToUser),
  count: () => db.prepare("SELECT COUNT(*) AS n FROM users WHERE status != 'deleted'").get().n,
  create (phone) {
    const id = crypto.randomBytes(6).toString('hex')
    db.prepare('INSERT INTO users (id, phone, created_at, settings) VALUES (?, ?, ?, ?)').run(id, phone, now(), JSON.stringify(mergeSettings()))
    return users.get(id)
  },
  update (id, fields) {
    const keys = Object.keys(fields)
    if (!keys.length) return
    const vals = keys.map(k => k === 'settings' ? JSON.stringify(fields[k]) : fields[k])
    db.prepare(`UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id)
  },
  remove (id) {
    for (const t of ['backups', 'msgmap', 'contacts', 'web_sessions', 'links', 'join_requests']) db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id)
    db.prepare('DELETE FROM users WHERE id = ?').run(id)
  }
}

// ---------- backups ----------
export const backups = {
  list: userId => db.prepare('SELECT * FROM backups WHERE user_id = ? ORDER BY created_at').all(userId),
  get: (userId, id) => db.prepare('SELECT * FROM backups WHERE user_id = ? AND id = ?').get(userId, id),
  bySource: (userId, jid) => db.prepare('SELECT * FROM backups WHERE user_id = ? AND (source_jid = ? OR source_alt = ?)').get(userId, jid, jid),
  byBackupJid: (userId, jid) => db.prepare('SELECT * FROM backups WHERE user_id = ? AND backup_jid = ?').get(userId, jid),
  add (userId, b) {
    db.prepare(`INSERT INTO backups (user_id, source_jid, source_alt, source_name, kind, backup_jid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, source_jid) DO UPDATE SET backup_jid = excluded.backup_jid, source_name = excluded.source_name, active = 1`)
      .run(userId, b.source_jid, b.source_alt || null, b.source_name, b.kind, b.backup_jid, now())
    return backups.bySource(userId, b.source_jid)
  },
  setActive: (userId, id, active) => db.prepare('UPDATE backups SET active = ? WHERE user_id = ? AND id = ?').run(active ? 1 : 0, userId, id),
  remove: (userId, id) => db.prepare('DELETE FROM backups WHERE user_id = ? AND id = ?').run(userId, id),
  bump: id => db.prepare('UPDATE backups SET count = count + 1 WHERE id = ?').run(id),
  totals: () => db.prepare('SELECT COUNT(*) AS chats, COALESCE(SUM(count), 0) AS messages FROM backups').get()
}

// ---------- join links & requests ----------
const LINK_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const links = {
  create (userId, backupId, l) {
    let id
    do id = Array.from(crypto.randomBytes(10), b => LINK_ALPHABET[b % LINK_ALPHABET.length]).join('')
    while (links.get(id))
    db.prepare(`INSERT INTO links (id, user_id, backup_id, label, max_uses, expires, who, allowed, approval, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, backupId, l.label || null, l.max_uses || 0, l.expires || null, l.who || 'anyone', l.allowed || null, l.approval ? 1 : 0, now())
    return links.get(id)
  },
  get: id => db.prepare('SELECT * FROM links WHERE id = ?').get(id),
  forBackup: (userId, backupId) => db.prepare('SELECT * FROM links WHERE user_id = ? AND backup_id = ? ORDER BY created_at DESC').all(userId, backupId),
  update (userId, id, fields) {
    const keys = Object.keys(fields)
    if (!keys.length) return
    db.prepare(`UPDATE links SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE user_id = ? AND id = ?`).run(...keys.map(k => fields[k]), userId, id)
  },
  use: id => db.prepare('UPDATE links SET uses = uses + 1 WHERE id = ?').run(id),
  remove: (userId, id) => db.prepare('DELETE FROM links WHERE user_id = ? AND id = ?').run(userId, id),
  removeForBackup: (userId, backupId) => db.prepare('DELETE FROM links WHERE user_id = ? AND backup_id = ?').run(userId, backupId)
}

export const joinRequests = {
  add (r) {
    const res = db.prepare('INSERT INTO join_requests (link_id, user_id, backup_id, phone, name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.link_id, r.user_id, r.backup_id, r.phone, r.name || null, now())
    return joinRequests.get(r.user_id, Number(res.lastInsertRowid))
  },
  get: (userId, id) => db.prepare('SELECT * FROM join_requests WHERE user_id = ? AND id = ?').get(userId, id),
  pending: userId => db.prepare("SELECT * FROM join_requests WHERE user_id = ? AND status = 'pending' ORDER BY created_at").all(userId),
  pendingFor: (linkId, phone) => db.prepare("SELECT * FROM join_requests WHERE link_id = ? AND phone = ? AND status = 'pending'").get(linkId, phone),
  setStatus: (userId, id, status) => db.prepare('UPDATE join_requests SET status = ? WHERE user_id = ? AND id = ?').run(status, userId, id)
}

// ---------- event log (for the admin's customer-service view) ----------
export const events = {
  add (userId, type, text) {
    db.prepare('INSERT INTO events (ts, user_id, type, text) VALUES (?, ?, ?, ?)').run(now(), userId || null, type, text || null)
  },
  recent: (limit = 150, userId = null) => userId
    ? db.prepare('SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit)
    : db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit),
  prune: days => db.prepare('DELETE FROM events WHERE ts < ?').run(now() - days * 86400000)
}

// ---------- message map (original -> backup copy), for delete/edit alerts and quotes ----------
export const msgmap = {
  put: (userId, sourceId, m) => db.prepare('INSERT OR REPLACE INTO msgmap (user_id, source_id, backup_jid, backup_id, sender, preview, ts) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, sourceId, m.backup_jid, m.backup_id, m.sender || '', (m.preview || '').slice(0, 200), now()),
  get: (userId, sourceId) => db.prepare('SELECT * FROM msgmap WHERE user_id = ? AND source_id = ?').get(userId, sourceId),
  prune: days => db.prepare('DELETE FROM msgmap WHERE ts < ?').run(now() - days * 86400000)
}

// ---------- contacts ----------
export const contacts = {
  upsert (userId, c) {
    if (!c.jid) return
    db.prepare(`INSERT INTO contacts (user_id, jid, name, notify, alt) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, jid) DO UPDATE SET name = COALESCE(excluded.name, name), notify = COALESCE(excluded.notify, notify), alt = COALESCE(excluded.alt, alt)`)
      .run(userId, c.jid, c.name || null, c.notify || null, c.alt || null)
  },
  get: (userId, jid) => db.prepare('SELECT * FROM contacts WHERE user_id = ? AND (jid = ? OR alt = ?)').get(userId, jid, jid),
  search: (userId, q, limit = 30) => db.prepare(`SELECT * FROM contacts WHERE user_id = ? AND jid LIKE '%@s.whatsapp.net'
      AND (name LIKE ? OR notify LIKE ? OR jid LIKE ?) ORDER BY name IS NULL, name LIMIT ?`)
    .all(userId, `%${q}%`, `%${q}%`, `%${q.replace(/\D/g, '') || '~'}%`, limit)
}

// ---------- web sessions / login codes ----------
export const sessions = {
  create (userId, role = 'user', days = 30) {
    const token = randomToken()
    db.prepare('INSERT INTO web_sessions (token_hash, user_id, role, expires) VALUES (?, ?, ?, ?)').run(sha(token), userId, role, now() + days * 86400000)
    return token
  },
  get (token) {
    if (!token) return null
    const s = db.prepare('SELECT * FROM web_sessions WHERE token_hash = ?').get(sha(token))
    if (!s || s.expires < now()) return null
    return s
  },
  revoke: token => db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(sha(token)),
  revokeRole: role => db.prepare('DELETE FROM web_sessions WHERE role = ?').run(role),
  prune: () => db.prepare('DELETE FROM web_sessions WHERE expires < ?').run(now())
}

export const loginCodes = {
  set: (phone, code) => db.prepare('INSERT OR REPLACE INTO login_codes (phone, code_hash, expires, attempts) VALUES (?, ?, ?, 0)').run(phone, sha(code), now() + 5 * 60000),
  get: phone => db.prepare('SELECT * FROM login_codes WHERE phone = ?').get(phone),
  fail: phone => db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE phone = ?').run(phone),
  clear: phone => db.prepare('DELETE FROM login_codes WHERE phone = ?').run(phone)
}

export function normalizePhone (input) {
  let d = String(input || '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('0')) d = '972' + d.slice(1)
  if (d.length < 9 || d.length > 15) return null
  return d
}
