import { backups, users } from './db.js'
import { decideRequest } from './sharing.js'
import * as T from './text.js'

const clean = s => String(s || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}*_~]/gu, '').trim()
const is = (t, ...words) => words.includes(t)

/** Parses "1", "1,3", "1 3", "2-4", "הכל" into zero-based indexes. */
function parseNumbers (t, max) {
  if (is(t, 'הכל', 'כולם', 'all')) return [...Array(max).keys()]
  if (!/^[\d\s,.\-]+$/.test(t)) return null
  const out = new Set()
  for (const part of t.split(/[\s,.]+/).filter(Boolean)) {
    const [a, b] = part.split('-').map(Number)
    for (let i = a; i <= (b || a); i++) if (i >= 1 && i <= max) out.add(i - 1)
  }
  return out.size ? [...out] : null
}

/** The conversation inside the bot's control group. */
export class Commands {
  constructor (bot) {
    this.bot = bot
    this.state = null
  }

  reply (text) { return this.bot.sendControl(text) }

  setState (s) { this.state = s ? { ...s, expires: Date.now() + 10 * 60000 } : null }

  async handle (msg) {
    const raw = msg.message?.conversation || msg.message?.extendedTextMessage?.text
    if (!raw) return
    const t = clean(raw)
    if (!t) return
    if (this.state && this.state.expires < Date.now()) this.state = null

    if (is(t, 'ביטול', 'בטל', 'cancel')) {
      this.setState(null)
      return this.reply('👌 בוטל.')
    }
    if (is(t, 'תפריט', 'עזרה', 'help', 'menu', '?')) { this.setState(null); return this.reply(T.menu()) }
    if (is(t, 'רשימה', 'מגובים', 'list')) { this.setState(null); return this.reply(T.backupList(backups.list(this.bot.userId))) }
    if (is(t, 'הגדרות', 'settings')) {
      this.setState({ mode: 'settings' })
      return this.reply(T.settingsText(this.bot.user.settings))
    }
    if (is(t, 'ממשק', 'אתר', 'קישור', 'site')) return this.reply(T.siteLink())
    if (is(t, 'השהה', 'עצור', 'pause')) return this.setPaused(true)
    if (is(t, 'המשך', 'pause off', 'resume')) return this.setPaused(false)

    const dec = t.match(/^(אשר|אישור|דחה|דחייה)\s+(\d+)$/)
    if (dec) return this.decide(Number(dec[2]), dec[1].startsWith('א'))

    const rm = t.match(/^(הסר|מחק|הפסק)\s+(.+)$/)
    if (rm) return this.remove(rm[2])

    const st = this.state
    if (st?.mode === 'settings') {
      if (is(t, 'סיום', 'סיימתי', 'done')) { this.setState(null); return this.reply('💾 ההגדרות נשמרו.') }
      const s = this.bot.user.settings
      const items = T.settingsItems(s)
      const nums = parseNumbers(t, items.length)
      if (nums) {
        nums.forEach(i => items[i].toggle())
        users.update(this.bot.userId, { settings: s })
        this.setState({ mode: 'settings' })
        return this.reply(T.settingsText(s))
      }
    }
    if (st?.mode === 'pick') {
      const nums = parseNumbers(t, st.results.length)
      if (nums) {
        const picks = nums.map(i => st.results[i]).filter(r => !r.backedUp)
        if (!picks.length) return this.reply('✅ מה שבחרתם כבר מגובה. אפשר לחפש משהו אחר.')
        this.setState({ mode: 'confirm', picks })
        return this.reply(T.confirmPicks(picks))
      }
    }
    if (st?.mode === 'confirm') {
      if (is(t, 'כן', 'אישור', 'מאשר', 'מאשרת', 'yes', 'ok', 'אוקי')) {
        this.setState(null)
        return this.createAll(st.picks)
      }
      if (is(t, 'לא', 'no')) { this.setState(null); return this.reply('👌 בוטל.') }
    }

    // anything else is a search
    if (t.length < 2) return this.reply('🔎 כתבו לפחות 2 אותיות לחיפוש, או *תפריט*.')
    const results = await this.bot.search(t)
    this.setState(results.length ? { mode: 'pick', results } : null)
    return this.reply(T.searchResults(t, results))
  }

  async createAll (picks) {
    await this.reply(`⏳ יוצר ${picks.length === 1 ? 'קבוצת גיבוי' : picks.length + ' קבוצות גיבוי'}...`)
    const done = []
    for (const p of picks) {
      try {
        await this.bot.createBackup(p)
        done.push(`✅ ${p.name}`)
      } catch (e) {
        this.bot.log('create backup failed', e.message)
        done.push(`❌ ${p.name} – לא הצלחתי ליצור קבוצה (${e.message})`)
      }
    }
    return this.reply(`${done.join('\n')}\n\nמעכשיו כל הודעה חדשה תועתק לקבוצת ה*(הודעות)* המתאימה. 🧽`)
  }

  async remove (arg) {
    const list = backups.list(this.bot.userId)
    const nums = parseNumbers(clean(arg), list.length)
    if (!nums) return this.reply('כדי להסיר, שלחו *הסר* ומספר מתוך *רשימה*, למשל *הסר 1*.')
    for (const i of nums) backups.remove(this.bot.userId, list[i].id)
    return this.reply(`➖ הגיבוי הופסק עבור: ${nums.map(i => list[i].source_name).join(', ')}\n_קבוצת ה(הודעות) נשארת אצלכם עם כל מה שנשמר בה._`)
  }

  async decide (id, approve) {
    try {
      const { status, request } = await decideRequest(this.bot.userId, id, approve)
      const who = request.name || request.phone
      if (!approve) return this.reply(`🚫 הבקשה של ${who} נדחתה.`)
      return this.reply(status === 'invited' ? `📩 ${who} קיבל/ה הזמנה אישית לקבוצה (הפרטיות שלו/ה לא מאפשרת צירוף ישיר).` : status === 'already' ? `👌 ${who} כבר בקבוצה.` : `✅ ${who} צורף/ה לקבוצה.`)
    } catch (e) {
      return this.reply(`⚠️ ${e.message}`)
    }
  }

  setPaused (paused) {
    const s = this.bot.user.settings
    s.paused = paused
    users.update(this.bot.userId, { settings: s })
    return this.reply(paused ? '⏸️ הגיבוי הושהה. שלחו *המשך* כדי לחדש.' : '▶️ הגיבוי חזר לפעול!')
  }
}
