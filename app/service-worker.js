"use strict";
// Momo — offline first.  The cache IS the app; the network is the fallback.
//
// Wer diese Datei liest, sieht den ganzen Plan: keine Magie, nur Caches
// und klare Regeln. Wer sie pruefen will, muss nichts glauben —
// Verifikation statt Vertrauen, auch bei uns.
const BUILD="k7m8d1";
const VERSION=`momo-1.0.0-${BUILD}`;
const CACHE_NAME=`momo-${VERSION}`;
const MODEL_CACHE="momo-model-v1";
const MODEL_VERSION="1c244444fd7b"; // Kurzform der Modelldatei; wechselt nur, wenn Momo neu gelernt hat
const APP_SHELL=[
"./",
"./account.js?v=h4j7k9m2p5",
"./admin-analytics.js?v=h4j7k9m2p5",
"./analytics-collector.js?v=h4j7k9m2p5",
"./app.js?v=h4j7k9m2p5",
"./artifacts.js?v=h4j7k9m2p5",
"./assets/apple-touch-icon.png",
"./assets/atom-logo-static.svg",
"./assets/atom-logo.svg",
"./assets/favicon-static.svg",
"./assets/favicon.png",
"./assets/icon-192-maskable.png",
"./assets/icon-192.png",
"./assets/icon-32.png",
"./assets/icon-512-maskable.png",
"./assets/icon-512.png",
"./assets/momo-app-icon.svg",
"./assets/momo-logo-email.gif",
"./assets/momo-logo-static.png",
"./auth.js?v=h4j7k9m2p5",
"./key-auth.js?v=h4j7k9m2p5",
"./sync.js?v=h4j7k9m2p5",
"./cloud-storage.js?v=h4j7k9m2p5",
"./momo-credits.js?v=h4j7k9m2p5",
"./momo/momo-preise.js?v=h4j7k9m2p5",
"./bootstrap-v24_8-ui2.js?v=h4j7k9m2p5",
"./branding.js?v=h4j7k9m2p5",
"./chat-ux.js?v=h4j7k9m2p5",
"./chats.js?v=h4j7k9m2p5",
"./vendor/edna.js?v=h4j7k9m2p5",
"./momo/edna-bridge.js?v=h4j7k9m2p5",
"./cloud-sync.js?v=h4j7k9m2p5",
"./config.js?v=h4j7k9m2p5",
"./core.js?v=h4j7k9m2p5",
"./cross-chat-user-context.js?v=h4j7k9m2p5",
"./currency.js?v=h4j7k9m2p5",
"./entitlements.js?v=h4j7k9m2p5",
"./features/momo-network-social/activity-bridge.js?v=h4j7k9m2p5",
"./features/momo-network-social/delivery-engine.js?v=h4j7k9m2p5",
"./features/momo-network-social/delivery-ui.js?v=h4j7k9m2p5",
"./features/momo-network-social/index.js?v=h4j7k9m2p5",
"./features/momo-network-social/integration-contract.json",
"./features/momo-network-social/momo-surface.js?v=h4j7k9m2p5",
"./features/momo-network-social/network-intelligence.js?v=h4j7k9m2p5",
"./features/momo-network-social/network-store.js?v=h4j7k9m2p5",
"./features/momo-switch/switch-core.js?v=h4j7k9m2p5",
"./features/momo-switch/switch-ui.js?v=h4j7k9m2p5",
"./features/momo-store/wallet-chain.js?v=h4j7k9m2p5",
"./features/momo-store/chat-dev.js?v=h4j7k9m2p5",
"./features/momo-store/store-core.js?v=h4j7k9m2p5",
"./vendor/ethers.esm.min.js?v=h4j7k9m2p5",
"./features/momo-store/store-ui.js?v=h4j7k9m2p5",
"./features/momo-plugins/plugins-ui.js?v=h4j7k9m2p5",
"./momo/momo-plugins.js?v=h4j7k9m2p5",
"./features/momo-timeline/timeline.css?v=h4j7k9m2p5",
"./features/momo-timeline/timeline.js?v=h4j7k9m2p5",
"./features/momo-timeline/fortschritt.js?v=h4j7k9m2p5",
"./momo/chat-overview.js?v=h4j7k9m2p5",
"./features/momo-network-social/network-sync.js?v=h4j7k9m2p5",
"./features/momo-network-social/presence-core.js?v=h4j7k9m2p5",
"./features/momo-network-social/relationship-memory.js?v=h4j7k9m2p5",
"./features/momo-network-social/relationship-products.js?v=h4j7k9m2p5",
"./features/momo-network-social/relevance-engine.js?v=h4j7k9m2p5",
"./features/momo-network-social/styles.css?v=h4j7k9m2p5",
"./features/momo-network-social/ui.js?v=h4j7k9m2p5",
"./features/momo-start/quellen.js?v=h4j7k9m2p5",
"./features/momo-start/likes.js?v=h4j7k9m2p5",
"./features/momo-start/start.js?v=h4j7k9m2p5",
"./features/momo-presence-bild/bild.js?v=h4j7k9m2p5",
"./features/momo-presence-bild/bild.css?v=h4j7k9m2p5",
"./features/momo-rooms/rooms.js?v=h4j7k9m2p5",
"./features/momo-start/start.css?v=1.0.3",
"./features/momo-start/likes.css?v=1.0.1",
"./features/momo-rooms/rooms.css?v=1.0.1",
"./file-knowledge.js?v=h4j7k9m2p5",
"./index.html",
"./library.js?v=h4j7k9m2p5",
"./loading-motion.js?v=h4j7k9m2p5",
"./locale-runtime.js?v=h4j7k9m2p5",
"./manifest.webmanifest",
"./momo/i18n/en.json",
"./momo/kontrast.css?v=h4j7k9m2p5",
"./momo/momo-chain.js?v=h4j7k9m2p5",
"./momo/momo-client.js?v=h4j7k9m2p5",
"./momo/momo-engine.js",
"./momo/momo-garten.js?v=h4j7k9m2p5",
"./momo/momo-hoeren-ui.js?v=h4j7k9m2p5",
"./momo/momo-hoeren.js?v=h4j7k9m2p5",
"./momo/momo-inference.js?v=h4j7k9m2p5",
"./momo/momo-analyse.js?v=h4j7k9m2p5",
"./momo/momo-kern.wasm",
"./momo/momo-kueche.js?v=h4j7k9m2p5",
"./momo/momo-lang.js?v=h4j7k9m2p5",
"./momo/momo-migrate.js?v=h4j7k9m2p5",
"./momo/momo-klang.js?v=h4j7k9m2p5",
"./momo/momo-musik.js?v=h4j7k9m2p5",
"./momo/momo-office.js?v=h4j7k9m2p5",
"./momo/momo-office-files.js?v=h4j7k9m2p5",
"./momo/momo-device.js?v=h4j7k9m2p5",
"./momo/momo-dictation.js?v=h4j7k9m2p5",
"./momo/momo-push.js?v=h4j7k9m2p5",
"./momo/momo-reflect.js?v=h4j7k9m2p5",
"./momo/momo-sprache.js?v=h4j7k9m2p5",
"./momo/momo-stars.js?v=h4j7k9m2p5",
"./momo/momo-theme.js?v=h4j7k9m2p5",
"./momo/momo-toepfern.js?v=h4j7k9m2p5",
"./momo/momo-tools.js?v=h4j7k9m2p5",
"./momo/momo-tools.json",
"./momo/momo-update.js?v=h4j7k9m2p5",
"./momo/momo-web.js?v=h4j7k9m2p5",
"./momo/momo-saite-worker.js?v=h4j7k9m2p5",
"./momo/momo.css?v=h4j7k9m2p5",
"./momo/theme-light.css?v=h4j7k9m2p5",
"./momo/theme-pop.css?v=h4j7k9m2p5",
"./momo/theme-metal.css?v=h4j7k9m2p5",
"./navigation.js?v=h4j7k9m2p5",
"./network-carpet-init.js?v=h4j7k9m2p5",
"./network-carpet.js?v=h4j7k9m2p5",
"./parallel-work.js?v=h4j7k9m2p5",
"./persistence.js?v=h4j7k9m2p5",
"./phase-chain.js?v=h4j7k9m2p5",
"./planned.js?v=h4j7k9m2p5",
"./polish.js?v=h4j7k9m2p5",
"./production.js?v=h4j7k9m2p5",
"./project-context.js?v=h4j7k9m2p5",
"./projects.js?v=h4j7k9m2p5",
"./push-notifications.js?v=h4j7k9m2p5",
"./pwa.js?v=h4j7k9m2p5",
"./reliability.js?v=h4j7k9m2p5",
"./renderer.js?v=h4j7k9m2p5",
"./search.js?v=h4j7k9m2p5",
"./security.js?v=h4j7k9m2p5",
"./settings.js?v=h4j7k9m2p5",
"./sidebar.js?v=h4j7k9m2p5",
"./sources.js?v=h4j7k9m2p5",
"./store.js?v=h4j7k9m2p5",
"./styles.css?v=h4j7k9m2p5",
"./supabase/magic-link-texte.json",
"./supabase/momo-email-texts.json",
"./supabase/momo-email.mjs",
"./supabase/momo-magic-link-email.alt.html.bak",
"./supabase/momo-magic-link-email.html",
"./ui.js?v=h4j7k9m2p5",
"./vendor/supabase.js",
"./momo/momo-tools.json?v=h4j7k9m2p5",
"./vendor/ethers-loader.js?v=h4j7k9m2p5",
"./momo-sdk.js?v=h4j7k9m2p5",
"./compression-local.js?v=h4j7k9m2p5",
"./bitseed-bridge.js?v=h4j7k9m2p5",
"./momo-data-chain.js?v=h4j7k9m2p5",
"./momo-guard.js?v=h4j7k9m2p5",
"./momo/i18n/sprachen.js?v=h4j7k9m2p5",
"./momo/i18n/dict.js?v=h4j7k9m2p5",
"./momo-i18n.js?v=h4j7k9m2p5",
"./momo/rtl.css?v=h4j7k9m2p5",
"./kompression/index.html",
"./kompression/manifest.json",
"./kompression/assets/bitseed-engine.js",
"./kompression/assets/bitseed-wasm.js",
"./kompression/assets/bitseed-wasm.wasm",
"./kompression/i18n.js",
"./kompression/gfx3d.js",
"./edna/index.html",
"./edna/i18n.js",
];
const NAV_FALLBACK="./index.html";

// Install: die ganze App in einen Cache legen. Wenn das hier durch ist,
// braucht Momo fuer den Start kein Netz mehr — das Geraet des Nutzers
// IST der Server.  Dezentralitaet faengt beim Offline-Koennen an.
// Harte Liveness-Garantie: jeder Asset-Fetch hat ein 5-s-Abort, und auch
// wenn der Gesamt-Precache haengt, wird der Install nach 12 s abgeschlossen
// (Teilcache + Runtime-Nachladen schlagen einen endlos haengenden SW).
self.addEventListener("install",event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE_NAME);
    const deadline=new Promise((_,rej)=>setTimeout(()=>rej(new Error("precache-timeout")),12000));
    const precache=Promise.all(APP_SHELL.map(async url=>{
      try{
        // Kein cache:"reload": Die Shell-URLs tragen ?v=Build-Hashes und aendern
        // sich eh bei jedem Deploy; der HTTP-Cache macht den Install deutlich
        // schneller (vorher >3,5s -> PWA-Timeout im Boot).
        const ctrl=new AbortController();
        const timer=setTimeout(()=>ctrl.abort(),5000);
        let response=null;
        try{
          response=await fetch(new Request(url,{credentials:"same-origin",signal:ctrl.signal}));
        }finally{clearTimeout(timer)}
        if(response&&response.ok)await cache.put(url,response.clone());
      }catch{}
    }));
    try{await Promise.race([precache,deadline])}catch{}
    await self.skipWaiting();
  })());
});

// Activate: alte Welten aufraeumen. Jede Version laesst ihren eigenen
// Cache zurueck; wer eine neue aktiviert, vernichtet die alten. Speicher
// auf dem Geraet des Nutzers ist kein Sammelbecken.
const LEGACY_CACHE="p"+"ha-"; // Caches aus der Zeit vor Momo
self.addEventListener("activate",event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>(k.startsWith(LEGACY_CACHE)||k.startsWith("momo-"))&&k!==CACHE_NAME&&k!==MODEL_CACHE).map(k=>caches.delete(k)));
    // Das Modell hängt am Dateinamen mit Versionskürzel (?v=…). Lernt Momo neu, wird die
    // neue Datei geholt - die alte blieb bisher für immer liegen, gut zehn Megabyte je
    // Fassung. Deshalb hier alles wegräumen, was nicht die aktuelle Fassung ist.
    try{
      const mc=await caches.open(MODEL_CACHE);
      for(const req of await mc.keys()){
        if(!req.url.includes(`v=${MODEL_VERSION}`)&&!req.url.includes("v=saiten148m-s5"))await mc.delete(req);
      }
    }catch{}
    await self.clients.claim();
    const clients=await self.clients.matchAll({type:"window",includeUncontrolled:true});
    clients.forEach(client=>client.postMessage({type:"MOMO_SW_ACTIVATED",version:VERSION}));
  })());
});

// CDN: Schriften und Bibliotheken einmal holen, dann ohne Netz liefern.
// Fremdes Material landet im lokalen Cache, nicht bei jedem Start neu
// vom Netz — Dritte bestimmen nicht, wann die App laeuft.
const CDN_CACHE="momo-cdn-v1";
const CDN_HOSTS=new Set(["fonts.googleapis.com","fonts.gstatic.com","unpkg.com","cdn.jsdelivr.net"]);
async function cdnResponse(request){
  // Schriften, Three.js etc.: einmal geladen, dann offline verfuegbar.
  const cache=await caches.open(CDN_CACHE);
  const cached=await cache.match(request);
  if(cached)return cached;
  try{
    const response=await fetch(request);
    if(response&&(response.ok||response.type==="opaque")){
      await cache.put(request,response.clone());
    }
    return response;
  }catch{
    return cached||Response.error();
  }
}

// Navigation: Netz zuerst, Cache als Rueckfall, ehrliches Scheitern zuletzt.
// Kein kuenstlicher Timeout, kein Vorwurf an den Nutzer — offline ist
// ein Zustand, kein Fehler.
async function navigationResponse(request){
  // KEIN kuenstlicher Zeitablauf mehr: der alte 2,5s-Wettlief brach langsame
  // Navigationen (z.B. Magic-Link-Weiterleitung aus der E-Mail) ab und meldete
  // faelschlich "Keine Verbindung". Erst wenn das Netz WIRKLICH scheitert,
  // greift der Cache — und erst wenn der auch leer ist, die Offline-Meldung.
  try{
    const network=await fetch(request);
    if(network&&network.ok){
      const cache=await caches.open(CACHE_NAME);
      await cache.put(request.url===self.location.origin+"/"?NAV_FALLBACK:request,network.clone());
      await cache.put(NAV_FALLBACK,network.clone());
      return network;
    }
  }catch{}
  const cached=await caches.match(request)||await caches.match(NAV_FALLBACK);
  return cached||new Response("Keine Verbindung. Die App-Shell ist offline verfügbar — lade die App einmal mit Verbindung, danach läuft sie komplett lokal.",{
    status:503,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}
  });
}

// Startseiten (Kompression/EDNA): Netz zuerst, Cache unter der originalen
// URL.  Bewusst KEIN NAV_FALLBACK-Eintrag — die App-Shell bleibt die App-Shell.
//
// Der Host antwortet in SW-Kontext mitunter mit der App-Shell (Fallback),
// obwohl curl dieselbe URL korrekt aufloest. Darum pruefen wir den Body:
// Nur was den Seitenmarker enthaelt, wird gecacht. Verseuchte Eintraege
// werden entfernt, damit nie wieder die falsche Seite gelaiefert wird.
async function navPageResponse(originalUrl,request,expected){
  const dbg={originalUrl,expected,when:Date.now()};
  const stow=async()=>{try{const dc=await caches.open(CACHE_NAME);await dc.put("navdebug-"+dbg.when,new Response(JSON.stringify(dbg)));}catch{}};
  try{
    const network=await fetch(request);
    dbg.netStatus=network&&network.status;
    if(network&&network.ok){
      const body=await network.clone().text();
      dbg.netSize=body.length;dbg.netHasMarker=body.includes(expected);
      if(body.includes(expected)){
        const cache=await caches.open(CACHE_NAME);
        await cache.put(originalUrl,network.clone());
        return network;
      }
      // Falsches Dokument (App-Shell) — einmal ohne Cache-Hint erneut.
      const retry=await fetch(request,{cache:"no-store"}).catch(e=>{dbg.retryErr=String(e);return null});
      dbg.retryStatus=retry&&retry.status;
      if(retry&&retry.ok){
        const retryBody=await retry.clone().text();
        dbg.retrySize=retryBody.length;dbg.retryHasMarker=retryBody.includes(expected);
        if(retryBody.includes(expected)){
          const cache=await caches.open(CACHE_NAME);
          await cache.put(originalUrl,retry.clone());
          return retry;
        }
      }
      // Kein korrektes Dokument erreichbar. Verseuchten Eintrag entfernen,
      // damit nie wieder die falsche Seite ausgeliefert wird.
      const cache=await caches.open(CACHE_NAME);
      await cache.delete(originalUrl);
      dbg.gave="wrongdoc";await stow();
      return new Response("Laden fehlgeschlagen: Der Host lieferte die falsche Seite. Bitte einmal neu laden.",{
        status:503,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}
      });
    }
  }catch(e){dbg.err=String(e)}
  const cached=await caches.match(originalUrl);
  dbg.gave=cached?"cached":"offline503";dbg.cachedSize=cached?(await cached.clone().text()).length:0;await stow();
  return cached||new Response("Keine Verbindung. Die Seite ist offline verfuegbar, sobald sie einmal mit Verbindung geladen wurde.",{
    status:503,headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}
  });
}

// Schneller Start: sofort aus dem Cache, im Hintergrund aktualisieren.
// Latenz ist auch eine Form von Respekt — Antworten wartet niemand gern.
// Der Host sendet `max-age=14400`: Ohne no-cache kaeme aus dem Browser-HTTP-
// Cache bis zu vier Stunden altes Material in den SW-Cache — Deploys waeren
// unsichtbar. no-cache revalidiert per ETag (304 ist billig).
async function staleWhileRevalidate(event,request){
  const cache=await caches.open(CACHE_NAME);
  const cached=await cache.match(request);
  const update=fetch(request,{cache:"no-cache"}).then(response=>{
    if(response&&response.ok)cache.put(request,response.clone()).catch(()=>{});
    return response;
  }).catch(()=>null);
  if(cached){event.waitUntil(update);return cached}
  const fresh=await update;
  return fresh||Response.error();
}

// Cache-first: unveraenderliches Material (Version im Dateinamen) kommt
// direkt aus dem Geraet.  Was sich nie aendert, muss nie wieder ueber
// das Netz.
async function cacheFirst(request,cacheName=CACHE_NAME,event=null){
  const cache=await caches.open(cacheName);
  const cached=await cache.match(request,{ignoreSearch:false});
  if(cached)return cached;
  try{
    const response=await fetch(request);
    if(response&&response.ok){
      // **Nicht abwarten.** Vorher stand hier `await cache.put(...)`: die Antwort ging
      // erst weiter, wenn die ganze Datei im Cache lag. Bei Momos neun Megabyte hiess das
      // auf dem Handy eine halbe Minute, in der die Seite kein einziges Byte sah und
      // deshalb auch keinen Fortschritt zeigen konnte.  Jetzt fliesst sie sofort durch und
      // wird nebenher abgelegt; `waitUntil` hält den Service Worker so lange am Leben.
      const ablegen=cache.put(request,response.clone()).catch(()=>{});
      if(event&&event.waitUntil)event.waitUntil(ablegen);
    }
    return response;
  }catch{
    return Response.error();
  }
}

function parsePushPayload(event){
  try{return event.data?.json?.()||{}}catch{
    try{return {body:event.data?.text?.()||""}}catch{return {}}
  }
}

// Push: eine Nachricht annehmen ist erlaubt — sie oeffnet nichts und
// sendet nichts.  Der Klick entscheidet, nicht der Server.
self.addEventListener("push",event=>{
  const payload=parsePushPayload(event);
  const title=String(payload.title||"Momo").slice(0,120);
  const body=String(payload.body||"").slice(0,420);
  const kind=String(payload.kind||"personal");
  const url=String(payload.url||"./?view=chat");
  const tag=String(payload.tag||`momo:${kind}:${Date.now()}`).slice(0,180);
  event.waitUntil(self.registration.showNotification(title,{
    body,tag,renotify:Boolean(payload.renotify),icon:"./assets/icon-192.png",badge:"./assets/icon-32.png",
    data:{url,kind,pushId:payload.pushId||null},
    actions:[{action:"open",title:String(payload.openLabel||"Öffnen").slice(0,40)},{action:"later",title:String(payload.laterLabel||"Später").slice(0,40)}]
  }));
});

// Klick auf die Mitteilung: ins Offene lenken, nichts hinterherlaufen.
self.addEventListener("notificationclick",event=>{
  event.notification.close();
  if(event.action==="later")return;
  const raw=String(event.notification?.data?.url||"./?view=chat");
  const target=new URL(raw,self.location.origin).href;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:"window",includeUncontrolled:true});
    const sameOrigin=windows.filter(c=>{try{return new URL(c.url).origin===self.location.origin}catch{return false}});
    const client=sameOrigin.find(c=>"focus" in c)||null;
    if(client){
      try{client.postMessage({type:"MOMO_PUSH_NAVIGATE",url:target,kind:event.notification?.data?.kind||""})}catch{}
      try{if("navigate" in client)await client.navigate(target)}catch{}
      try{return await client.focus()}catch{return client}
    }
    return self.clients.openWindow?self.clients.openWindow(target):null;
  })());
});

// Fetch-Routing: jede Anfrage bekommt genau eine Strategie.
// Regel vor Routine — sonst entscheidet der Zufall.
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET")return;
  const url=new URL(request.url);
  // CDN-Assets (Schriftarten, Three.js): cachen, damit die App komplett offline oeffnet
  if(CDN_HOSTS.has(url.host)){event.respondWith(cdnResponse(request));return}
  if(url.origin!==self.location.origin)return;
  // Kompressions- und EDNA-Startseiten: Navigationen immer frisch vom Netz,
  // Assets (Engine, gfx, i18n) offline-faehig aus dem Cache.
  // Der statische Host loest Verzeichnis-URLs nicht auf — /kompression/ kaeme
  // als 404 zurueck und wuerde faelschlich auf die App-Shell fallen. Also
  // haengen wir index.html selbst an; die Regel ist deterministisch.
  if(url.pathname.startsWith("/kompression/")||url.pathname.startsWith("/edna/")){
    if(request.mode==="navigate"){
      // Nur anhaengen, wenn der Pfad ein Verzeichnis ist. Ruft der Browser
      // die Seite direkt als /edna/index.html auf, darf kein zweites
      // /index.html angehaengt werden — sonst 404 vom Host.
      let p=url.pathname.replace(/\/$/,"");
      if(!p.endsWith(".html"))p+="/index.html";
      const idx=new URL(p+url.search,url.origin);
      const expected="data-gfx";
      // Absichtlich OHNE Origin-Header-Mitgabe: In SW-Kontext liefert der
      // Host mit kopierten Headern manchmal die App-Shell statt der Seite.
      event.respondWith(navPageResponse(request.url,new Request(idx),expected));
      return
    }
    if(url.pathname.endsWith(".js")||url.pathname.endsWith(".css")||url.pathname.endsWith(".html")){event.respondWith(cacheFirst(request));return}
  }
  if(request.mode==="navigate"){event.respondWith(navigationResponse(request));return}
  // Momos Saite ist gross und unveränderlich (Version im Dateinamen/Query) → einmal laden, dann offline
  if(url.pathname.endsWith(".wav")){event.respondWith(cacheFirst(request,MODEL_CACHE,event));return}
  // Die Saiten-Gewichte (mehrere hundert MB) ebenfalls: einmal laden, dann offline verfügbar
  if(url.pathname.includes("/models/")&&url.pathname.endsWith(".bin")){event.respondWith(cacheFirst(request,MODEL_CACHE,event));return}
  // Der Rechenkern ist eine .wasm-Datei.  Ohne diese Zeile fällt sie durch alle
  // Raster und wird direkt aus dem Netz geholt - ohne Netz also gar nicht.
  if(url.pathname.endsWith(".wasm")){event.respondWith(cacheFirst(request));return}
  if(url.pathname.endsWith("/service-worker.js"))return;
  const isCode=["script","style","manifest","worker"].includes(request.destination)||url.pathname.endsWith(".json")||url.pathname.endsWith(".js")||url.pathname.endsWith(".css");
  // Dateien mit Versionsangabe (?v=Build): stale-while-revalidate — der
  // Cache beschleunigt den Start, das Netz aktualisiert ihn im Hintergrund.
  // (Frueher cache-first: Wiederholte Deploys unter derselben ?v= sind dann
  // unsichtbar geblieben — genau der Fehler, der das alte E-Mail-Login am
  // Leben hielt.  Jetzt heilt sich der Cache nach jedem einzelnen Laden.)
  if(isCode&&url.searchParams.has("v")){event.respondWith(staleWhileRevalidate(event,request));return}
  if(isCode){event.respondWith(staleWhileRevalidate(event,request));return}
  if(["image","font"].includes(request.destination)){event.respondWith(cacheFirst(request))}
});

// Nachrichten aus der App: zwei Befehle, mehr nicht. Kontrolle bleibt
// beim Client, der Service Worker gehorcht nur.
self.addEventListener("message",event=>{
  const data=event.data||{};
  if(data.type==="SKIP_WAITING"){
    self.skipWaiting();
    return;
  }
  if(data.type==="GET_VERSION"){
    event.ports?.[0]?.postMessage({type:"VERSION",version:VERSION,cache:CACHE_NAME});
  }
});
