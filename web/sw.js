// Service worker: shows push notifications and opens the right page when one is tapped.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))

self.addEventListener('push', e => {
  let d = {}
  try { d = e.data.json() } catch { d = { body: e.data ? e.data.text() : '' } }
  const actions = Array.isArray(d.actions) ? d.actions : []
  e.waitUntil(self.registration.showNotification(d.title || 'אל-מחיק 🧽', {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/badge.png',
    tag: d.tag,
    renotify: !!d.tag,
    lang: 'he',
    dir: 'rtl',
    requireInteraction: !!d.urgent,
    actions: actions.map(a => ({ action: a.action, title: a.title })),
    data: { url: d.url || '/app', actions }
  }))
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const data = e.notification.data || {}
  const chosen = (data.actions || []).find(a => a.action === e.action)
  const url = new URL((chosen && chosen.url) || data.url || '/app', self.location.origin).href
  e.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of windows) {
      if (new URL(w.url).origin === self.location.origin && 'navigate' in w) {
        await w.navigate(url)
        return w.focus()
      }
    }
    return self.clients.openWindow(url)
  })())
})
