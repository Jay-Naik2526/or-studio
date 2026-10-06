/* OR-Studio service worker.
 *  - page loads (navigations): network first, so a new version is picked up immediately; cached copy when offline
 *  - hashed build assets: cache first (they never change); a failed request is a failed request — never answered with HTML
 */
const CACHE = 'or-studio-v5';
// A script, style, font, image or worker request must never be answered (or cached) with an HTML document:
// a host that rewrites unknown paths to index.html would otherwise poison the cache with a page where code is expected.
const isHtml = res => /text\/html/i.test(res.headers.get('content-type') || '');
const NON_DOC = new Set(['script', 'style', 'font', 'image', 'worker', 'sharedworker', 'manifest']);
const cacheable = (req, res) => res.ok && res.status === 200 && res.type === 'basic' && !(NON_DOC.has(req.destination) && isHtml(res));
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './index.html', './icon.svg', './manifest.webmanifest']).catch(() => undefined))); });
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      // pages still open on an older build would request files that no longer exist: reload them onto this build
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(cs => cs.forEach(c => { try { c.navigate(c.url); } catch (_) { /* ignore */ } }))
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.headers.has('range') || new URL(req.url).pathname.endsWith('/sw.js')) return; // let the browser handle these directly
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => { if (cacheable(req, res) && isHtml(res)) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => undefined); } return res; }).catch(() => caches.match('./index.html').then(hit => hit || Response.error())));
    return;
  }
  e.respondWith(
    caches.match(req).then(hit => (hit && !(NON_DOC.has(req.destination) && isHtml(hit)) ? hit : fetch(req).then(res => { if (cacheable(req, res)) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => undefined); } return res; })))
  );
});
