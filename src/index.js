import { BOT_NAME, DATA_DIR, ON_PHONE } from './config.js'
import { db } from './db.js'
import { startAll, stopAll } from './manager.js'
import { startRelay, stopRelay } from './relay.js'
import { startHttp } from './http.js'

console.log(`${BOT_NAME} starting (${ON_PHONE ? 'phone' : 'pc'}), data: ${DATA_DIR}`)

const server = startHttp()
startAll()
startRelay().catch(e => console.log('relay failed to start:', e.message))

// keep running on transient network errors (the phone switches Wi-Fi/cellular)
process.on('unhandledRejection', e => console.log('unhandled rejection:', e?.message || e))
process.on('uncaughtException', e => console.log('uncaught exception:', e?.stack || e))

let stopping = false
async function shutdown () {
  if (stopping) return
  stopping = true
  console.log('stopping…')
  server.close()
  await Promise.race([Promise.all([stopAll(), stopRelay()]), new Promise(r => setTimeout(r, 3500))])
  try { db.close() } catch {}
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
