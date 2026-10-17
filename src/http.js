// Local web server on the phone (PORT). Serves the same website as Firebase Hosting,
// plus a phone-only setup page for the Firebase service account.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { APP_DIR, PORT, SERVICE_ACCOUNT_FILE, SITE_URL, BOT_NAME } from './config.js'
import { kvGet, checkPassword } from './db.js'
import { relayState, startRelay, loadServiceAccount } from './relay.js'
import { bots } from './manager.js'

const WEB_DIR = path.join(APP_DIR, 'web')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' }

let initCache = null

const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)

function authorized (req) {
  if (isLocal(req)) return true
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/)
  if (!m) return false
  const [u, ...p] = Buffer.from(m[1], 'base64').toString().split(':')
  return u === kvGet('adminUser') && checkPassword(p.join(':'), kvGet('adminPass'))
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

async function firebaseInit () {
  if (initCache) return initCache
  const sa = loadServiceAccount()
  if (!sa) return null
  const base = SITE_URL || `https://${sa.project_id}.web.app`
  const r = await fetch(`${base}/__/firebase/init.json`)
  if (!r.ok) return null
  initCache = await r.text()
  return initCache
}

function readBody (req, limit = 100000) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('too large')); req.destroy() } })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const setupPage = () => fs.readFileSync(path.join(WEB_DIR, 'setup.html'), 'utf8')

export function startHttp () {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      const p = decodeURIComponent(url.pathname)

      if (p === '/__/firebase/init.json') {
        const body = await firebaseInit().catch(() => null)
        return body ? send(res, 200, body) : send(res, 404, { error: 'not configured' })
      }
      if (p === '/setup' || p.startsWith('/setup/')) {
        if (!authorized(req)) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="admin"' })
          return res.end('auth required')
        }
        if (p === '/setup/status') {
          return send(res, 200, { ...relayState, siteUrl: SITE_URL || (relayState.projectId ? `https://${relayState.projectId}.web.app` : ''), botName: BOT_NAME, connections: [...bots.values()].map(b => ({ id: b.userId, status: b.status })) })
        }
        if (p === '/setup/service-account' && req.method === 'POST') {
          const body = await readBody(req)
          let sa
          try { sa = JSON.parse(body) } catch { return send(res, 400, { error: 'זה לא JSON תקין' }) }
          if (sa.type !== 'service_account' || !sa.private_key || !sa.project_id) return send(res, 400, { error: 'זה לא קובץ service account של Firebase' })
          fs.writeFileSync(SERVICE_ACCOUNT_FILE, JSON.stringify(sa), { mode: 0o600 })
          initCache = null
          await startRelay()
          return send(res, 200, { ok: true, projectId: sa.project_id })
        }
        return send(res, 200, setupPage(), TYPES['.html'])
      }
      if (p === '/health') return send(res, 200, { ok: true, relay: relayState.connected, bots: bots.size })

      // static website, with SPA fallback
      let file = path.normalize(path.join(WEB_DIR, p))
      if (!file.startsWith(WEB_DIR)) return send(res, 403, 'forbidden', 'text/plain')
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, 'index.html')
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' })
      fs.createReadStream(file).pipe(res)
    } catch (e) {
      console.log('[http]', e.message)
      if (!res.headersSent) send(res, 500, { error: 'server error' })
    }
  })
  server.listen(PORT, '0.0.0.0', () => console.log(`web UI on http://127.0.0.1:${PORT}  (setup: /setup)`))
  return server
}
