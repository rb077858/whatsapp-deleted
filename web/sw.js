// Notifications were replaced by an updates group in WhatsApp.
// Browsers that installed the old worker remove it here.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.registration.unregister()))
