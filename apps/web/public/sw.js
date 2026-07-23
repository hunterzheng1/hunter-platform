/* global self, URL, fetch */

const SENSITIVE_PREFIXES = [
  "/api",
  "/events",
  "/auth",
  "/devices",
  "/pair",
  "/refresh",
  "/commands",
];
const STATIC_DESTINATIONS = new Set(["font", "image", "manifest", "script", "style"]);

function hasSensitivePath(pathname) {
  return SENSITIVE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isStaticRequest(request, url) {
  return STATIC_DESTINATIONS.has(request.destination)
    || url.pathname.startsWith("/assets/")
    || url.pathname.startsWith("/icons/")
    || url.pathname === "/manifest.webmanifest";
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET"
    || url.origin !== self.location.origin
    || request.headers.has("authorization")
    || hasSensitivePath(url.pathname)
    || !isStaticRequest(request, url)
  ) {
    return;
  }
  event.respondWith(fetch(request, { cache: "no-store", credentials: "omit" }));
});
