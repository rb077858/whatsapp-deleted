import { BOT_NAME } from './config.js'

export const loginCode = code => `🔐 קוד הכניסה שלך ל${BOT_NAME}:\n\n*${code}*\n\nתקף ל-5 דקות. לא ביקשת? פשוט להתעלם 🙂`

export const backupIntro = (name, kind) => `*${BOT_NAME}*\nכאן יישמר עותק של כל ההודעות ${kind === 'group' ? 'מהקבוצה' : 'מהצ\'אט עם'} *${name}*.\nגם אם מישהו ימחק או יערוך הודעה – העותק נשאר כאן. 🔒`

export const typeNames = {
  image: '📷 תמונה', video: '🎬 סרטון', audio: '🎤 הקלטה', document: '📄 מסמך', sticker: '🌟 סטיקר', location: '📍 מיקום', contact: '👤 איש קשר'
}
