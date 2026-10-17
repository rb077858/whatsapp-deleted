import { BOT_NAME, TYPE_LABELS } from './config.js'

const on = v => (v ? '✅' : '⬜')

export const welcome = name => `👋 היי${name ? ' ' + name : ''}! ברוכים הבאים ל*${BOT_NAME}*

מעכשיו אני שומר עותק של ההודעות מהקבוצות והצ'אטים שתבחרו, כך ששום הודעה לא תיעלם – גם אם מישהו מחק או ערך אותה. 🕵️

*איך זה עובד?*
1️⃣ כתבו כאן שם של קבוצה או של איש קשר
2️⃣ בחרו מהרשימה ואשרו
3️⃣ אני אפתח קבוצה חדשה עם הסיומת *(הודעות)*, וכל הודעה תועתק אליה עם שם השולח

${menu()}`

export const menu = () => `*📖 תפריט*
🔎 *כתבו שם* – חיפוש קבוצה או איש קשר לגיבוי
📋 *רשימה* – מה מגובה עכשיו
➖ *הסר 2* – הפסקת גיבוי של מספר 2 ברשימה
⚙️ *הגדרות* – מה לגבות ואיך
⏸️ *השהה* / ▶️ *המשך* – עצירת הגיבוי זמנית
💻 *ממשק* – קישור לניהול בממשק הגרפי
❓ *תפריט* – ההודעה הזו`

export const searchResults = (q, results) => {
  if (!results.length) return `🤷 לא מצאתי קבוצה או איש קשר בשם "${q}".\nנסו מילה אחרת, חלק מהשם, או מספר טלפון.`
  const lines = results.map((r, i) => `*${i + 1}.* ${r.kind === 'group' ? '👥' : '👤'} ${r.name}${r.backedUp ? '  ✅ _כבר מגובה_' : ''}`)
  return `🔎 מצאתי ${results.length === 1 ? 'תוצאה אחת' : results.length + ' תוצאות'} ל"${q}":\n\n${lines.join('\n')}\n\nשלחו את המספר לבחירה (אפשר כמה, למשל *1,3*), או *ביטול*.`
}

export const confirmPicks = picks => `👇 לגבות את:\n\n${picks.map(p => `• ${p.kind === 'group' ? '👥' : '👤'} *${p.name}*\n   ← קבוצה חדשה: _${p.name} (הודעות)_`).join('\n')}\n\nשלחו *כן* לאישור או *ביטול*.`

export const backupList = list => {
  if (!list.length) return '📭 עוד לא בחרתם מה לגבות.\nכתבו כאן שם של קבוצה או איש קשר כדי להתחיל.'
  const lines = list.map((b, i) => `*${i + 1}.* ${b.kind === 'group' ? '👥' : '👤'} ${b.source_name}${b.active ? '' : '  ⏸️ _מושהה_'}  ·  ${b.count} הודעות`)
  return `📋 *מה מגובה עכשיו:*\n\n${lines.join('\n')}\n\nלהפסקת גיבוי: *הסר* ומספר (למשל *הסר 1*).`
}

export const settingsItems = s => [
  ...Object.keys(TYPE_LABELS).map(k => ({ label: TYPE_LABELS[k], get: () => s.types[k], toggle: () => { s.types[k] = !s.types[k] } })),
  { label: 'התראה כשמישהו מוחק הודעה', get: () => s.alertDeleted, toggle: () => { s.alertDeleted = !s.alertDeleted } },
  { label: 'התראה כשמישהו עורך הודעה', get: () => s.alertEdited, toggle: () => { s.alertEdited = !s.alertEdited } },
  { label: 'להשתיק קבוצות גיבוי חדשות', get: () => s.muteBackups, toggle: () => { s.muteBackups = !s.muteBackups } },
  { label: 'לגבות גם את ההודעות שלי', get: () => s.includeOwn, toggle: () => { s.includeOwn = !s.includeOwn } }
]

export const settingsText = s => {
  const items = settingsItems(s)
  const types = items.slice(0, 8).map((it, i) => `*${i + 1}.* ${on(it.get())} ${it.label}`)
  const rest = items.slice(8).map((it, i) => `*${i + 9}.* ${on(it.get())} ${it.label}`)
  return `⚙️ *הגדרות*\n\n_מה לגבות:_\n${types.join('\n')}\n\n_התנהגות:_\n${rest.join('\n')}\n\nשלחו מספר כדי להחליף מצב (אפשר כמה: *1,4*), או *סיום*.`
}

export const loginCode = code => `🔐 קוד הכניסה שלך לממשק:\n\n*${code}*\n\nתקף ל-5 דקות. לא ביקשת? פשוט להתעלם 🙂`

export const siteLink = () => process.env.SITE_URL
  ? `💻 לניהול נוח בממשק הגרפי:\n${process.env.SITE_URL}/login\n\nמזינים את מספר הטלפון, ואני שולח לכאן קוד כניסה.`
  : '💻 הממשק הגרפי עוד לא הוגדר אצל מנהל השירות.'

export const backupIntro = (name, kind) => `*${BOT_NAME}*\nכאן יישמר עותק של כל ההודעות ${kind === 'group' ? 'מהקבוצה' : 'מהצ\'אט עם'} *${name}*.\nגם אם מישהו ימחק או יערוך הודעה – העותק נשאר כאן. 🔒`

export const typeNames = {
  image: '📷 תמונה', video: '🎬 סרטון', audio: '🎤 הקלטה', document: '📄 מסמך', sticker: '🌟 סטיקר', location: '📍 מיקום', contact: '👤 איש קשר'
}
