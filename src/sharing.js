// Sharing a backup group: adding people by phone, join links with rules, and approval requests.
import { links, joinRequests, backups, contacts, users, normalizePhone, events } from './db.js'
import { bots, notify } from './manager.js'

export class ShareError extends Error {}
const fail = msg => { throw new ShareError(msg) }

const fmtPhone = p => (p.startsWith('972') ? '0' + p.slice(3) : '+' + p)

/** Why a link can't be used right now, or null. */
export function linkProblem (link) {
  if (!link || !link.active) return 'הקישור הזה כבר לא פעיל.'
  if (link.expires && link.expires < Date.now()) return 'תוקף הקישור הזה פג.'
  if (link.max_uses && link.uses >= link.max_uses) return 'הקבוצה הזו כבר מלאה דרך הקישור הזה.'
  const b = backups.get(link.user_id, link.backup_id)
  if (!b) return 'קבוצת הגיבוי כבר לא קיימת.'
  return null
}

export function publicLinkInfo (id) {
  const link = links.get(String(id || ''))
  const b = link && backups.get(link.user_id, link.backup_id)
  const owner = link && users.get(link.user_id)
  if (!link || !b) return { ok: false, error: 'הקישור לא נמצא.' }
  const problem = linkProblem(link)
  return {
    ok: !problem,
    error: problem,
    groupName: `${b.source_name} (הודעות)`,
    kind: b.kind,
    owner: owner?.name || null,
    approval: !!link.approval,
    restricted: link.who !== 'anyone',
    left: link.max_uses ? Math.max(0, link.max_uses - link.uses) : null
  }
}

function allowed (link, phone) {
  if (link.who === 'list') return String(link.allowed || '').split(',').includes(phone)
  if (link.who === 'contacts') return !!contacts.get(link.user_id, phone + '@s.whatsapp.net')?.name
  return true
}

async function addNow (link, phone) {
  const bot = bots.get(link.user_id)
  if (!bot || bot.status !== 'open') fail('בעל הקבוצה לא מחובר כרגע. נסו שוב מאוחר יותר.')
  const b = backups.get(link.user_id, link.backup_id)
  const result = await bot.addToGroup(b, phone).catch(e => fail(e.message))
  if (result !== 'already') links.use(link.id)
  return result
}

/** A visitor entered their phone on a join link page. */
export async function joinByLink (id, phoneInput, name) {
  const link = links.get(String(id || ''))
  const problem = linkProblem(link)
  if (problem) fail(problem)
  const phone = normalizePhone(phoneInput)
  if (!phone) fail('מספר הטלפון לא תקין.')
  if (!allowed(link, phone)) fail('המספר הזה לא מורשה להצטרף דרך הקישור הזה.')
  if (link.approval) {
    if (joinRequests.pendingFor(link.id, phone)) return { status: 'pending' }
    const req = joinRequests.add({ link_id: link.id, user_id: link.user_id, backup_id: link.backup_id, phone, name: String(name || '').trim().slice(0, 60) })
    const b = backups.get(link.user_id, link.backup_id)
    const site = process.env.SITE_URL || ''
    notify(link.user_id, 'notifyRequests', `🙋 *בקשת הצטרפות*
${req.name || fmtPhone(phone)}${req.name ? ` (${fmtPhone(phone)})` : ''} מבקש/ת להצטרף ל*${b.source_name} (הודעות)*${link.label ? ` דרך הקישור "${link.label}"` : ''}.

✅ לאישור:
${site}/app?req=${req.id}&act=approve

🚫 לדחייה:
${site}/app?req=${req.id}&act=reject`)
    return { status: 'pending' }
  }
  const status = await addNow(link, phone)
  events.add(link.user_id, 'link', `${fmtPhone(phone)} הצטרף דרך קישור (${status})`)
  if (status !== 'already') {
    const b = backups.get(link.user_id, link.backup_id)
    notify(link.user_id, 'notifyJoins', `🔗 ${fmtPhone(phone)} ${status === 'invited' ? 'קיבל/ה הזמנה ל' : 'הצטרף/ה ל'}*${b.source_name} (הודעות)* דרך ${link.label ? `הקישור "${link.label}"` : 'קישור'}.`)
  }
  return { status }
}

/** The owner approves or rejects a pending request (from the website or the bot group). */
export async function decideRequest (userId, requestId, approve) {
  const req = joinRequests.get(userId, Number(requestId))
  if (!req || req.status !== 'pending') fail('הבקשה לא נמצאה או שכבר טופלה.')
  if (!approve) {
    joinRequests.setStatus(userId, req.id, 'rejected')
    return { status: 'rejected', request: req }
  }
  const link = links.get(req.link_id)
  const b = backups.get(userId, req.backup_id)
  if (!b) fail('קבוצת הגיבוי כבר לא קיימת.')
  if (link?.max_uses && link.uses >= link.max_uses) fail('הקישור כבר הגיע למספר המצטרפים המקסימלי.')
  const bot = bots.get(userId)
  if (!bot || bot.status !== 'open') fail('הוואטסאפ לא מחובר כרגע.')
  const result = await bot.addToGroup(b, req.phone).catch(e => fail(e.message))
  if (link && result !== 'already') links.use(link.id)
  joinRequests.setStatus(userId, req.id, 'approved')
  return { status: result, request: req }
}

export function linkView (l) {
  return {
    id: l.id,
    label: l.label,
    maxUses: l.max_uses,
    uses: l.uses,
    expires: l.expires,
    who: l.who,
    allowed: l.allowed ? l.allowed.split(',') : [],
    approval: !!l.approval,
    active: !!l.active,
    problem: linkProblem(l),
    createdAt: l.created_at
  }
}

/** Validates link options coming from the dashboard. */
export function linkFields (o = {}) {
  const f = {}
  if (o.label !== undefined) f.label = String(o.label || '').trim().slice(0, 40) || null
  if (o.maxUses !== undefined) f.max_uses = Math.max(0, Math.min(1024, Math.round(Number(o.maxUses) || 0)))
  if (o.expiresDays !== undefined) f.expires = Number(o.expiresDays) > 0 ? Date.now() + Math.min(365, Number(o.expiresDays)) * 86400000 : null
  if (o.who !== undefined) f.who = ['anyone', 'contacts', 'list'].includes(o.who) ? o.who : 'anyone'
  if (o.allowed !== undefined) {
    const list = (Array.isArray(o.allowed) ? o.allowed : String(o.allowed).split(/[\s,;]+/)).map(normalizePhone).filter(Boolean)
    f.allowed = [...new Set(list)].slice(0, 500).join(',') || null
  }
  if (o.approval !== undefined) f.approval = o.approval ? 1 : 0
  if (o.active !== undefined) f.active = o.active ? 1 : 0
  if (f.who === 'list' && o.allowed !== undefined && !f.allowed) fail('הוסיפו לפחות מספר טלפון אחד לרשימה.')
  return f
}
