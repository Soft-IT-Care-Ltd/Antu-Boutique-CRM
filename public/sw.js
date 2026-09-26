// Antu Boutique CRM service worker (P5.1). Deliberately small: it makes the
// app installable and shows an offline page when a phone loses signal.
//
// It never caches pages, API responses or uploads — they hold customer and
// money data, a shop phone is shared between staff, and a stale order list
// is worse than a clear "you're offline". Hashed /_next/static files are
// already cached by the browser (immutable), so they aren't handled here.
// Must parse on iOS Safari 15: plain ES2017, no optional chaining.

var VERSION = "antu-sw-1";
var OFFLINE_URL = "/offline.html";
var PRECACHE = [OFFLINE_URL, "/icons/icon-192.png"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches
      .open(VERSION)
      .then(function (cache) {
        return cache.addAll(PRECACHE);
      })
      .then(function () {
        return self.skipWaiting();
      }),
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key !== VERSION;
            })
            .map(function (key) {
              return caches.delete(key);
            }),
        );
      })
      .then(function () {
        if (self.registration.navigationPreload) return self.registration.navigationPreload.enable();
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  event.respondWith(
    (async function () {
      try {
        var preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(request);
      } catch (error) {
        var offline = await caches.match(OFFLINE_URL);
        return offline || Response.error();
      }
    })(),
  );
});
