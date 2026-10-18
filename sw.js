const CACHE_NAME = 'the-void-cache-v12';
const READINESS_MARKER = '__void_offline_readiness__';
const CORE_ASSETS = [
  './index.html',
  './history.html',
  './control.html',
  './offline.html',
  './assets/css/materialize.min.css',
  './assets/css/style.css',
  './assets/js/app.js',
  './manifest.json',
  './assets/fonts/InstrumentSerif-Regular.ttf',
  './assets/fonts/InstrumentSerif-Italic.ttf',
  './assets/fonts/Inter-VariableFont_opsz,wght.ttf',
  './assets/fonts/Inter-Italic-VariableFont_opsz,wght.ttf',
  './assets/fonts/IBMPlexMono-Regular.ttf',
  './assets/fonts/IBMPlexMono-Italic.ttf',
  './assets/fonts/IBMPlexMono-Bold.ttf',
  './assets/fonts/IBMPlexMono-BoldItalic.ttf',
  './assets/icons/the-void-icon-16.png',
  './assets/icons/the-void-icon-32.png',
  './assets/icons/the-void-icon-48.png',
  './assets/icons/the-void-icon-72.png',
  './assets/icons/the-void-icon-96.png',
  './assets/icons/the-void-icon-128.png',
  './assets/icons/the-void-icon-144.png',
  './assets/icons/the-void-icon-152.png',
  './assets/icons/the-void-icon-180.png',
  './assets/icons/the-void-icon-192.png',
  './assets/icons/the-void-icon-384.png',
  './assets/icons/the-void-icon-512.png',
  './assets/icons/the-void-maskable-192.png',
  './assets/icons/the-void-maskable-512.png',
  './assets/images/about-core-emblem.svg',
  './assets/images/about-monitor-down.svg',
  './assets/images/about-share.svg',
  './assets/images/about-wifi-off-desktop.svg',
  './assets/images/about-wifi-off-mobile.svg',
  './assets/images/about.svg',
  './assets/images/ask.svg',
  './assets/images/control-mic-off-desktop.svg',
  './assets/images/control-mic-off-mobile.svg',
  './assets/images/control-monitor.svg',
  './assets/images/control-slider-handle.svg',
  './assets/images/control-trash-desktop.svg',
  './assets/images/control-trash-mobile.svg',
  './assets/images/control-vibrate-desktop.svg',
  './assets/images/control-vibrate-mobile.svg',
  './assets/images/controls.svg',
  './assets/images/history-external-link.svg',
  './assets/images/history-read-aloud.svg',
  './assets/images/history-storage.svg',
  './assets/images/log.svg',
  './assets/images/mic.svg',
  './assets/images/offline-back-desktop.svg',
  './assets/images/offline-back-mobile.svg',
  './assets/images/offline-reassurance-desktop.svg',
  './assets/images/offline-reassurance-mobile.svg',
  './assets/images/offline-retry-desktop.svg',
  './assets/images/offline-retry-mobile.svg',
  './assets/images/orbit.svg',
  './assets/images/revealed-check-desktop.svg',
  './assets/images/revealed-check-mobile.svg',
  './assets/images/revealed-volume.svg',
  './assets/images/signal-bar.svg',
  './assets/images/supercomputer-a.jpg',
  './assets/images/the-void.png',
  './assets/images/vibrate.svg'
];

const readinessMarkerUrl = new URL(READINESS_MARKER, self.registration.scope).href;

const cacheCoreAssets = async (cache) => Promise.all(CORE_ASSETS.map(async (asset) => {
  const assetUrl = new URL(asset, self.registration.scope).href;
  const response = await fetch(new Request(assetUrl, { cache: 'reload' }));
  if (!response.ok || response.type !== 'basic') {
    throw new Error(`Unable to cache required asset: ${asset}`);
  }
  await cache.put(assetUrl, response);
}));

const notifyConnectionState = async (clientId, online) => {
  if (!clientId) {
    return;
  }

  try {
    const client = await self.clients.get(clientId);
    client?.postMessage({ type: 'VOID_CONNECTION_STATE', state: online ? 'online' : 'offline' });
  } catch {
    return;
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cacheCoreAssets(cache);
    const readiness = {
      version: CACHE_NAME,
      answerPools: './assets/js/app.js',
      coreAssets: CORE_ASSETS,
    };
    await cache.put(readinessMarkerUrl, new Response(JSON.stringify(readiness), {
      headers: { 'Content-Type': 'application/json' },
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'VOID_RETRY_OFFLINE_SETUP') {
    return;
  }

  event.waitUntil((async () => {
    let success = false;
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.delete(readinessMarkerUrl);
      await cacheCoreAssets(cache);
      const readiness = {
        version: CACHE_NAME,
        answerPools: './assets/js/app.js',
        coreAssets: CORE_ASSETS,
      };
      await cache.put(readinessMarkerUrl, new Response(JSON.stringify(readiness), {
        headers: { 'Content-Type': 'application/json' },
      }));
      success = true;
    } catch {
      const cache = await caches.open(CACHE_NAME);
      await cache.delete(readinessMarkerUrl);
    }

    event.source?.postMessage({
      type: 'VOID_OFFLINE_SETUP_RESULT',
      success,
      version: CACHE_NAME,
    });
  })());
});

self.addEventListener('activate', (event) => {
  console.log('Service worker activating...');

  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => {
            console.log('Removing old cache:', cacheName);
            return caches.delete(cacheName);
          })
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);
  if (requestUrl.searchParams.has('__void_connectivity_probe')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' })
      .then((response) => new Response(null, { status: response.ok ? 204 : 503 }))
      .catch(() => new Response(null, { status: 503 })));
    return;
  }

  event.respondWith(
    (async () => {
      const cachedResponse = await caches.match(event.request);
      if (cachedResponse) {
        return cachedResponse;
      }

      try {
        const networkResponse = await fetch(event.request);
        if (networkResponse.type === 'basic') {
          await notifyConnectionState(event.clientId, true);
          if (networkResponse.ok) {
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(event.request, networkResponse.clone()))
              .catch(() => undefined);
          }
        }
        return networkResponse;
      } catch {
        await notifyConnectionState(event.clientId, false);
        if (event.request.mode === 'navigate') {
          const offlinePage = await caches.match('./offline.html');
          if (offlinePage) {
            return offlinePage;
          }
        }

        const cachedFallback = await caches.match(event.request);
        if (cachedFallback) {
          return cachedFallback;
        }

        return new Response('This resource is not available offline.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })()
  );
});

