// Smoke test with a fake WhatsApp socket: the backup flow, the bot-group commands,
// media limits and sharing. Run with `npm test` before every publish.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'al-mahik-test-'))
const { users, backups, contacts, sessions } = await import('../src/db.js')
const { Bot } = await import('../src/bot.js')
const { bots } = await import('../src/manager.js')
const { handlers } = await import('../src/api.js')

const { proto } = await import('baileys')

let n = 0
const sent = []
const left = []
function fakeSocket () {
  return {
    sendMessage: async (jid, content, opts) => { const id = 'B' + (++n); sent.push({ id, jid, content, quoted: opts?.quoted?.key?.id }); return { key: { id, remoteJid: jid, fromMe: true } } },
    relayMessage: async (jid, m) => { sent.push({ jid, content: { relay: Object.keys(m.toJSON())[0] } }) },
    groupFetchAllParticipating: async () => ({ 'fam@g.us': { id: 'fam@g.us', subject: 'משפחה כהן', participants: [1, 2] } }),
    groupCreate: async subject => ({ id: 'new' + (++n) + '@g.us', subject }),
    groupMetadata: async id => ({ id, participants: [] }),
    groupUpdateDescription: async () => {},
    groupSettingUpdate: async () => {},
    groupMemberAddMode: async () => {},
    groupLeave: async jid => { left.push(jid) },
    onWhatsApp: async jid => [{ exists: true, jid }],
    groupParticipantsUpdate: async () => [{ status: '200' }],
    signalRepository: { lidMapping: { getLIDForPN: async () => null } }
  }
}

const u = users.create('972501234567')
users.update(u.id, { name: 'רועי' })
const bot = new Bot(u.id)
bot.status = 'open'
bot.sock = fakeSocket()
bots.set(u.id, bot)
contacts.upsert(u.id, { jid: '972521111111@s.whatsapp.net', name: 'אמא כהן' })

const settle = async () => { await bot.queue; await new Promise(r => setTimeout(r, 30)) }
const groupMsg = (id, message, key = {}) => ({ key: { remoteJid: 'fam@g.us', participant: '972533333333@s.whatsapp.net', id, ...key }, pushName: 'דני', message })
const incoming = async (...msgs) => { await bot.onMessages({ type: 'notify', messages: msgs }); await settle() }

const token = sessions.create(u.id)

// the dashboard flow: search, then create backup groups
const found = (await handlers.searchChats({ token, query: 'כהן' })).results
assert.deepEqual(found.map(r => r.name).sort(), ['אמא כהן', 'משפחה כהן'])
const added = await handlers.addBackups({ token, chats: found.map(r => ({ jid: r.jid, name: r.name })) })
assert.ok(added.results.every(r => r.ok))
const fam = backups.bySource(u.id, 'fam@g.us')
assert.ok(fam, 'backup group created')

// the updates group: created locked, with a welcome that warns not to write there
const updatesJid = await bot.ensureUpdatesGroup()
await settle()
assert.equal(users.get(u.id).updates_jid, updatesJid)
assert.match(sent.at(-1).content.text, /אסור לכתוב/)
assert.ok(!(await bot.search('עדכונים')).some(r => r.jid === updatesJid), 'updates group is never offered for backup')

// login code goes to the updates group
await handlers.loginStart({ phone: '050-1234567' })
await settle()
assert.equal(sent.at(-1).jid, updatesJid)
assert.match(sent.at(-1).content.text, /קוד כניסה/)

// backup: text, quote, edit and delete alerts, own messages, location
const inBackup = () => sent.filter(s => s.jid === fam.backup_jid)
const before = inBackup().length
await incoming(groupMsg('M1', { conversation: 'אני לא יכול השבוע' }))
await incoming(groupMsg('M2', { extendedTextMessage: { text: 'סתם', contextInfo: { stanzaId: 'M1', quotedMessage: { conversation: 'אני לא יכול השבוע' } } } }))
await incoming(groupMsg('M3', { editedMessage: { message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT, key: { id: 'M2' }, editedMessage: { conversation: 'בעצם כן' } } } } }))
await incoming(groupMsg('M4', { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: { id: 'M1' } } }))
await incoming(groupMsg('M5', { conversation: 'שלי' }, { fromMe: true, participant: undefined }))
await incoming(groupMsg('M6', { locationMessage: { degreesLatitude: 32, degreesLongitude: 34, name: 'בית' } }))
const texts = inBackup().slice(before).map(s => s.content.text || Object.keys(s.content)[0])
assert.equal(texts[0], '*דני*\nאני לא יכול השבוע')
assert.equal(inBackup()[before + 1].quoted, inBackup()[before].id, 'reply quotes the backed-up original')
assert.equal(inBackup()[before + 2].quoted, inBackup()[before + 1].id, 'edit alert replies to the edited message')
assert.equal(inBackup()[before + 3].quoted, inBackup()[before].id, 'delete alert replies to the deleted message')
assert.match(texts[2], /ערך\/ה את ההודעה הזו ל:\nבעצם כן/)
assert.match(texts[3], /מחק\/ה את ההודעה הזו/)
assert.equal(texts[4], '*רועי (אני)*\nשלי')
assert.ok(texts.includes('location'))
assert.equal(backups.get(u.id, fam.id).count, 4, 'four messages counted (text, quote, own, location)')

// media: size cap leaves a note instead of the file
await incoming(groupMsg('BIG', { imageMessage: { fileLength: 40 * 1048576, mimetype: 'image/jpeg' } }))
assert.match(inBackup().at(-1).content.text, /הקובץ לא גובה/)

// messages typed in the backup group itself are never copied
const count = sent.length
await incoming({ key: { remoteJid: fam.backup_jid, fromMe: true, id: 'X1' }, message: { conversation: 'הערה שלי' } })
assert.equal(sent.length, count)

// sharing: add by phone and a join link
assert.deepEqual(await handlers.addMember({ token, id: fam.id, phone: '0521231234' }), { status: 'added' })
const link = (await handlers.createLink({ token, id: fam.id, options: { maxUses: 1 } })).link
assert.deepEqual(await handlers.linkJoin({ link: link.id, phone: '0521231235' }), { status: 'added' })
await assert.rejects(handlers.linkJoin({ link: link.id, phone: '0521231236' }), /מלאה/)

// join request: posted in the updates group with approve/reject links
const approvalLink = (await handlers.createLink({ token, id: fam.id, options: { approval: true } })).link
assert.deepEqual(await handlers.linkJoin({ link: approvalLink.id, phone: '0507777777', name: 'דנה' }), { status: 'pending' })
await settle()
const reqMsg = sent.at(-1)
assert.equal(reqMsg.jid, updatesJid)
assert.match(reqMsg.content.text, /דנה/)
const reqId = Number(reqMsg.content.text.match(/req=(\d+)&act=approve/)[1])
assert.deepEqual(await handlers.decideRequest({ token, requestId: reqId, approve: true }), { status: 'added' })

// team message from the admin goes to the updates group
const admin = sessions.create('admin', 'admin')
assert.deepEqual(await handlers.adminMessage({ token: admin, userId: u.id, text: 'שלום מהצוות' }), { sent: 1 })
assert.equal(sent.at(-1).jid, updatesJid)
assert.match(sent.at(-1).content.text, /שלום מהצוות/)

// a reaction in the updates group is fine; writing there blocks the account
await incoming({ key: { remoteJid: updatesJid, fromMe: true, id: 'R1' }, message: { reactionMessage: { text: '👍', key: { id: 'B1' } } } })
assert.equal(users.get(u.id).status, 'active')
await incoming({ key: { remoteJid: updatesJid, fromMe: true, id: 'W1' }, message: { conversation: 'שלום?' } })
assert.equal(users.get(u.id).status, 'blocked')
assert.match(sent.at(-1).content.text, /החשבון נחסם/)
assert.deepEqual(left, [updatesJid], 'the bot leaves the updates group, which stays in the chat list')
assert.equal(bot.status, 'blocked')
await assert.rejects(handlers.loginStart({ phone: '050-1234567' }), /חסום/)

// unblock: a new updates group, with a note that the old one can be deleted
await handlers.adminUserAction({ token: admin, userId: u.id, action: 'unblock' })
assert.equal(users.get(u.id).status, 'active')
assert.equal(users.get(u.id).updates_jid, null)
bots.get(u.id)?.stop()
const bot2 = new Bot(u.id)
bot2.status = 'open'
bot2.sock = fakeSocket()
const newUpdates = await bot2.ensureUpdatesGroup()
await bot2.queue
assert.notEqual(newUpdates, updatesJid)
assert.match(sent.at(-1).content.text, /החסימה בוטלה/)
assert.equal(users.get(u.id).settings.unblocked, false)

console.log('✔ smoke test passed')
process.exit(0)
