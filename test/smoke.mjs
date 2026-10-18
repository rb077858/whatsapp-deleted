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
    onWhatsApp: async jid => [{ exists: true, jid }],
    groupParticipantsUpdate: async () => [{ status: '200' }],
    signalRepository: { lidMapping: { getLIDForPN: async () => null } }
  }
}

const u = users.create('972501234567')
users.update(u.id, { control_jid: 'ctrl@g.us', name: 'רועי' })
const bot = new Bot(u.id)
bot.status = 'open'
bot.sock = fakeSocket()
bots.set(u.id, bot)
contacts.upsert(u.id, { jid: '972521111111@s.whatsapp.net', name: 'אמא כהן' })

const settle = async () => { await bot.queue; await new Promise(r => setTimeout(r, 30)) }
const say = async text => {
  await bot.onMessages({ type: 'notify', messages: [{ key: { remoteJid: 'ctrl@g.us', fromMe: true, id: 'U' + (++n) }, message: { conversation: text } }] })
  await settle()
  return sent.at(-1).content.text
}
const groupMsg = (id, message, key = {}) => ({ key: { remoteJid: 'fam@g.us', participant: '972533333333@s.whatsapp.net', id, ...key }, pushName: 'דני', message })
const incoming = async (...msgs) => { await bot.onMessages({ type: 'notify', messages: msgs }); await settle() }

// commands: search → pick → confirm creates backup groups
assert.match(await say('כהן'), /משפחה כהן/)
assert.match(await say('1,2'), /לגבות את/)
assert.match(await say('כן'), /✅ משפחה כהן/)
const fam = backups.bySource(u.id, 'fam@g.us')
assert.ok(fam, 'backup group created')
assert.match(await say('הגדרות'), /הגדרות/)
assert.match(await say('סיום'), /נשמרו/)

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
const token = sessions.create(u.id)
assert.deepEqual(await handlers.addMember({ token, id: fam.id, phone: '0521231234' }), { status: 'added' })
const link = (await handlers.createLink({ token, id: fam.id, options: { maxUses: 1 } })).link
assert.deepEqual(await handlers.linkJoin({ link: link.id, phone: '0521231235' }), { status: 'added' })
await assert.rejects(handlers.linkJoin({ link: link.id, phone: '0521231236' }), /מלאה/)

console.log('✔ smoke test passed')
process.exit(0)
