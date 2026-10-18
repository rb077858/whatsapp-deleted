import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js'
import { initializeFirestore, collection, setDoc, doc, onSnapshot, serverTimestamp, updateDoc } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js'

// ---------------- helpers ----------------
const $app = document.getElementById('app')
const $nav = document.getElementById('nav')
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches
const store = {
  get: k => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch {} }
}
const fmtPhone = p => {
  const s = String(p || '')
  return s.startsWith('972') ? '0' + s.slice(3).replace(/^(\d{2})(\d{3})(\d+)$/, '$1-$2-$3') : '+' + s
}
const fmtNum = n => Number(n || 0).toLocaleString('he-IL')
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) } }

function toast (msg) {
  document.querySelector('.toast')?.remove()
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = msg
  document.body.append(el)
  setTimeout(() => el.remove(), 2600)
}

// Track the visible part of the screen, so sheets sit right above the on-screen keyboard.
function syncViewport () {
  const vv = window.visualViewport
  const st = document.documentElement.style
  st.setProperty('--vv-h', Math.round(vv ? vv.height : innerHeight) + 'px')
  st.setProperty('--vv-top', Math.round(vv ? vv.offsetTop : 0) + 'px')
}
window.visualViewport?.addEventListener('resize', syncViewport)
window.visualViewport?.addEventListener('scroll', syncViewport)
window.addEventListener('resize', syncViewport)
syncViewport()

let openModals = 0
/**
 * Bottom sheet on phones, centered dialog on wide screens.
 * Closes on backdrop tap, [data-close], Escape, or a downward swipe.
 */
function modal (html, onMount, { tall = false, onClose } = {}) {
  const el = document.createElement('div')
  el.className = 'modal'
  el.innerHTML = `<div class="sheet ${tall ? 'tall' : ''}" role="dialog" aria-modal="true"><div class="grab" aria-hidden="true"></div>${html}</div>`
  const sheet = el.querySelector('.sheet')
  let closed = false
  const onKey = e => { if (e.key === 'Escape') close() }
  const close = () => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKey)
    el.classList.add('out')
    setTimeout(() => {
      el.remove()
      if (--openModals === 0) document.documentElement.classList.remove('locked')
    }, 230)
    onClose?.()
  }
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) close() })
  document.addEventListener('keydown', onKey)

  // swipe down to dismiss, only when the content under the finger is scrolled to the top
  let startY = null
  let dy = 0
  sheet.addEventListener('touchstart', e => {
    const scroller = e.target.closest('.scroll') || sheet
    if (scroller.scrollTop > 0 || e.target.closest('input, textarea, .seg, .switch, .tabs')) return
    startY = e.touches[0].clientY
    dy = 0
  }, { passive: true })
  sheet.addEventListener('touchmove', e => {
    if (startY === null) return
    dy = Math.max(0, e.touches[0].clientY - startY)
    sheet.style.transition = 'none'
    sheet.style.transform = dy ? `translateY(${dy}px)` : ''
  }, { passive: true })
  sheet.addEventListener('touchend', () => {
    if (startY === null) return
    startY = null
    sheet.style.transition = ''
    if (dy > 90) close()
    else sheet.style.transform = ''
  })
  // keep the focused field in view once the keyboard has opened
  sheet.addEventListener('focusin', e => {
    if (e.target.matches('input, textarea')) setTimeout(() => e.target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 300)
  })

  openModals++
  document.documentElement.classList.add('locked')
  document.body.append(el)
  onMount?.(sheet, close)
  return close
}

function confirmBox (title, text, okLabel = 'אישור', danger = false) {
  return new Promise(resolve => {
    let ok = false
    modal(`<h2>${esc(title)}</h2><p class="muted" style="margin:10px 0 22px">${esc(text)}</p>
      <div class="row confirm-row"><button class="${danger ? 'btn danger' : 'cta'}" data-ok>${esc(okLabel)}</button><button class="btn" data-close>ביטול</button></div>`,
    (sheet, close) => { sheet.querySelector('[data-ok]').onclick = () => { ok = true; close() } },
    { onClose: () => resolve(ok) })
  })
}

// ---------------- firebase relay ----------------
// No sign-in: every request is a document with a random, unguessable id that only its creator knows.
// `uid` is a per-browser id the server uses for rate limiting.
let db
const uid = store.get('cid') || (() => { const id = crypto.randomUUID(); store.set('cid', id); return id })()
const ready = (async () => {
  const cfg = await fetch('/__/firebase/init.json').then(r => (r.ok ? r.json() : null)).catch(() => null)
  if (!cfg) throw new Error('NOCONFIG')
  // Long polling is used automatically when the streaming channel is blocked (some mobile networks);
  // after a request timed out once, this browser always uses it.
  db = initializeFirestore(initializeApp(cfg), store.get('lp') ? { experimentalForceLongPolling: true } : { experimentalAutoDetectLongPolling: true })
})()

const server = { online: null, status: {} }
ready.then(() => {
  onSnapshot(doc(db, 'public', 'status'), s => {
    const d = s.data() || {}
    const at = d.updatedAt?.toMillis?.() || 0
    server.status = d
    server.online = !!d.online && Date.now() - at < 3 * 60000
    document.dispatchEvent(new Event('server'))
  }, () => {})
}).catch(() => {})

class RpcError extends Error {}

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new RpcError(msg)), ms))])
const SLOW = 'החיבור איטי או נתקע 🐢 נסו שוב.'

/**
 * One request to the bot server. The timeout covers the whole round trip –
 * including writing the request – so a stuck connection can never spin forever.
 */
async function rpc (op, args = {}, token) {
  await withTimeout(ready, 15000, SLOW)
  const data = { uid, status: 'pending', op, args, createdAt: serverTimestamp() }
  if (token) data.token = token
  const ref = doc(collection(db, 'rpc'))
  return new Promise((resolve, reject) => {
    let off = () => {}
    let written = false
    const finish = (fn, v) => { clearTimeout(timer); off(); fn(v) }
    const timer = setTimeout(() => {
      store.set('lp', '1') // next page load uses the more robust long-polling transport
      finish(reject, new RpcError(written ? 'השרת לא עונה כרגע 😴 נסו שוב בעוד דקה.' : SLOW))
    }, 20000)
    setDoc(ref, data).then(() => { written = true }, e => finish(reject, new RpcError(e.message)))
    off = onSnapshot(ref, s => {
      const d = s.data()
      if (!d || d.status === 'pending') return
      if (d.status === 'done') finish(resolve, d.result)
      else finish(reject, new RpcError(d.error === 'expired' ? 'הבקשה פגה, נסו שוב.' : d.error))
    }, e => finish(reject, new RpcError(e.message)))
  })
}

const userRpc = (op, args) => rpc(op, args, store.get('token')).catch(e => {
  if (e.message === 'AUTH') { store.set('token', null); go('/login'); throw new RpcError('צריך להתחבר מחדש.') }
  throw e
})
const adminRpc = (op, args) => rpc(op, args, store.get('adminToken')).catch(e => {
  if (e.message === 'AUTH') { store.set('adminToken', null); render(); throw new RpcError('צריך להתחבר מחדש.') }
  throw e
})

// ---------------- router ----------------
let cleanup = null
function go (path) {
  history.pushState(null, '', path)
  render()
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]')
  if (!a || e.metaKey || e.ctrlKey) return
  e.preventDefault()
  go(a.getAttribute('href'))
})
window.addEventListener('popstate', () => render())

function nav () {
  const logged = !!store.get('token')
  $nav.innerHTML = location.pathname.startsWith('/j/')
    ? ''
    : location.pathname.startsWith('/admin')
    ? '<a class="navlink" href="/" data-link>לאתר</a>'
    : logged
      ? '<a class="navlink" href="/app" data-link>🧽 הגיבויים שלי</a>'
      : '<a class="navlink hide-sm" href="/login" data-link>כניסה</a><a class="btn" href="/join" data-link>הצטרפות</a>'
}

const routes = { '/': landing, '/join': join, '/login': login, '/app': dashboard, '/admin': admin }

function render () {
  cleanup?.()
  cleanup = null
  nav()
  window.scrollTo({ top: 0, behavior: 'instant' })
  $app.classList.remove('enter')
  void $app.offsetWidth
  $app.classList.add('enter')
  clearTimeout(render.t)
  render.t = setTimeout(() => $app.classList.remove('enter'), 450)
  const path = location.pathname.replace(/\/+$/, '') || '/'
  const jm = path.match(/^\/j\/([A-Za-z0-9]{6,20})$/)
  const page = jm ? () => linkPage(jm[1]) : routes[path] || landing
  Promise.resolve(page()).catch(err => {
    if (err?.message === 'NOCONFIG') {
      $app.innerHTML = `<div class="wrap narrow page"><h1>כמעט שם 🛠️</h1><p class="lead">השירות עוד לא הוגדר. מנהל השירות צריך להעלות את הגדרות Firebase בעמוד ההגדרה באפליקציה.</p></div>`
    } else {
      $app.innerHTML = `<div class="wrap narrow page"><div class="err">${esc(err?.message || err)}</div><button class="cta block" id="retry">🔄 לנסות שוב</button></div>`
      document.getElementById('retry').onclick = () => location.reload()
    }
  })
}

function serverPill () {
  if (server.online === null) return ''
  return server.online
    ? '<span class="pill"><span class="dot"></span>פעיל עכשיו</span>'
    : '<span class="pill off"><span class="dot"></span>השרת לא זמין כרגע</span>'
}

// ---------------- join buttons (with invite code when required) ----------------
let verifiedInvite = null
const needsInvite = () => server.status?.regMode === 'invite'

/** Puts focus in the field with all of its text selected, so typing simply replaces a wrong code. */
function selectAll (input) {
  input.focus()
  input.select()
  try { input.setSelectionRange(0, input.value.length) } catch {}
}

function joinForm (label, extra = '') {
  return `<form class="joinbox" data-join novalidate>
    <div class="invfield" ${needsInvite() ? '' : 'hidden'}>
      <label>🎟️ קוד הזמנה</label>
      <input type="text" class="invinput" inputmode="numeric" autocomplete="off" placeholder="••••••" aria-label="קוד הזמנה">
      <div class="inverr" role="alert" hidden></div>
    </div>
    <div class="start"><button class="cta">${label}</button>${extra}</div>
  </form>`
}

function syncJoinForms () {
  document.querySelectorAll('[data-join] .invfield').forEach(el => { el.hidden = !needsInvite() })
}

function bindJoinForms () {
  document.querySelectorAll('[data-join]').forEach(form => {
    const input = form.querySelector('.invinput')
    const err = form.querySelector('.inverr')
    const btn = form.querySelector('.cta')
    const label = btn.textContent
    const showErr = msg => { err.textContent = msg; err.hidden = false; input.classList.add('bad'); selectAll(input) }
    input.addEventListener('input', () => { err.hidden = true; input.classList.remove('bad') })
    input.addEventListener('focus', () => { if (input.classList.contains('bad')) selectAll(input) })
    form.onsubmit = async e => {
      e.preventDefault()
      if (!needsInvite()) return go('/join')
      const code = input.value.trim()
      if (!code) return showErr('הזינו את קוד ההזמנה')
      btn.disabled = true
      btn.textContent = 'בודק…'
      try {
        await rpc('checkInvite', { invite: code })
        verifiedInvite = code
        go('/join?invite=' + encodeURIComponent(code))
      } catch (e2) {
        btn.disabled = false
        btn.textContent = label
        showErr(e2.message)
      }
    }
  })
}

// ---------------- landing ----------------
function landing () {
  const draw = () => {
    $app.innerHTML = `
    <div class="wrap">
      <section class="hero">
        <div>
          <div data-pill>${serverPill()}</div>
          <h1>אף הודעה<br>לא <em>נמחקת.</em></h1>
          <p class="sub">אל-מחיק שומר עותק של כל הודעה מהקבוצות והצ'אטים שתבחרו – ומספר לכם כשמישהו מחק או ערך משהו. 🕵️</p>
          ${joinForm('הצטרפות בחינם ←', '<a class="btn" style="height:58px;padding:0 24px" href="/login" data-link>כבר רשומים? כניסה</a>')}
          <ul class="safe"><li>עובד בתוך הוואטסאפ שלכם</li><li>בלי להתקין כלום</li><li>מנתקים בלחיצה</li></ul>
        </div>
        <div class="phone" aria-hidden="true">
          <div class="screen">
            <div class="wa-head"><div class="wa-ava">👨‍👩‍👧</div><div class="wa-title">משפחה (הודעות)<small>את/ה</small></div></div>
            <div class="wa-body">
              <div class="bubble"><b>אמא</b>מי מגיע לארוחת שישי? 🍗<time>18:02</time></div>
              <div class="bubble"><b>דני</b>אני לא יכול השבוע, סליחה 🙈<time>18:05</time></div>
              <div class="bubble alert"><span class="q">דני: אני לא יכול השבוע, סליחה 🙈</span>🗑️ <strong>דני</strong> מחק/ה את ההודעה הזו<time>18:06</time></div>
              <div class="bubble out"><b>אני</b>ראיתי דני 😏<time>18:07</time></div>
            </div>
          </div>
        </div>
      </section>
    </div>
    <section class="section"><div class="wrap">
      <h2>איך זה עובד?</h2>
      <div class="steps">
        <div class="step"><h3>מתחברים</h3><p>סורקים ברקוד מהמחשב, או מזינים קוד בטלפון – בדיוק כמו וואטסאפ ווב.</p></div>
        <div class="step"><h3>בוחרים מה לגבות</h3><p>בקבוצת "אל-מחיק 🧽" שתיפתח לכם, כותבים שם של קבוצה או איש קשר ומאשרים.</p></div>
        <div class="step"><h3>זהו, נשמר</h3><p>לכל צ'אט נפתחת קבוצת "(הודעות)" עם עותק של כל הודעה ושם השולח – גם אחרי מחיקה.</p></div>
      </div>
    </div></section>
    <section class="section"><div class="wrap">
      <h2>מה מקבלים</h2>
      <div class="features">
        <div class="feature"><div class="ico">🗑️</div><h3>התראה על מחיקה</h3><p>מישהו מחק? תקבלו תגובה על העותק המקורי, עם השם שלו.</p></div>
        <div class="feature"><div class="ico">✏️</div><h3>התראה על עריכה</h3><p>רואים גם את הגרסה המקורית וגם את מה שנערך.</p></div>
        <div class="feature"><div class="ico">📸</div><h3>כל סוגי ההודעות</h3><p>טקסט, תמונות, סרטונים, הקלטות, מסמכים, סטיקרים ומיקומים – אתם בוחרים.</p></div>
        <div class="feature"><div class="ico">🛡️</div><h3>קבוצה נעולה</h3><p>רק אתם כותבים בקבוצות הגיבוי, ואף אחד לא יכול לשנות שם, תיאור או תמונה.</p></div>
        <div class="feature"><div class="ico">🔗</div><h3>שיתוף חכם</h3><p>צרפו אחרים לקריאה בלבד – לפי מספר, או בקישור עם הגבלות ואישור שלכם.</p></div>
        <div class="feature"><div class="ico">💬</div><h3>ניהול מהוואטסאפ</h3><p>הכל עובד בהודעות בקבוצת הבוט – או כאן בממשק, מה שנוח לכם.</p></div>
        <div class="feature"><div class="ico">🔒</div><h3>רק אצלכם</h3><p>קבוצות הגיבוי פרטיות, ורק אתם בהן.</p></div>
      </div>
    </div></section>
    <section class="section"><div class="wrap narrow" style="max-width:760px">
      <h2>שאלות</h2>
      <details><summary>הבוט יכול לשלוח הודעות בשמי לאנשים אחרים?</summary><p>הבוט כותב רק בקבוצת הניהול ובקבוצות ה(הודעות) שלכם. הוא לא כותב בקבוצות המקוריות ולא לאנשי הקשר שלכם.</p></details>
      <details><summary>אפשר לראות הודעות שנמחקו לפני שהצטרפתי?</summary><p>לא. אל-מחיק שומר רק הודעות שמגיעות אחרי שהוספתם את הצ'אט לגיבוי.</p></details>
      <details><summary>מה עם "צפייה חד-פעמית"?</summary><p>תמונות וסרטונים של צפייה חד-פעמית נשמרים כמו כל מדיה אחרת, אם בחרתם לגבות את הסוג הזה.</p></details>
      <details><summary>איך מתנתקים?</summary><p>בממשק הניהול יש כפתור "ניתוק", או בוואטסאפ: הגדרות ← מכשירים מקושרים ← לבחור את המכשיר ← התנתקות. קבוצות ה(הודעות) נשארות אצלכם.</p></details>
    </div></section>
    <section class="close wrap">
      <h2>מה שנכתב – נשאר. 🧽</h2>
      <div class="narrow" style="margin:0 auto">${joinForm('בואו נתחיל')}</div>
    </section>`
  }
  draw()
  bindJoinForms()
  // update in place, so a half-typed invite code is not wiped by a status refresh
  const onServer = () => {
    document.querySelectorAll('[data-pill]').forEach(el => { el.innerHTML = serverPill() })
    syncJoinForms()
  }
  document.addEventListener('server', onServer)
  cleanup = () => document.removeEventListener('server', onServer)
}

// ---------------- join ----------------
async function join () {
  const params = new URLSearchParams(location.search)
  let invite = params.get('invite') || ''
  // reconnecting an account that already exists: no invite code, the backups are kept
  let relink = params.get('relink') === '1'
  let method = isMobile ? 'code' : 'qr'
  let joinRef = null
  let offJoin = null
  let done = false

  const stopJoin = () => {
    offJoin?.()
    offJoin = null
    if (joinRef && !done) updateDoc(joinRef, { status: 'cancel' }).catch(() => {})
    joinRef = null
  }
  cleanup = stopJoin

  const shell = (body) => {
    $app.innerHTML = `<div class="wrap narrow page">
      <h1>${relink ? 'חיבור מחדש' : 'הצטרפות'}</h1>
      <p class="lead">${relink ? 'מחברים שוב את אותו מספר וואטסאפ. כל הגיבויים וההגדרות שלכם נשמרו 💚' : 'מחברים את הוואטסאפ כ"מכשיר מקושר" – כמו וואטסאפ ווב. לוקח חצי דקה.'}</p>
      <div class="card" id="joincard">${body}</div>
    </div>`
    return document.getElementById('joincard')
  }

  shell('<div class="spinner"></div>')
  await withTimeout(ready, 15000, SLOW)
  await new Promise(r => {
    if (server.online !== null) return r()
    document.addEventListener('server', r, { once: true })
    setTimeout(r, 10000)
  })
  const st = server.status

  if (!server.online) {
    const card = shell(`<h2>${server.online === null ? '🐢 לא הצלחתי להתחבר' : '😴 השרת לא זמין כרגע'}</h2><p class="hint">${server.online === null ? 'החיבור איטי או נתקע.' : 'נסו שוב בעוד כמה דקות.'}</p><button class="cta block" id="rl">🔄 לנסות שוב</button>`)
    card.querySelector('#rl').onclick = () => { if (server.online === null) store.set('lp', '1'); location.reload() }
    return
  }
  if (st.full && !relink) {
    shell(`<h2>${st.regMode === 'closed' ? '🚪 ההרשמה סגורה כרגע' : '🙈 כל המקומות תפוסים'}</h2><p class="hint">כבר רשומים? אפשר <a href="/login" data-link>להיכנס</a> או לחבר מחדש את אותו המספר.</p>
      <button class="btn" id="anyway">חיבור מחדש של מספר קיים</button>`)
    document.getElementById('anyway').onclick = () => { relink = true; chooseMethod() }
    return
  }

  const askInvite = (error) => {
    const card = shell(`<h2>🎟️ יש לכם קוד הזמנה?</h2><p class="hint">ההצטרפות כרגע רק עם קוד הזמנה.</p>
      <form id="f"><div class="field"><input type="text" class="big ${error ? 'bad' : ''}" id="inv" inputmode="numeric" autocomplete="off" placeholder="••••••" value="${esc(invite)}" required>
      <div class="inverr" role="alert" ${error ? '' : 'hidden'}>${esc(error || '')}</div></div>
      <button class="cta block">המשך</button></form>`)
    const inp = card.querySelector('#inv')
    card.querySelector('#f').onsubmit = e => { e.preventDefault(); verifyInvite(inp.value.trim()) }
    inp.addEventListener('input', () => { card.querySelector('.inverr').hidden = true; inp.classList.remove('bad') })
    if (error) selectAll(inp)
    else inp.focus()
  }

  // the invite code is checked before any pairing starts
  async function verifyInvite (code) {
    invite = code
    shell('<div class="center" style="padding:30px 0"><div class="spinner"></div><p class="muted" style="margin-top:14px">בודק את הקוד…</p></div>')
    try {
      await rpc('checkInvite', { invite })
      chooseMethod()
    } catch (e) {
      askInvite(e.message)
    }
  }

  const tabs = () => `<div class="tabs"><button data-m="qr" class="${method === 'qr' ? 'on' : ''}">📷 ברקוד</button><button data-m="code" class="${method === 'code' ? 'on' : ''}">🔢 קוד לטלפון</button></div>`
  const bindTabs = (card) => card.querySelectorAll('[data-m]').forEach(b => { b.onclick = () => { stopJoin(); method = b.dataset.m; chooseMethod() } })

  function chooseMethod (error) {
    if (method === 'qr') return startJoin({})
    const card = shell(`${tabs()}
      <h2>מה מספר הוואטסאפ שלכם?</h2><p class="hint">נקבל קוד של 8 תווים להזנה בוואטסאפ.</p>
      ${error ? `<div class="err">${esc(error)}</div>` : ''}
      <form id="f"><div class="field"><input type="tel" id="ph" inputmode="tel" autocomplete="tel" placeholder="050-1234567" value="${esc(params.get('phone') || '')}" required></div>
      <button class="cta block">קבלת קוד</button></form>`)
    bindTabs(card)
    card.querySelector('#f').onsubmit = e => { e.preventDefault(); startJoin({ phone: card.querySelector('#ph').value }) }
  }

  async function startJoin ({ phone }) {
    stopJoin()
    done = false
    const card = shell(`${tabs()}<div class="center" style="padding:30px 0"><div class="spinner"></div><p class="muted" style="margin-top:14px">מכין חיבור…</p></div>`)
    bindTabs(card)
    joinRef = doc(collection(db, 'joins'))
    const myRef = joinRef
    // nothing from the server within 30s: don't leave the visitor staring at a spinner
    let heard = false
    const silent = setTimeout(() => { if (!heard && myRef === joinRef && !done) { store.set('lp', '1'); stopJoin(); showError('השרת לא עונה כרגע. נסו שוב.') } }, 30000)
    setDoc(myRef, { uid, status: 'pending', method, phone: phone || '', invite, ...(relink ? { relink: true } : {}), createdAt: serverTimestamp() })
      .catch(e => { clearTimeout(silent); if (myRef === joinRef) showError('לא הצלחתי להתחיל חיבור: ' + e.message) })
    offJoin = onSnapshot(myRef, s => {
      if (myRef !== joinRef) return
      const d = s.data()
      if (!d || d.status === 'pending') return
      heard = true
      clearTimeout(silent)
      if (d.status === 'qr') showQR(d.qr)
      if (d.status === 'code') showCode(d.code)
      if (d.status === 'error') {
        done = true
        if (/הזמנה/.test(d.error)) return askInvite(d.error)
        showError(d.error)
      }
      if (d.status === 'connected') {
        done = true
        offJoin?.()
        store.set('token', d.token)
        nav()
        showSuccess(d.name)
      }
    })
  }

  function showQR (qr) {
    const card = document.getElementById('joincard')
    const img = card.querySelector('#qrimg')
    if (img) { img.src = qr; return }
    card.innerHTML = `${tabs()}
      <div class="qrbox"><img id="qrimg" src="${qr}" alt="ברקוד לסריקה בוואטסאפ"></div>
      <ol class="howto">
        <li>פתחו את <b>וואטסאפ</b> בטלפון</li>
        <li>לחצו על <b>⋮</b> (אנדרואיד) או <b>הגדרות</b> (אייפון) ← <b>מכשירים מקושרים</b></li>
        <li><b>קישור מכשיר</b> וסרקו את הברקוד</li>
      </ol>
      <p class="muted center" style="margin-top:14px">הברקוד מתחלף מדי כמה שניות – זה תקין 🙂</p>`
    bindTabs(card)
  }

  function showCode (code) {
    const card = document.getElementById('joincard')
    card.innerHTML = `${tabs()}
      <p class="hint center">הקוד שלכם:</p>
      <div class="paircode" id="pc">${esc(code)}</div>
      <div class="row" style="justify-content:center;margin-bottom:18px"><button class="btn small" id="copy">📋 העתקה</button></div>
      <ol class="howto">
        <li>בוואטסאפ: <b>⋮</b> / <b>הגדרות</b> ← <b>מכשירים מקושרים</b> ← <b>קישור מכשיר</b></li>
        <li>לחצו על <b>"קישור באמצעות מספר טלפון"</b> (למטה)</li>
        <li>הזינו את הקוד</li>
      </ol>
      <p class="muted center" style="margin-top:14px">ממתין לחיבור… <span class="spinner" style="display:inline-block;width:16px;height:16px;border-width:3px;vertical-align:middle"></span></p>`
    bindTabs(card)
    card.querySelector('#copy').onclick = () => navigator.clipboard?.writeText(code.replace(/-/g, '')).then(() => toast('הקוד הועתק'))
  }

  function showError (msg) {
    const card = shell(`<div class="err">${esc(msg)}</div><button class="cta block" id="retry">לנסות שוב</button>`)
    card.querySelector('#retry').onclick = () => chooseMethod()
  }

  function showSuccess (name) {
    shell(`<div class="success"><div class="big-emoji">🎉</div>
      <h2>${name ? esc(name) + ', ' : ''}התחברתם!</h2>
      <p class="hint" style="margin:10px 0 22px">בוואטסאפ שלכם נפתחה עכשיו קבוצה בשם <b>"אל-מחיק 🧽"</b>.<br>כתבו שם שם של קבוצה או איש קשר כדי להתחיל לגבות – או המשיכו מכאן.</p>
      <a class="cta block" href="/app" data-link>לממשק הניהול ←</a></div>`)
  }

  if (st.regMode !== 'invite' || relink) chooseMethod()
  else if (invite && invite === verifiedInvite) chooseMethod()
  else if (invite) verifyInvite(invite)
  else askInvite()
}

// ---------------- login ----------------
async function login () {
  if (store.get('token')) return go('/app')
  let phone = ''
  const draw = (step, error, info) => {
    $app.innerHTML = `<div class="wrap narrow page">
      <h1>כניסה</h1>
      <p class="lead">${step === 1 ? 'נשלח קוד לקבוצת "אל-מחיק 🧽" בוואטסאפ שלכם.' : `שלחנו קוד בן 6 ספרות לקבוצת "אל-מחיק 🧽" בוואטסאפ של ${esc(fmtPhone(phone.replace(/\D/g, '').replace(/^0/, '972')))}.`}</p>
      <div class="card">
        ${error ? `<div class="err">${esc(error)}</div>` : ''}${info ? `<div class="ok">${esc(info)}</div>` : ''}
        <form id="f">
          ${step === 1
            ? '<div class="field"><label for="in">מספר טלפון</label><input type="tel" id="in" inputmode="tel" autocomplete="tel" placeholder="050-1234567" required></div><button class="cta block" id="go">שליחת קוד</button>'
            : '<div class="field"><input class="big" id="in" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" required></div><button class="cta block" id="go">כניסה</button><div class="row" style="justify-content:space-between;margin-top:14px"><button type="button" class="linkbtn" id="back">מספר אחר</button><button type="button" class="linkbtn" id="resend">שליחה מחדש</button></div>'}
        </form>
      </div>
      <p class="muted center" style="margin-top:18px">עוד לא רשומים? <a href="/join" data-link>הצטרפות</a></p>
    </div>`
    const f = document.getElementById('f')
    const input = document.getElementById('in')
    const btn = document.getElementById('go')
    input.focus()
    if (step === 2) {
      document.getElementById('back').onclick = () => draw(1)
      document.getElementById('resend').onclick = () => send(true)
      input.oninput = () => { if (input.value.replace(/\D/g, '').length === 6) f.requestSubmit() }
    }
    f.onsubmit = async e => {
      e.preventDefault()
      btn.disabled = true
      btn.textContent = '...'
      if (step === 1) { phone = input.value; return send() }
      try {
        const r = await rpc('loginVerify', { phone, code: input.value.replace(/\D/g, '') })
        store.set('token', r.token)
        go('/app')
      } catch (err) { draw(2, err.message) }
    }
  }
  const send = async (again) => {
    try {
      await rpc('loginStart', { phone })
      draw(2, null, again ? 'שלחנו קוד חדש.' : null)
    } catch (err) { again ? draw(2, err.message) : draw(1, err.message) }
  }
  draw(1)
}

// ---------------- dashboard ----------------
const TYPE_ICONS = { text: '💬', image: '📷', video: '🎬', audio: '🎤', document: '📄', sticker: '🌟', location: '📍', contact: '👤' }
const TYPE_NAMES = { text: 'טקסט', image: 'תמונות', video: 'סרטונים', audio: 'הקלטות', document: 'מסמכים', sticker: 'סטיקרים', location: 'מיקומים', contact: 'אנשי קשר' }
const STATUS = { open: 'מחובר', connecting: 'מתחבר…', closed: 'מתחבר מחדש…', stopped: 'לא פעיל', logged_out: 'מנותק מוואטסאפ' }

async function dashboard () {
  if (!store.get('token')) return go('/login')
  $app.innerHTML = '<div class="page center"><div class="spinner"></div></div>'
  let data = await userRpc('me')
  let settings = data.user.settings

  const saveSettings = debounce(async () => {
    try { settings = (await userRpc('saveSettings', { settings })).settings; toast('💾 נשמר') } catch (e) { toast(e.message) }
  }, 500)

  const draw = () => {
    const u = data.user
    const cap = data.limits?.maxMediaMB || 16
    const total = data.backups.reduce((a, b) => a + b.count, 0)
    const sw = (key, label, small, val) => `<label class="toggle"><span class="t">${label}${small ? `<small>${small}</small>` : ''}</span><span class="switch"><input type="checkbox" data-s="${key}" ${val ? 'checked' : ''}><span></span></span></label>`
    $app.innerHTML = `<div class="wrap page" style="max-width:760px">
      ${u.status === 'logged_out' ? `<div class="card relink-card">
        <h2>🔌 הוואטסאפ התנתק</h2>
        <p class="hint">זה יכול לקרות כשוואטסאפ מנתק מכשירים מקושרים. כל הגיבויים וההגדרות שלכם נשמרו – רק צריך לחבר שוב את אותו המספר.</p>
        <a class="cta block" href="/join?relink=1&phone=${encodeURIComponent(fmtPhone(u.phone))}" data-link>חיבור מחדש ←</a>
      </div>` : ''}
      ${settings.paused ? '<div class="ok">⏸️ הגיבוי מושהה כרגע. אפשר לחדש בהגדרות למטה.</div>' : ''}
      <div class="dash-head">
        <div class="avatar">🧽</div>
        <div><h1>היי${u.name ? ' ' + esc(u.name) : ''} 👋</h1><div class="row"><span class="muted ltr">${esc(fmtPhone(u.phone))}</span><span class="status ${esc(u.status)}">${STATUS[u.status] || esc(u.status)}</span></div></div>
      </div>
      <div class="stats">
        <div class="stat"><b>${data.backups.length}</b><span>צ'אטים מגובים</span></div>
        <div class="stat"><b>${fmtNum(total)}</b><span>הודעות נשמרו</span></div>
        <div class="stat"><b>${data.backups.filter(b => b.active).length}</b><span>פעילים</span></div>
      </div>

      ${data.requests?.length ? `<div class="card reqcard">
        <div class="card-head"><h2>🙋 בקשות הצטרפות <span class="badge">${data.requests.length}</span></h2></div>
        <div class="list">${data.requests.map(r => `<div class="item wide">
          <div class="ico initial">${esc((r.name || '#').trim()[0])}</div>
          <div class="txt"><div class="name">${esc(r.name || fmtPhone(r.phone))}</div><div class="meta">${r.name ? `<span class="ltr">${esc(fmtPhone(r.phone))}</span> · ` : ''}ל-${esc(r.group)} (הודעות)</div></div>
          <div class="acts"><button class="btn small ok-btn" data-req="${r.id}" data-ok="1">✓ אישור</button>
          <button class="btn small danger" data-req="${r.id}" data-ok="0" title="דחייה">✕</button></div>
        </div>`).join('')}</div>
      </div>` : ''}

      <div class="card">
        <div class="card-head"><div><h2>מה מגובה</h2><p class="muted">לכל צ'אט יש קבוצת "(הודעות)" משלו בוואטסאפ</p></div><button class="cta" style="height:46px;padding:0 20px;font-size:16px" id="add">+ הוספה</button></div>
        <div class="list">
          ${data.backups.length
            ? data.backups.map(b => `<div class="item wide">
                <div class="ico">${b.kind === 'group' ? '👥' : '👤'}</div>
                <div class="txt"><div class="name">${esc(b.name)}</div><div class="meta">${fmtNum(b.count)} הודעות${b.active ? '' : ' · מושהה'}</div></div>
                <div class="acts"><button class="btn small share-btn" data-share="${b.id}" title="צירוף אנשים">👥 צירוף${b.links ? `<span class="dotbadge">${b.links}</span>` : ''}</button>
                <span class="switch" title="פעיל"><input type="checkbox" data-active="${b.id}" ${b.active ? 'checked' : ''}><span></span></span>
                <button class="btn small danger" data-remove="${b.id}" title="הסרה">✕</button></div>
              </div>`).join('')
            : '<div class="empty"><div class="e">📭</div>עוד לא בחרתם מה לגבות.<br>לחצו "+ הוספה" כדי להתחיל.</div>'}
        </div>
      </div>

      <div class="card">
        <h2>מה לגבות</h2><p class="hint">הסוגים שיועתקו לקבוצות ה(הודעות)</p>
        <div class="chips">${Object.keys(TYPE_NAMES).map(k => `<button class="chip ${settings.types[k] ? 'on' : ''}" data-type="${k}">${TYPE_ICONS[k]} ${TYPE_NAMES[k]}</button>`).join('')}</div>
      </div>

      <div class="card">
        <h2>הגדרות</h2>
        ${sw('alertDeleted', '🗑️ התראה כשמישהו מוחק הודעה', 'תגובה על העותק עם שם המוחק', settings.alertDeleted)}
        ${sw('alertEdited', '✏️ התראה כשמישהו עורך הודעה', 'כולל הנוסח החדש', settings.alertEdited)}
        ${sw('includeOwn', '🙋 לגבות גם את ההודעות שלי', '', settings.includeOwn)}
        ${sw('paused', '⏸️ השהיית כל הגיבוי', 'עוצר זמנית את ההעתקה', settings.paused)}
        <label class="toggle" style="cursor:default"><span class="t">📦 גודל קובץ מקסימלי<small>קבצים גדולים יותר יירשמו בלי הקובץ · עד ${cap}MB</small></span>
          <span class="row" style="gap:6px"><input type="number" id="maxmb" min="1" max="${cap}" value="${Math.min(settings.maxMediaMB, cap)}" style="width:84px;height:44px;font-size:16px;text-align:center"> <span class="muted">MB</span></span></label>
      </div>

      <div class="card">
        <h2>החשבון</h2><p class="hint">הניתוק מסיר את החיבור מהוואטסאפ ושומר את הגיבויים לחיבור הבא. מחיקה מוחקת הכל מהשרת. בשני המקרים קבוצות ה(הודעות) נשארות אצלכם בוואטסאפ.</p>
        <div class="row"><button class="btn" id="logout">יציאה מהממשק</button><button class="btn danger" id="disconnect">ניתוק הוואטסאפ</button><button class="btn danger" id="delacc">🗑 מחיקת החשבון</button></div>
      </div>
    </div>`

    document.getElementById('add').onclick = openAdd
    $app.querySelectorAll('[data-active]').forEach(el => { el.onchange = async () => {
      try { await userRpc('setBackupActive', { id: el.dataset.active, active: el.checked }); data.backups.find(b => b.id == el.dataset.active).active = el.checked; draw(); toast(el.checked ? '▶️ הגיבוי פעיל' : '⏸️ הגיבוי הושהה') } catch (e) { toast(e.message); el.checked = !el.checked }
    } })
    $app.querySelectorAll('[data-share]').forEach(el => { el.onclick = () => openShare(data.backups.find(b => b.id == el.dataset.share), refresh) })
    $app.querySelectorAll('[data-req]').forEach(el => { el.onclick = async () => {
      const ok = el.dataset.ok === '1'
      el.disabled = true
      try {
        const r = await userRpc('decideRequest', { requestId: el.dataset.req, approve: ok })
        toast(!ok ? 'הבקשה נדחתה' : r.status === 'invited' ? '📩 נשלחה הזמנה אישית' : r.status === 'already' ? 'כבר בקבוצה' : '✅ צורף לקבוצה')
        refresh()
      } catch (e) { toast(e.message); el.disabled = false }
    } })
    $app.querySelectorAll('[data-remove]').forEach(el => { el.onclick = async () => {
      const b = data.backups.find(x => x.id == el.dataset.remove)
      if (!await confirmBox(`להפסיק לגבות את "${b.name}"?`, 'קבוצת ה(הודעות) תישאר אצלכם עם כל מה שכבר נשמר בה.', 'הפסקת גיבוי', true)) return
      try { await userRpc('removeBackup', { id: b.id }); data.backups = data.backups.filter(x => x !== b); draw(); toast('הגיבוי הוסר') } catch (e) { toast(e.message) }
    } })
    $app.querySelectorAll('[data-type]').forEach(el => { el.onclick = () => { settings.types[el.dataset.type] = !settings.types[el.dataset.type]; el.classList.toggle('on'); saveSettings() } })
    $app.querySelectorAll('[data-s]').forEach(el => { el.onchange = () => { settings[el.dataset.s] = el.checked; saveSettings(); if (el.dataset.s === 'paused') draw() } })
    document.getElementById('maxmb').onchange = e => {
      settings.maxMediaMB = Math.max(1, Math.min(cap, Number(e.target.value) || cap))
      e.target.value = settings.maxMediaMB
      saveSettings()
    }
    document.getElementById('logout').onclick = async () => { await rpc('logout', {}, store.get('token')).catch(() => {}); store.set('token', null); go('/') }
    document.getElementById('delacc').onclick = async () => {
      if (!await confirmBox('למחוק את החשבון?', 'הוואטסאפ יתנתק, וכל ההגדרות, רשימת הגיבויים והקישורים יימחקו מהשרת. אי אפשר לבטל. הקבוצות בוואטסאפ נשארות אצלכם.', 'מחיקה לצמיתות', true)) return
      try { await userRpc('deleteAccount'); store.set('token', null); toast('החשבון נמחק. להתראות 👋'); go('/') } catch (e) { toast(e.message) }
    }
    document.getElementById('disconnect').onclick = async () => {
      if (!await confirmBox('לנתק את הוואטסאפ?', 'הגיבוי ייעצר והחיבור יוסר מהמכשירים המקושרים. אפשר להצטרף שוב בכל רגע.', 'ניתוק', true)) return
      try { await userRpc('disconnect'); store.set('token', null); toast('נותקתם. להתראות 👋'); go('/') } catch (e) { toast(e.message) }
    }
  }

  async function refresh () { data = await userRpc('me'); settings = data.user.settings; draw() }

  function openAdd () {
    let all = []
    let extra = []
    const picked = new Map()
    modal(`<div class="card-head" style="margin-bottom:10px"><h2>הוספת גיבוי</h2><button class="btn small" data-close>✕</button></div>
      <input type="search" id="q" placeholder="🔎 שם של קבוצה או איש קשר" autocomplete="off">
      <div class="list" id="res" style="margin:12px 0 16px;min-height:120px"><div class="center" style="padding:30px"><div class="spinner"></div></div></div>
      <button class="cta block" id="save" disabled>בחרו צ'אטים</button>`, (sheet, close) => {
      const q = sheet.querySelector('#q')
      const res = sheet.querySelector('#res')
      const save = sheet.querySelector('#save')
      const list = () => {
        const term = q.value.trim().toLowerCase()
        const seen = new Set()
        return [...all.filter(r => !term || r.name.toLowerCase().includes(term)), ...extra].filter(r => !seen.has(r.jid) && seen.add(r.jid))
      }
      const drawList = (loading) => {
        const items = list()
        res.innerHTML = items.length
          ? items.map(r => `<div class="item pick ${picked.has(r.jid) ? 'on' : ''}" data-jid="${esc(r.jid)}" ${r.backedUp ? 'style="opacity:.5;cursor:default"' : ''}>
              <span class="check">${picked.has(r.jid) ? '✓' : ''}</span>
              <div class="ico">${r.kind === 'group' ? '👥' : '👤'}</div>
              <div class="txt"><div class="name">${esc(r.name)}</div><div class="meta">${r.backedUp ? '✅ כבר מגובה' : r.kind === 'group' ? `קבוצה${r.size ? ' · ' + r.size + ' משתתפים' : ''}` : 'צ\'אט פרטי'}</div></div></div>`).join('')
          : `<div class="empty">${loading ? '<div class="spinner"></div>' : q.value.trim().length < 2 ? 'כתבו שם כדי לחפש אנשי קשר' : 'לא נמצא 🤷'}</div>`
        save.disabled = !picked.size
        save.textContent = picked.size ? `גיבוי ${picked.size === 1 ? 'צ\'אט אחד' : picked.size + ' צ\'אטים'} ←` : 'בחרו צ\'אטים'
      }
      res.onclick = e => {
        const it = e.target.closest('[data-jid]')
        if (!it) return
        const r = list().find(x => x.jid === it.dataset.jid)
        if (!r || r.backedUp) return
        picked.has(r.jid) ? picked.delete(r.jid) : picked.set(r.jid, r)
        drawList()
      }
      const remote = debounce(async () => {
        const term = q.value.trim()
        if (term.length < 2) { extra = []; return drawList() }
        try { extra = (await userRpc('searchChats', { query: term })).results } catch {}
        if (q.value.trim() === term) drawList()
      }, 600)
      q.oninput = () => { drawList(); remote() }
      save.onclick = async () => {
        const chats = [...picked.values()]
        if (!await confirmBox('ליצור קבוצות גיבוי?', chats.map(c => `${c.name} (הודעות)`).join(' · '), 'כן, לגבות')) return
        save.disabled = true
        save.textContent = 'יוצר קבוצות…'
        try {
          const r = await userRpc('addBackups', { chats: chats.map(c => ({ jid: c.jid, alt: c.alt || null, name: c.name })) })
          const bad = r.results.filter(x => !x.ok)
          toast(bad.length ? `❌ ${bad.map(b => b.name).join(', ')} נכשל` : '🎉 נוסף! מעכשיו הכל נשמר')
          close()
          refresh()
        } catch (e) { toast(e.message); drawList() }
      }
      q.focus()
      userRpc('searchChats', { query: '' }).then(r => { all = r.results; drawList() }).catch(e => { res.innerHTML = `<div class="err">${esc(e.message)}</div>` })
    })
  }

  draw()
}

// ---------------- sharing a backup group ----------------
const siteBase = () => server.status?.siteUrl || location.origin
const linkUrl = id => `${siteBase()}/j/${id}`
const ADD_RESULT = {
  added: ['✅', 'צורף/ה לקבוצה', 'יוכל/תוכל לקרוא את כל ההודעות מעכשיו.'],
  invited: ['📩', 'נשלחה הזמנה אישית', 'ההגדרות של המספר לא מאפשרות צירוף ישיר, אז שלחנו לו/ה הזמנה בוואטסאפ.'],
  already: ['👌', 'כבר בקבוצה', 'המספר הזה כבר חבר בקבוצה.']
}
const EXPIRY = [['0', 'ללא'], ['1', 'יום'], ['7', 'שבוע'], ['30', 'חודש']]
const WHO = [['anyone', 'כולם'], ['contacts', 'אנשי הקשר שלי'], ['list', 'רשימת מספרים']]

function openShare (b, onChange) {
  let tab = 'add'
  let changed = false
  modal(`<div class="share-head">
      <div class="gicon">${b.kind === 'group' ? '👥' : '👤'}<span class="lock">🔒</span></div>
      <div class="txt"><h2>${esc(b.name)} (הודעות)</h2><p class="muted">רק אתם כותבים · כל מי שמצורף רק קורא</p></div>
      <button class="btn small" data-close>✕</button>
    </div>
    <div class="tabs" id="stabs"><button data-t="add">➕ הוספה</button><button data-t="links">🔗 קישורים</button><button data-t="members">👥 חברים</button></div>
    <div id="pane" class="scroll"></div>`, (sheet, close) => {
    const pane = sheet.querySelector('#pane')
    const setTab = t => {
      tab = t
      sheet.querySelectorAll('#stabs button').forEach(x => x.classList.toggle('on', x.dataset.t === t))
      pane.scrollTop = 0
      ;({ add: paneAdd, links: paneLinks, members: paneMembers })[t]()
    }
    sheet.querySelectorAll('#stabs button').forEach(x => { x.onclick = () => setTab(x.dataset.t) })

    function paneAdd (result) {
      pane.innerHTML = `<p class="hint">מזינים מספר והוא מצטרף לקבוצה לקריאה בלבד. אם הגדרות הפרטיות שלו לא מאפשרות צירוף – הוא יקבל הזמנה אישית בוואטסאפ.</p>
        <form id="af" class="addrow"><input type="tel" id="aph" inputmode="tel" autocomplete="off" placeholder="050-1234567" required><button class="cta" id="abtn">הוספה</button></form>
        <div id="ares">${result || ''}</div>`
      const input = pane.querySelector('#aph')
      input.focus()
      pane.querySelector('#af').onsubmit = async e => {
        e.preventDefault()
        const btn = pane.querySelector('#abtn')
        btn.disabled = true
        btn.textContent = '…'
        const out = pane.querySelector('#ares')
        try {
          const r = await userRpc('addMember', { id: b.id, phone: input.value })
          const [ico, title, text] = ADD_RESULT[r.status] || ADD_RESULT.added
          out.innerHTML = `<div class="result ok"><span class="rico">${ico}</span><div><b>${esc(fmtPhone(String(input.value).replace(/\D/g, '').replace(/^0/, '972')))} – ${title}</b><p>${text}</p></div></div>`
          changed = true
          input.value = ''
          input.focus()
        } catch (err) {
          out.innerHTML = `<div class="result bad"><span class="rico">⚠️</span><div><b>לא הצלחתי להוסיף</b><p>${esc(err.message)}</p></div></div>`
          selectAll(input)
        }
        btn.disabled = false
        btn.textContent = 'הוספה'
      }
    }

    async function paneLinks () {
      pane.innerHTML = '<div class="center" style="padding:30px"><div class="spinner"></div></div>'
      let list
      try { list = (await userRpc('listLinks', { id: b.id })).links } catch (e) { pane.innerHTML = `<div class="err">${esc(e.message)}</div>`; return }
      if (tab !== 'links') return
      const chips = l => [
        `<span class="mini">👥 ${l.uses}${l.maxUses ? '/' + l.maxUses : ''} הצטרפו</span>`,
        l.expires ? `<span class="mini">⏳ עד ${new Date(l.expires).toLocaleDateString('he-IL')}</span>` : '<span class="mini">♾️ ללא תפוגה</span>',
        l.approval ? '<span class="mini">✋ באישור שלכם</span>' : '<span class="mini">⚡ אוטומטי</span>',
        l.who === 'contacts' ? '<span class="mini">📇 אנשי קשר בלבד</span>' : l.who === 'list' ? `<span class="mini">📋 ${l.allowed.length} מספרים מורשים</span>` : ''
      ].join('')
      pane.innerHTML = `<p class="hint">כל קישור פותח דף שבו מזינים מספר טלפון, והוא מצורף לקבוצה לפי הכללים שתגדירו. הקישור לא מוביל ישירות לקבוצה.</p>
        <div class="lcards">${list.length ? list.map(l => `<div class="lcard ${l.active && !l.problem ? '' : 'off'}">
          <div class="lhead"><b>${esc(l.label || 'קישור הצטרפות')}</b><span class="switch"><input type="checkbox" data-lact="${l.id}" ${l.active ? 'checked' : ''}><span></span></span></div>
          <div class="lurl ltr">${esc(linkUrl(l.id).replace(/^https?:\/\//, ''))}</div>
          <div class="minis">${chips(l)}</div>
          ${l.problem && l.active ? `<div class="lwarn">${esc(l.problem)}</div>` : ''}
          <div class="lactions"><button class="btn small" data-lcopy="${l.id}">📋 העתקה</button>${navigator.share ? `<button class="btn small" data-lshare="${l.id}">↗ שיתוף</button>` : ''}<button class="btn small" data-ledit="${l.id}">⚙️ עריכה</button><span class="spacer"></span><button class="btn small danger" data-ldel="${l.id}" title="מחיקה">🗑</button></div>
        </div>`).join('') : '<div class="empty"><div class="e">🔗</div>עוד אין קישורים לקבוצה הזו.</div>'}</div>
        <button class="cta block" id="newlink">+ קישור חדש</button>`
      pane.scrollTop = 0
      pane.querySelector('#newlink').onclick = () => linkForm()
      pane.querySelectorAll('[data-lcopy]').forEach(x => { x.onclick = () => navigator.clipboard?.writeText(linkUrl(x.dataset.lcopy)).then(() => toast('📋 הקישור הועתק')) })
      pane.querySelectorAll('[data-lshare]').forEach(x => { x.onclick = () => navigator.share({ title: `${b.name} (הודעות)`, text: `הצטרפות לקבוצת הגיבוי "${b.name} (הודעות)"`, url: linkUrl(x.dataset.lshare) }).catch(() => {}) })
      pane.querySelectorAll('[data-ledit]').forEach(x => { x.onclick = () => linkForm(list.find(l => l.id === x.dataset.ledit)) })
      pane.querySelectorAll('[data-lact]').forEach(x => { x.onchange = async () => {
        try { await userRpc('updateLink', { linkId: x.dataset.lact, options: { active: x.checked } }); changed = true; toast(x.checked ? 'הקישור פעיל' : 'הקישור הושבת'); paneLinks() } catch (e) { toast(e.message); x.checked = !x.checked }
      } })
      pane.querySelectorAll('[data-ldel]').forEach(x => { x.onclick = async () => {
        if (!await confirmBox('למחוק את הקישור?', 'מי שינסה להשתמש בו יקבל הודעה שהקישור לא פעיל. מי שכבר הצטרף נשאר בקבוצה.', 'מחיקה', true)) return
        try { await userRpc('deleteLink', { linkId: x.dataset.ldel }); changed = true; toast('הקישור נמחק'); paneLinks() } catch (e) { toast(e.message) }
      } })
    }

    function linkForm (l) {
      const st = { who: l?.who || 'anyone', expires: l ? null : '0', approval: !!l?.approval }
      const seg = (name, opts, cur) => `<div class="seg seg-${opts.length}" data-seg="${name}">${opts.map(([v, t]) => `<button type="button" data-v="${v}" class="${v === cur ? 'on' : ''}">${t}</button>`).join('')}</div>`
      pane.innerHTML = `<form id="lf" class="lform">
        <h3>${l ? 'עריכת קישור' : 'קישור חדש'}</h3>
        <div class="field"><label>שם הקישור <small>(רק אתם רואים)</small></label><input type="text" id="llabel" maxlength="40" placeholder="למשל: בני דודים" value="${esc(l?.label || '')}"></div>
        <div class="field"><label>כמה אנשים יכולים להצטרף</label><input type="number" id="lmax" min="0" max="1024" placeholder="ללא הגבלה" value="${l?.maxUses || ''}"></div>
        <div class="field"><label>תוקף${l?.expires ? ` <small>(כרגע: עד ${new Date(l.expires).toLocaleDateString('he-IL')})</small>` : ''}</label>${seg('expires', l ? [['keep', 'ללא שינוי'], ...EXPIRY] : EXPIRY, l ? 'keep' : '0')}</div>
        <div class="field"><label>מי יכול להצטרף</label>${seg('who', WHO, st.who)}
          <textarea id="lallowed" rows="3" placeholder="מספר בכל שורה: 050-1234567" ${st.who === 'list' ? '' : 'hidden'}>${esc((l?.allowed || []).map(fmtPhone).join('\n'))}</textarea></div>
        <label class="toggle"><span class="t">✋ אישור ידני לכל בקשה<small>תקבלו הודעה בקבוצת הבוט ובממשק, ותחליטו</small></span><span class="switch"><input type="checkbox" id="lappr" ${st.approval ? 'checked' : ''}><span></span></span></label>
        <div class="row" style="margin-top:18px"><button class="cta" id="lsave">${l ? 'שמירה' : 'יצירת קישור'}</button><button type="button" class="btn" id="lcancel">ביטול</button></div>
      </form>`
      pane.scrollTop = 0
      if (l) st.expires = 'keep'
      pane.querySelectorAll('[data-seg]').forEach(g => g.querySelectorAll('button').forEach(btn => { btn.onclick = () => {
        g.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === btn))
        st[g.dataset.seg] = btn.dataset.v
        if (g.dataset.seg === 'who') pane.querySelector('#lallowed').hidden = btn.dataset.v !== 'list'
      } }))
      pane.querySelector('#lcancel').onclick = () => paneLinks()
      pane.querySelector('#lf').onsubmit = async e => {
        e.preventDefault()
        const options = {
          label: pane.querySelector('#llabel').value,
          maxUses: Number(pane.querySelector('#lmax').value) || 0,
          who: st.who,
          approval: pane.querySelector('#lappr').checked
        }
        if (st.who === 'list') options.allowed = pane.querySelector('#lallowed').value
        if (st.expires !== 'keep') options.expiresDays = Number(st.expires)
        const btn = pane.querySelector('#lsave')
        btn.disabled = true
        try {
          const r = l ? await userRpc('updateLink', { linkId: l.id, options }) : await userRpc('createLink', { id: b.id, options })
          changed = true
          if (!l) navigator.clipboard?.writeText(linkUrl(r.link.id)).then(() => toast('🔗 הקישור נוצר והועתק'), () => toast('🔗 הקישור נוצר'))
          else toast('💾 נשמר')
          paneLinks()
        } catch (err) { toast(err.message); btn.disabled = false }
      }
    }

    async function paneMembers () {
      pane.innerHTML = '<div class="center" style="padding:30px"><div class="spinner"></div></div>'
      let members
      try { members = (await userRpc('groupMembers', { id: b.id })).members } catch (e) { pane.innerHTML = `<div class="err">${esc(e.message)}</div>`; return }
      if (tab !== 'members') return
      members.sort((x, y) => (y.me - x.me) || (y.admin - x.admin))
      pane.innerHTML = `<p class="hint">${members.length === 1 ? 'כרגע רק אתם בקבוצה.' : `${members.length} חברים בקבוצה`}</p>
        <div class="list">${members.map(m => `<div class="item">
          <div class="ico initial">${esc((m.name || (m.me ? 'א' : '#')).trim()[0])}</div>
          <div class="txt"><div class="name">${m.me ? 'אתם' : esc(m.name || (m.phone ? fmtPhone(m.phone) : 'חבר/ה בקבוצה'))}</div><div class="meta">${m.phone && !m.me && m.name ? `<span class="ltr">${esc(fmtPhone(m.phone))}</span> · ` : ''}${m.admin ? '👑 מנהל/ת' : '👀 קריאה בלבד'}</div></div>
          ${m.me ? '' : `<button class="btn small danger" data-mrm="${esc(m.id)}" title="הסרה מהקבוצה">✕</button>`}
        </div>`).join('')}</div>`
      pane.querySelectorAll('[data-mrm]').forEach(x => { x.onclick = async () => {
        if (!await confirmBox('להסיר מהקבוצה?', 'אפשר תמיד להוסיף שוב.', 'הסרה', true)) return
        try { await userRpc('removeMember', { id: b.id, participant: x.dataset.mrm }); toast('הוסר/ה מהקבוצה'); paneMembers() } catch (e) { toast(e.message) }
      } })
    }

    setTab('add')
  }, { tall: true, onClose: () => { if (changed) onChange() } })
}

// ---------------- public join-link page ----------------
async function linkPage (id) {
  $app.innerHTML = '<div class="page center"><div class="spinner"></div></div>'
  const info = await rpc('linkInfo', { link: id }).catch(e => ({ ok: false, error: e.message }))
  const frame = body => {
    $app.innerHTML = `<div class="wrap narrow page joinlink"><div class="card invite-card">${body}</div>
      <p class="muted center powered">קבוצת גיבוי של <a href="/" data-link>אל-מחיק 🧽</a> · מה שנכתב – נשאר</p></div>`
  }
  const head = () => `<div class="gicon big">${info.kind === 'group' ? '👥' : '👤'}<span class="lock">🔒</span></div>
    <p class="eyebrow">הוזמנתם לקבוצת גיבוי</p>
    <h1>${esc(info.groupName)}</h1>
    <p class="muted">${info.owner ? `מאת ${esc(info.owner)} · ` : ''}קבוצה לקריאה בלבד</p>`
  if (!info.ok) {
    frame(`${info.groupName ? head() : '<div class="big-emoji">🔗</div>'}<div class="result bad" style="margin-top:20px"><span class="rico">😕</span><div><b>${esc(info.error || 'הקישור לא תקין')}</b><p>אפשר לבקש קישור חדש ממי ששלח לכם אותו.</p></div></div>`)
    return
  }
  const form = (error) => {
    frame(`${head()}
      <div class="minis center-minis">${info.approval ? '<span class="mini">✋ בעל הקבוצה מאשר כל בקשה</span>' : '<span class="mini">⚡ הצטרפות מיידית</span>'}${info.left != null ? `<span class="mini">🎟️ נשארו ${info.left} מקומות</span>` : ''}${info.restricted ? '<span class="mini">🔐 למורשים בלבד</span>' : ''}</div>
      <form id="jf" class="jform">
        ${info.approval ? '<div class="field"><label for="jn">השם שלכם</label><input type="text" id="jn" maxlength="60" autocomplete="name" placeholder="איך יציגו אתכם בבקשה"></div>' : ''}
        <div class="field"><label for="jp">מספר הוואטסאפ שלכם</label><input type="tel" id="jp" inputmode="tel" autocomplete="tel" placeholder="050-1234567" required class="${error ? 'bad' : ''}">
        <div class="inverr" ${error ? '' : 'hidden'}>${esc(error || '')}</div></div>
        <button class="cta block" id="jgo">${info.approval ? 'שליחת בקשה להצטרפות' : 'הצטרפות לקבוצה'}</button>
      </form>`)
    const input = document.getElementById('jp')
    if (error) selectAll(input)
    input.addEventListener('input', () => { input.classList.remove('bad'); document.querySelector('.jform .inverr').hidden = true })
    document.getElementById('jf').onsubmit = async e => {
      e.preventDefault()
      const btn = document.getElementById('jgo')
      btn.disabled = true
      btn.textContent = 'רגע…'
      try {
        const r = await rpc('linkJoin', { link: id, phone: input.value, name: document.getElementById('jn')?.value || '' })
        done(r.status)
      } catch (err) { form(err.message) }
    }
  }
  const done = status => {
    const R = {
      added: ['🎉', 'הצטרפתם!', 'הקבוצה כבר מופיעה אצלכם בוואטסאפ.'],
      invited: ['📩', 'שלחנו לכם הזמנה', 'פתחו את הוואטסאפ ולחצו על ההזמנה לקבוצה כדי להצטרף.'],
      already: ['👌', 'אתם כבר בקבוצה', 'אין צורך לעשות כלום – היא מחכה לכם בוואטסאפ.'],
      pending: ['⏳', 'הבקשה נשלחה', 'בעל הקבוצה יקבל אותה עכשיו. ברגע שיאשר – תצורפו אוטומטית.']
    }[status] || ['✅', 'בוצע', '']
    frame(`<div class="success"><div class="big-emoji">${R[0]}</div><h2>${R[1]}</h2><p class="hint" style="margin-top:10px">${R[2]}</p><p class="muted">${esc(info.groupName)}</p></div>`)
  }
  form()
}

// ---------------- admin: customer service ----------------
const UFILTERS = {
  all: ['הכל', () => true],
  open: ['מחוברים', u => u.status === 'open'],
  off: ['מנותקים', u => u.status !== 'open'],
  attention: ['דורש תשומת לב', u => u.status === 'logged_out' || u.requests > 0 || u.paused]
}
const EVENT_ICONS = { list_error: '⚠️', joined: '🎉', connected: '🟢', logged_out: '🔴', control_group: '🏠', backup: '🗂️', list: '📋', link: '🔗', admin: '🛠️' }
function ago (ts) {
  if (!ts) return '—'
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'עכשיו'
  if (m < 60) return `לפני ${m} ד׳`
  const h = Math.round(m / 60)
  if (h < 24) return `לפני ${h} ש׳`
  const days = Math.round(h / 24)
  return days < 30 ? `לפני ${days} ימים` : new Date(ts).toLocaleDateString('he-IL')
}
const eventRow = (e, withWho) => `<div class="tl"><span class="tl-ico">${EVENT_ICONS[e.type] || '•'}</span><div class="tl-txt">${withWho && e.who ? `<b>${esc(e.who)}</b> · ` : ''}${esc(e.text)}<small>${ago(e.ts)}</small></div></div>`

const USER_ACTIONS = [
  ['relink', '🔌', 'חיבור מחדש בקוד', 'קוד בן 8 תווים לשלוח למשתמש', false],
  ['recreateControl', '🏠', 'קבוצה ראשית חדשה', 'כשהמשתמש מחק או יצא מהקבוצה', false],
  ['diagnoseLists', '🩺', 'בדיקת רשימות', 'קריאה בלבד – בלי לשנות כלום', false],
  ['relock', '🔐', 'נעילת קבוצות', 'מחיל מחדש את הרשאות הקבוצות', false],
  ['restart', '♻️', 'חיבור מחדש', 'כשהבוט לא מגיב', false],
  ['loginAs', '👤', 'כניסה כמשתמש', 'פותח את הממשק שלו (ל-24 שעות)', false],
  ['pause', '⏸️', 'השהיית גיבוי', '', false],
  ['resume', '▶️', 'חידוש גיבוי', '', false],
  ['resetSettings', '↺', 'איפוס הגדרות', 'מחזיר לברירות המחדל', false],
  ['disconnect', '⏏', 'ניתוק מוואטסאפ', 'מסיר את המכשיר המקושר', true],
  ['delete', '🗑', 'מחיקת משתמש', 'כולל כל הנתונים שלו בשרת', true]
]

function openUser (userId, onChange) {
  let tab = 'overview'
  let data = null
  let changed = false
  modal(`<div class="share-head" id="uhead"><div class="gicon">👤</div><div class="txt"><h2>טוען…</h2></div><button class="btn small" data-close>✕</button></div>
    <div class="tabs" id="utabs"><button data-t="overview">סקירה</button><button data-t="backups">גיבויים</button><button data-t="log">יומן</button><button data-t="msg">הודעה</button></div>
    <div id="upane" class="scroll"><div class="center" style="padding:30px"><div class="spinner"></div></div></div>`, async (sheet, close) => {
    const pane = sheet.querySelector('#upane')
    const load = async () => {
      data = await adminRpc('adminUser', { userId })
      const u = data.user
      sheet.querySelector('#uhead').innerHTML = `<div class="gicon initial-big">${esc((u.name || '#').trim()[0])}</div>
        <div class="txt"><h2>${esc(u.name || fmtPhone(u.phone))}</h2><p class="muted"><span class="ltr">${esc(fmtPhone(u.phone))}</span> · <span class="status ${esc(u.status)}">${STATUS[u.status] || esc(u.status)}</span></p></div>
        <button class="btn small" data-close>✕</button>`
    }
    const setTab = t => {
      tab = t
      sheet.querySelectorAll('#utabs button').forEach(x => x.classList.toggle('on', x.dataset.t === t))
      pane.scrollTop = 0
      ;({ overview, backups: backupsPane, log, msg })[t]()
    }
    sheet.querySelectorAll('#utabs button').forEach(x => { x.onclick = () => setTab(x.dataset.t) })

    function overview () {
      const u = data.user
      const fact = (k, v) => `<div class="fact"><span>${k}</span><b>${v}</b></div>`
      pane.innerHTML = `<div class="facts">
          ${fact('הצטרף', new Date(u.createdAt).toLocaleDateString('he-IL'))}
          ${fact('נראה לאחרונה', ago(u.lastSeen))}
          ${fact('גיבויים', data.backups.length)}
          ${fact('הודעות', fmtNum(data.backups.reduce((a, b) => a + b.count, 0)))}
          ${fact('קבוצה ראשית', u.hasControl ? '✅ קיימת' : '❌ אין')}
          ${fact('גיבוי', u.settings.paused ? '⏸️ מושהה' : '▶️ פעיל')}
          ${fact('בקשות ממתינות', data.requests)}
        </div>
        <div class="field" style="margin-top:16px"><label>📝 הערה פנימית <small>(רק המנהל רואה)</small></label><textarea id="unote" class="ta" rows="2" placeholder="למשל: ביקש עזרה עם הקישור, חזר אליו ב-…">${esc(u.note)}</textarea></div>
        <h3 class="sub-h">פעולות</h3>
        <div class="actgrid">${USER_ACTIONS.filter(([a]) => !(a === 'pause' && u.settings.paused) && !(a === 'resume' && !u.settings.paused)).map(([a, ico, t, sub, danger]) =>
          `<button class="act ${danger ? 'danger' : ''}" data-ua="${a}"><span class="act-ico">${ico}</span><b>${t}</b>${sub ? `<small>${sub}</small>` : ''}</button>`).join('')}</div>`
      const note = pane.querySelector('#unote')
      note.oninput = debounce(async () => { try { await adminRpc('adminSaveNote', { userId, note: note.value }); changed = true; toast('📝 נשמר') } catch (e) { toast(e.message) } }, 700)
      pane.querySelectorAll('[data-ua]').forEach(b => { b.onclick = async () => {
        const [a, , t, sub, danger] = USER_ACTIONS.find(x => x[0] === b.dataset.ua)
        if ((danger || a === 'recreateControl' || a === 'loginAs') && !await confirmBox(`${t}?`, `${data.user.name || ''} ${fmtPhone(data.user.phone)}${sub ? ' – ' + sub : ''}`, t, danger)) return
        b.disabled = true
        b.classList.add('busy')
        try {
          const r = a === 'relink' ? {} : await adminRpc('adminUserAction', { userId, action: a })
          changed = true
          if (a === 'loginAs') { store.set('token', r.token); close(); toast('👤 נכנסת לממשק של המשתמש'); return go('/app') }
          if (a === 'relink') { b.disabled = false; b.classList.remove('busy'); return showRelink(userId, data.user, async () => { changed = true; await load(); overview() }) }
          if (a === 'diagnoseLists') { b.disabled = false; b.classList.remove('busy'); return showDiagnosis(r.diagnosis, userId) }
          if (a === 'delete') { toast('המשתמש נמחק'); return close() }
          toast('✅ ' + (r.message || 'בוצע'))
          await load()
          overview()
        } catch (e) { toast(e.message); b.disabled = false; b.classList.remove('busy') }
      } })
    }

    function backupsPane () {
      pane.innerHTML = data.backups.length ? `<div class="list">${data.backups.map(b => `<div class="item wide">
          <div class="ico">${b.kind === 'group' ? '👥' : '👤'}</div>
          <div class="txt"><div class="name">${esc(b.name)}</div><div class="meta">${fmtNum(b.count)} הודעות · ${b.links} קישורים · מ-${new Date(b.createdAt).toLocaleDateString('he-IL')}</div></div>
          <div class="acts"><span class="switch"><input type="checkbox" data-bact="${b.id}" ${b.active ? 'checked' : ''}><span></span></span>
          <button class="btn small danger" data-brm="${b.id}">✕</button></div></div>`).join('')}</div>`
        : '<div class="empty"><div class="e">📭</div>אין גיבויים</div>'
      pane.querySelectorAll('[data-bact]').forEach(x => { x.onchange = async () => {
        try { await adminRpc('adminBackupAction', { userId, backupId: x.dataset.bact, action: x.checked ? 'resume' : 'pause' }); changed = true; toast(x.checked ? '▶️ חודש' : '⏸️ הושהה') } catch (e) { toast(e.message); x.checked = !x.checked }
      } })
      pane.querySelectorAll('[data-brm]').forEach(x => { x.onclick = async () => {
        const b = data.backups.find(y => y.id == x.dataset.brm)
        if (!await confirmBox(`להסיר את הגיבוי של "${b.name}"?`, 'קבוצת ה(הודעות) נשארת אצל המשתמש.', 'הסרה', true)) return
        try { await adminRpc('adminBackupAction', { userId, backupId: b.id, action: 'remove' }); changed = true; await load(); backupsPane(); toast('הוסר') } catch (e) { toast(e.message) }
      } })
    }

    function log () {
      pane.innerHTML = `<div class="timeline">${data.events.length ? data.events.map(e => eventRow(e)).join('') : '<div class="empty">עוד אין אירועים</div>'}</div>`
    }

    function msg () {
      pane.innerHTML = `<p class="hint">ההודעה תישלח לקבוצה הראשית של המשתמש, בכותרת "הודעה מצוות אל-מחיק".</p>
        <textarea id="umsg" class="ta" rows="5" placeholder="היי! ראינו ש…"></textarea>
        <button class="cta block" id="usend" style="margin-top:12px">שליחה</button>`
      const ta = pane.querySelector('#umsg')
      pane.querySelector('#usend').onclick = async () => {
        if (!ta.value.trim()) return toast('כתבו הודעה')
        try { await adminRpc('adminMessage', { userId, text: ta.value }); ta.value = ''; toast('📣 נשלח'); changed = true } catch (e) { toast(e.message) }
      }
    }

    try { await load(); setTab('overview') } catch (e) { pane.innerHTML = `<div class="err">${esc(e.message)}</div>` }
  }, { tall: true, onClose: () => { if (changed) onChange() } })
}

function showRelink (userId, user, onDone) {
  let timer = null
  const msgText = code => `היי! כדי לחבר שוב את אל-מחיק 🧽 לוואטסאפ שלך:\n1. וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר\n2. "קישור באמצעות מספר טלפון"\n3. להזין את הקוד: ${code}\n\nהקוד תקף לכמה דקות. כל הגיבויים שלך נשמרו 💚`
  modal(`<div class="card-head"><h2>🔌 חיבור מחדש</h2><button class="btn small" data-close>✕</button></div>
    <div id="rlbody"><div class="center" style="padding:30px"><div class="spinner"></div><p class="muted" style="margin-top:12px">מבקש קוד מוואטסאפ…</p></div></div>`, async (sheet) => {
    const body = sheet.querySelector('#rlbody')
    const fail = msg => { body.innerHTML = `<div class="err">${esc(msg)}</div><button class="cta block" id="rlretry">לנסות שוב</button>`; body.querySelector('#rlretry').onclick = start }
    async function start () {
      clearInterval(timer)
      body.innerHTML = '<div class="center" style="padding:30px"><div class="spinner"></div><p class="muted" style="margin-top:12px">מבקש קוד מוואטסאפ…</p></div>'
      let r
      try { r = await adminRpc('adminRelink', { userId }) } catch (e) { return fail(e.message) }
      const wa = `https://wa.me/${r.phone}?text=${encodeURIComponent(msgText(r.code))}`
      body.innerHTML = `<p class="hint">שלחו את הקוד ל-${esc(user.name || '')} <span class="ltr">${esc(fmtPhone(r.phone))}</span>. הוא מזין אותו בוואטסאפ ← מכשירים מקושרים ← קישור באמצעות מספר טלפון.</p>
        <div class="paircode">${esc(r.code)}</div>
        <div class="row confirm-row"><a class="cta" href="${wa}" target="_blank" rel="noopener">💬 שליחה בוואטסאפ</a><button class="btn" id="rlcopy">📋 העתקה</button></div>
        <div class="rl-status" id="rlstat"><span class="spinner sm"></span> ממתין שהמשתמש יזין את הקוד…</div>`
      body.querySelector('#rlcopy').onclick = () => navigator.clipboard?.writeText(msgText(r.code)).then(() => toast('📋 ההודעה הועתקה'))
      timer = setInterval(async () => {
        if (!document.body.contains(body)) return clearInterval(timer)
        const s = await adminRpc('adminRelinkStatus', { userId }).catch(() => null)
        if (!s) return
        if (s.status === 'connected') {
          clearInterval(timer)
          body.querySelector('#rlstat').innerHTML = '✅ <b>מחובר!</b> הגיבוי חזר לפעול.'
          body.querySelector('#rlstat').classList.add('done')
          onDone()
        } else if (s.status === 'error') {
          clearInterval(timer)
          fail(s.error || 'החיבור נכשל')
        }
      }, 3000)
    }
    start()
  }, { onClose: () => clearInterval(timer) })
}

function showDiagnosis (dg, userId) {
  const mine = dg.lists.find(l => !l.deleted && (l.id === dg.ourId || l.name.trim() === dg.botName))
  const inside = mine ? dg.expected.filter(j => mine.members.includes(j)).length : 0
  const pos = mine && dg.order ? dg.order.ids.indexOf(mine.id) : -1
  const row = (ok, t) => `<div class="dg-row"><span>${ok ? '✅' : '❌'}</span><div>${t}</div></div>`
  const report = () => `<div class="dg-sum">
      ${row(!!mine, mine ? `הרשימה "${esc(mine.name)}" קיימת (מזהה ${esc(mine.id)}, ${esc(String(mine.type))})` : 'הרשימה של הבוט לא קיימת בוואטסאפ')}
      ${mine ? row(inside === dg.expected.length, `${inside} מתוך ${dg.expected.length} הקבוצות נמצאות בה`) : ''}
      ${mine ? row(!dg.order || pos >= 0, dg.order ? (pos >= 0 ? `מופיעה בסדר הרשימות (מקום ${pos + 1})` : 'לא מופיעה בסדר הרשימות') : 'אין רשומת סדר רשימות בחשבון') : ''}
      ${Object.keys(dg.errors).length ? row(false, 'שגיאות בקריאה: ' + esc(JSON.stringify(dg.errors))) : ''}
    </div>
    <h3 class="sub-h">כל הרשימות בחשבון (${dg.lists.length})</h3>
    <div class="list">${dg.lists.map(l => `<div class="item"><div class="ico">${l.deleted ? '🗑️' : l.type === 'CUSTOM' ? '📋' : '🏷️'}</div>
      <div class="txt"><div class="name">${esc(l.name || '(ללא שם)')}${l.id === mine?.id ? ' · <b>של הבוט</b>' : ''}</div>
      <div class="meta ltr">id ${esc(l.id)} · ${esc(String(l.type))} · order ${l.orderIndex ?? '–'} · active ${l.isActive ?? '–'} · ${l.members.length} chats · ${esc(l.collection)}${l.deleted ? ' · deleted' : ''}</div></div></div>`).join('') || '<div class="empty">אין רשימות</div>'}</div>
    ${dg.order ? `<p class="muted ltr" style="margin-top:10px">order: ${esc(dg.order.ids.join(', '))} (${esc(dg.order.collection)})</p>` : ''}`
  modal(`<div class="card-head"><h2>🩺 בדיקת רשימות</h2><button class="btn small" data-close>✕</button></div>
    <div id="dgbody">${report()}</div>
    <p class="muted" style="margin-top:12px">הבוט לא משנה רשימות בוואטסאפ: כתיבה כזו מבחוץ גורמת לוואטסאפ לנתק את כל המכשירים המקושרים.</p>
    <div class="row confirm-row" style="margin-top:12px"><button class="btn" id="dgcopy">📋 העתקת הנתונים</button></div>`, (sheet) => {
    sheet.querySelector('#dgcopy').onclick = () => navigator.clipboard?.writeText(JSON.stringify(dg, null, 1)).then(() => toast('📋 הנתונים הועתקו'))
  }, { tall: true })
}

// ---------------- admin ----------------
async function admin () {
  if (!store.get('adminToken')) {
    $app.innerHTML = `<div class="wrap narrow page"><h1>ניהול 🔐</h1><p class="lead">כניסת מנהל השירות</p>
      <div class="card"><div id="e"></div><form id="f">
        <div class="field"><label>שם משתמש</label><input type="text" id="u" autocomplete="username" required dir="ltr"></div>
        <div class="field"><label>סיסמה</label><input type="password" id="p" autocomplete="current-password" required dir="ltr"></div>
        <button class="cta block" id="go">כניסה</button></form></div></div>`
    document.getElementById('f').onsubmit = async e => {
      e.preventDefault()
      const btn = document.getElementById('go')
      btn.disabled = true
      try {
        const r = await rpc('adminLogin', { username: document.getElementById('u').value.trim(), password: document.getElementById('p').value })
        store.set('adminToken', r.token)
        admin()
      } catch (err) {
        document.getElementById('e').innerHTML = `<div class="err">${esc(err.message)}</div>`
        btn.disabled = false
      }
    }
    return
  }
  $app.innerHTML = '<div class="page center"><div class="spinner"></div></div>'
  let d = await adminRpc('adminOverview')
  let uq = ''
  let ufilter = 'all'
  const MODES = { open: 'פתוח לכולם', limit: 'עם תקרה', invite: 'קוד הזמנה', closed: 'סגור' }
  const draw = () => {
    const s = d.settings
    const inviteLink = `${siteBase()}/join?invite=${encodeURIComponent(s.inviteCode)}`
    const up = d.server.uptime
    const g = d.guard
    const sk = g.skipped
    const skippedTotal = sk.size + sk.rate + sk.memory
    const skippedText = skippedTotal
      ? `מאז ההפעלה דולגו ${skippedTotal} קבצים: ${[sk.size && `${sk.size} בגלל גודל`, sk.rate && `${sk.rate} בגלל קצב`, sk.memory && `${sk.memory} בגלל זיכרון`].filter(Boolean).join(', ')}. במקומם נשלחה הודעה עם שם השולח.`
      : 'מאז ההפעלה לא דולג אף קובץ בגלל עומס.'
    $app.innerHTML = `<div class="wrap page">
      <div class="card-head"><h1 style="margin:0">ניהול 🛠️</h1><div class="row"><button class="btn small" id="reload">↻ רענון</button><button class="btn small" id="out">יציאה</button></div></div>
      <div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
        <div class="stat"><b>${d.users.length}</b><span>משתמשים</span></div>
        <div class="stat"><b>${d.users.filter(u => u.status === 'open').length}</b><span>מחוברים עכשיו</span></div>
        <div class="stat"><b>${fmtNum(d.totals.chats)}</b><span>צ'אטים מגובים</span></div>
        <div class="stat"><b>${fmtNum(d.totals.messages)}</b><span>הודעות נשמרו</span></div>
        <div class="stat"><b>${d.server.rssMB}MB</b><span>זיכרון · ${Math.floor(up / 3600)}ש' ${Math.floor(up % 3600 / 60)}ד' פעיל</span></div>
      </div>
      ${g.memory.level === 'high' ? '<div class="err">🔥 הזיכרון כמעט מלא – גיבוי קבצים מושהה זמנית. כדאי להוריד את מגבלת הקבצים או את מספר המשתמשים.</div>' : g.memory.level === 'warn' ? '<div class="ok warnbox">⚠️ הזיכרון מתקרב לתקרה. שווה לשים לב.</div>' : ''}

      <div class="card">
        <h2>🛡️ הגנות על הטלפון</h2><p class="hint">מה ששומר על הטלפון קריר: תמונות וסרטונים הם רוב העומס</p>
        <div class="meter-row"><span>זיכרון</span><b class="ltr">${g.memory.heapMB} / ${g.memory.limitMB} MB</b></div>
        <div class="meter ${g.memory.level}"><span style="width:${Math.min(100, g.memory.percent)}%"></span></div>
        <p class="muted" style="margin:6px 0 18px">${g.memory.percent}% מהתקרה · ${g.connections} חיבורי וואטסאפ פעילים · ${g.memory.rssMB}MB בסך הכל</p>
        <div class="row" style="align-items:flex-end">
          <div class="field" style="flex:1;min-width:140px;margin:0"><label>גודל קובץ מקסימלי (MB)</label><input type="number" id="gmax" min="1" max="100" value="${s.maxMediaMB}"></div>
          <div class="field" style="flex:1;min-width:140px;margin:0"><label>קבצים לדקה, לכל משתמש</label><input type="number" id="grate" min="1" max="120" value="${s.mediaPerMinute}"></div>
          <button class="cta" style="height:56px" id="saveGuard">שמירה</button>
        </div>
        <p class="muted" style="margin-top:14px">${skippedText}</p>
      </div>

      <div class="card">
        <h2>הרשמה</h2><p class="hint">מי יכול להצטרף לשירות</p>
        <div class="seg" id="mode">${Object.entries(MODES).map(([k, v]) => `<button data-mode="${k}" class="${s.regMode === k ? 'on' : ''}">${v}</button>`).join('')}</div>
        <div class="row" style="margin-top:16px;align-items:flex-end">
          <div class="field" style="flex:1;min-width:160px;margin:0" ${s.regMode === 'limit' ? '' : 'hidden'}><label>מספר משתמשים מקסימלי</label><input type="number" id="limit" min="0" value="${s.regLimit}"></div>
          <div class="field" style="flex:1;min-width:160px;margin:0" ${s.regMode === 'invite' ? '' : 'hidden'}><label>קוד הזמנה</label><input type="text" id="invite" value="${esc(s.inviteCode)}" dir="ltr"></div>
          <button class="cta" style="height:56px" id="saveReg">שמירה</button>
        </div>
        ${s.regMode === 'invite' ? `<div class="row" style="margin-top:14px"><span class="muted ltr" style="word-break:break-all">${esc(inviteLink)}</span><button class="btn small" id="copyInv">📋 העתקת קישור הזמנה</button></div>` : ''}
      </div>

      <div class="card">
        <div class="card-head"><h2>משתמשים <span class="badge">${d.users.length}</span></h2></div>
        <input type="search" id="usearch" placeholder="🔎 חיפוש לפי שם או טלפון" value="${esc(uq)}" autocomplete="off">
        <div class="chips ufilters">${Object.entries(UFILTERS).map(([k, [t]]) => `<button class="chip ${ufilter === k ? 'on' : ''}" data-uf="${k}">${t} <span class="cnt">${d.users.filter(UFILTERS[k][1]).length}</span></button>`).join('')}</div>
        <div class="list" id="ulist"></div>
      </div>

      <div class="card">
        <h2>📣 הודעה לכל המשתמשים</h2><p class="hint">תישלח לקבוצה הראשית של כל משתמש מחובר</p>
        <textarea id="bcast" rows="3" class="ta" placeholder="למשל: שדרגנו את הגיבוי של סרטונים 🎬"></textarea>
        <button class="cta block" id="bsend" style="margin-top:12px">שליחה לכולם</button>
      </div>

      <div class="card">
        <h2>🕓 מה קרה לאחרונה</h2>
        <div class="timeline">${d.events.length ? d.events.map(e => eventRow(e, true)).join('') : '<div class="empty">עוד אין אירועים</div>'}</div>
      </div>

      <div class="card">
        <h2>פרטי כניסה למנהל</h2>
        <form id="cred" class="row" style="align-items:flex-end">
          <div class="field" style="flex:1;min-width:160px;margin:0"><label>שם משתמש</label><input type="text" id="au" value="${esc(s.adminUser)}" dir="ltr"></div>
          <div class="field" style="flex:1;min-width:160px;margin:0"><label>סיסמה חדשה</label><input type="password" id="ap" placeholder="ללא שינוי" autocomplete="new-password" dir="ltr"></div>
          <button class="btn" style="height:56px">עדכון</button>
        </form>
      </div>
    </div>`

    let mode = s.regMode
    $app.querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => { mode = b.dataset.mode; s.regMode = mode; draw() } })
    document.getElementById('saveReg').onclick = async () => {
      const settings = { regMode: mode }
      const lim = document.getElementById('limit'); const inv = document.getElementById('invite')
      if (lim) settings.regLimit = Number(lim.value)
      if (inv) settings.inviteCode = inv.value
      try { await adminRpc('adminSaveSettings', { settings }); d = await adminRpc('adminOverview'); draw(); toast('💾 נשמר') } catch (e) { toast(e.message) }
    }
    document.getElementById('copyInv')?.addEventListener('click', () => navigator.clipboard?.writeText(inviteLink).then(() => toast('הקישור הועתק')))
    document.getElementById('reload').onclick = async () => { d = await adminRpc('adminOverview'); draw() }
    document.getElementById('saveGuard').onclick = async () => {
      const settings = { maxMediaMB: Number(document.getElementById('gmax').value), mediaPerMinute: Number(document.getElementById('grate').value) }
      try { await adminRpc('adminSaveSettings', { settings }); d = await adminRpc('adminOverview'); draw(); toast('💾 נשמר') } catch (e) { toast(e.message) }
    }
    document.getElementById('out').onclick = () => { store.set('adminToken', null); admin() }
    document.getElementById('cred').onsubmit = async e => {
      e.preventDefault()
      try { await adminRpc('adminSaveSettings', { settings: { adminUser: document.getElementById('au').value, newPassword: document.getElementById('ap').value } }); toast('💾 עודכן') } catch (err) { toast(err.message) }
    }
    const ulist = document.getElementById('ulist')
    const drawUsers = () => {
      const q = uq.trim().toLowerCase()
      const digits = q.replace(/\D/g, '').replace(/^0/, '')
      const list = d.users.filter(UFILTERS[ufilter][1]).filter(u => !q || (u.name || '').toLowerCase().includes(q) || (digits && u.phone.includes(digits)))
      ulist.innerHTML = list.length ? list.map(u => `<button class="item urow" data-user="${u.id}">
          <div class="ico initial">${esc((u.name || '#').trim()[0])}</div>
          <div class="txt"><div class="name">${esc(u.name || fmtPhone(u.phone))} ${u.note ? '<span title="יש הערה">📝</span>' : ''}</div>
            <div class="meta"><span class="status ${esc(u.status)}">${STATUS[u.status] || esc(u.status)}</span> · <span class="ltr">${esc(fmtPhone(u.phone))}</span> · ${u.backups} גיבויים${u.paused ? ' · ⏸️' : ''}${u.requests ? ` · 🙋 ${u.requests}` : ''}</div></div>
          <span class="chev">‹</span></button>`).join('') : `<div class="empty">${d.users.length ? 'לא נמצא משתמש 🤷' : '<div class="e">🌱</div>עוד אין משתמשים'}</div>`
      ulist.querySelectorAll('[data-user]').forEach(el => { el.onclick = () => openUser(el.dataset.user, async () => { d = await adminRpc('adminOverview'); draw() }) })
    }
    drawUsers()
    document.getElementById('usearch').oninput = e => { uq = e.target.value; drawUsers() }
    $app.querySelectorAll('[data-uf]').forEach(b => { b.onclick = () => { ufilter = b.dataset.uf; $app.querySelectorAll('[data-uf]').forEach(x => x.classList.toggle('on', x === b)); drawUsers() } })
    document.getElementById('bsend').onclick = async () => {
      const text = document.getElementById('bcast').value.trim()
      if (!text) return toast('כתבו הודעה')
      if (!await confirmBox('לשלוח לכל המשתמשים?', text.slice(0, 140), 'שליחה')) return
      try { const r = await adminRpc('adminMessage', { text }); toast(`📣 נשלח ל-${r.sent} משתמשים`); document.getElementById('bcast').value = '' } catch (e) { toast(e.message) }
    }
  }
  draw()
}

render()
