/* elizaOS service worker: coi-serviceworker + browser-resident Persistent
   Storage.

   Any request whose path contains /__persist/ (the guest's
   ELIZA_PERSIST_URL) never touches the network: PUT stores the sealed
   state blob in the Cache API, GET serves it back — so Persistent mode
   survives page reloads with no local server. Listener registered before
   the coi one; stopImmediatePropagation keeps coi from double-responding. */
if (typeof window === "undefined") {
    self.addEventListener("fetch", (e) => {
        const path = new URL(e.request.url).pathname;
        const i = path.indexOf("/__persist/");
        if (i < 0) return;
        e.stopImmediatePropagation();
        const key = "https://eliza-persist.local" + path.slice(i);
        e.respondWith((async () => {
            const cache = await caches.open("eliza-persist");
            if (e.request.method === "PUT") {
                const body = await e.request.arrayBuffer();
                await cache.put(key, new Response(body));
                return new Response("saved", { status: 200 });
            }
            return (await cache.match(key)) || new Response("not found", { status: 404 });
        })());
    });
}

/* (window side) Persistent Storage needs this SW even when the server
   already sends COOP/COEP (local serve.py): coi-serviceworker skips
   registration on already-isolated pages, so register explicitly. The
   activate handler claims clients, so the current page gets controlled
   without a reload. */
if (typeof window !== "undefined" && window.crossOriginIsolated &&
    navigator.serviceWorker && !navigator.serviceWorker.controller &&
    window.isSecureContext) {
    navigator.serviceWorker.register(document.currentScript.src);
}

/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless=!1;"undefined"==typeof window?(self.addEventListener("install",(()=>self.skipWaiting())),self.addEventListener("activate",(e=>e.waitUntil(self.clients.claim()))),self.addEventListener("message",(e=>{e.data&&("deregister"===e.data.type?self.registration.unregister().then((()=>self.clients.matchAll())).then((e=>{e.forEach((e=>e.navigate(e.url)))})):"coepCredentialless"===e.data.type&&(coepCredentialless=e.data.value))})),self.addEventListener("fetch",(function(e){const r=e.request;if("only-if-cached"===r.cache&&"same-origin"!==r.mode)return;const s=coepCredentialless&&"no-cors"===r.mode?new Request(r,{credentials:"omit"}):r;e.respondWith(fetch(s).then((e=>{if(0===e.status)return e;const r=new Headers(e.headers);return r.set("Cross-Origin-Embedder-Policy",coepCredentialless?"credentialless":"require-corp"),coepCredentialless||r.set("Cross-Origin-Resource-Policy","cross-origin"),r.set("Cross-Origin-Opener-Policy","same-origin"),new Response(e.body,{status:e.status,statusText:e.statusText,headers:r})})).catch((e=>console.error(e))))}))):(()=>{const e={shouldRegister:()=>!0,shouldDeregister:()=>!1,coepCredentialless:()=>!(window.chrome||window.netscape),doReload:()=>window.location.reload(),quiet:!1,...window.coi},r=navigator;r.serviceWorker&&r.serviceWorker.controller&&(r.serviceWorker.controller.postMessage({type:"coepCredentialless",value:e.coepCredentialless()}),e.shouldDeregister()&&r.serviceWorker.controller.postMessage({type:"deregister"})),!1===window.crossOriginIsolated&&e.shouldRegister()&&(window.isSecureContext?r.serviceWorker&&r.serviceWorker.register(window.document.currentScript.src).then((s=>{!e.quiet&&console.log("COOP/COEP Service Worker registered",s.scope),s.addEventListener("updatefound",(()=>{!e.quiet&&console.log("Reloading page to make use of updated COOP/COEP Service Worker."),e.doReload()})),s.active&&!r.serviceWorker.controller&&(!e.quiet&&console.log("Reloading page to make use of COOP/COEP Service Worker."),e.doReload())}),(r=>{!e.quiet&&console.error("COOP/COEP Service Worker failed to register:",r)})):!e.quiet&&console.log("COOP/COEP Service Worker not registered, a secure context is required."))})();
