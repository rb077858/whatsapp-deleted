import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const APP_DIR = process.env.APP_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(APP_DIR, 'data'))
export const PORT = Number(process.env.PORT || 3000)
export const ON_PHONE = process.env.RUN_ON_PHONE === '1'

export const BOT_NAME = process.env.BOT_NAME || 'אל-מחיק 🧽'
export const BACKUP_SUFFIX = ' (הודעות)'
// Public address of the web UI (Firebase Hosting). Used in messages sent to users.
export const SITE_URL = process.env.SITE_URL || ''

export const SESSIONS_DIR = path.join(DATA_DIR, 'sessions')
export const PENDING_DIR = path.join(DATA_DIR, 'pending')
export const TMP_DIR = path.join(DATA_DIR, 'tmp')
export const SERVICE_ACCOUNT_FILE = path.join(DATA_DIR, 'firebase-service-account.json')

for (const dir of [DATA_DIR, SESSIONS_DIR, PENDING_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true })

export const DEFAULT_USER_SETTINGS = {
  types: { text: true, image: true, video: true, audio: true, document: true, sticker: true, location: true, contact: true },
  alertDeleted: true,
  alertEdited: true,
  includeOwn: true,
  paused: false,
  maxMediaMB: 16,
  notifyRequests: true,
  notifyDisconnect: true,
  notifyJoins: true
}

export const TYPE_LABELS = {
  text: 'טקסט',
  image: 'תמונות',
  video: 'סרטונים',
  audio: 'הודעות קוליות ושמע',
  document: 'מסמכים',
  sticker: 'סטיקרים',
  location: 'מיקומים',
  contact: 'אנשי קשר'
}

export function mergeSettings (saved) {
  const s = saved || {}
  return { ...DEFAULT_USER_SETTINGS, ...s, types: { ...DEFAULT_USER_SETTINGS.types, ...(s.types || {}) } }
}
