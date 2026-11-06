"use strict";
/* Momo AI — App-Kern und Boot-Reihenfolge.
 *
 * Das Boot folgt einem einfachen Prinzip: erst das, was der Nutzer sofort
 * sieht, dann der Rest.  Kern-Module schlagen fehl-abgeschlossen (fail
 * closed) — ein kaputter Kern darf nie als fertig durchgehen. Optionale
 * Module (Auth, Push, Cloud) duerfen spaeter nachziehen; sie entscheiden nicht
 * ueber die Bereitschaft des Chat.  So bleibt Momo auch ohne
 * Netz, ohne Account und ohne Glueck eine lokal laufende App. */
(function(ns){
  const viewMeta={
    chat:["Momo","OpenOS — lokal, privat, nach Verbrauch"],
    projects:["Projekte","Arbeitsräume"],
    library:["Bibliothek","Daten nur auf diesem Gerät"],
    planned:["Geplant","Veröffentlichungen planen"],
    plugins:["Plugins","Werkzeuge für Momo freischalten"],
    coding:["Coding Work","mit Momo programmieren"],
    apps:["Apps","Eigene Momo-Apps"],
    archived:["Archiviert","Chats auf diesem Gerät"],
    account:["Account","Momo Identity"],
    pricing:["Pricing","1 Credit = USD 0,009 · alles nach Verbrauch"],
    "network-start":["Start","Alles, was im Netzwerk öffentlich ist"],
    "network-room":["Rooms","Themen-Räume mit Momo als Moderator"],
    settings:["Einstellungen","Momo · Chain · Wallet · Push"],
    edna:["EDNA","Wahrnehmung, die respektiert — lokal, einwilligungsbasiert"],system:["System","OpenOS auf jedem Gerät installieren — inklusive OldNet Browser"],compression:["Kompression","Bitseed Compression — Daten komprimieren, nichts geht verloren"]
  };

  let requestedView=null;

  /* Der Ladebildschirm ist ehrlich: Er sagt, was gerade passiert, und er
   * geht erst, wenn die App wirklich benutzbar ist. Keine Drehung um der
   * Drehung willen. */
  const bootScreen={
    update(label,progress,detail){
      const text=document.getElementById("momoLoadingText");
      const bar=document.getElementById("momoLoadingProgress");
      const sub=document.getElementById("momoLoadingDetail");
      if(text&&label)text.textContent=label;
      if(Number.isFinite(progress)){
        if(window.MomoLoadingMotion?.setTarget)window.MomoLoadingMotion.setTarget(progress);
        else if(bar)bar.style.width=`${Math.max(4,Math.min(100,progress))}%`;
      }
      if(sub&&detail!=null)sub.textContent=detail;
    },
    finish(){
      const screen=document.getElementById("momoLoadingScreen");
      const app=document.getElementById("app");
      this.update("Momo ist bereit",100,"OpenOS — lokal, privat, nach Verbrauch");
      let revealed=false;
      const reveal=()=>{
        if(revealed)return;
        revealed=true;
        document.body.classList.remove("momo-booting");
        document.body.setAttribute("aria-busy","false");
        if(app){app.inert=false;app.removeAttribute("inert");app.setAttribute("aria-hidden","false")}
        if(screen){
          screen.setAttribute("aria-busy","false");
          requestAnimationFrame(()=>screen.classList.add("is-complete"));
          setTimeout(()=>screen.remove(),360);
        }
      };
      if(window.MomoLoadingMotion?.complete){window.MomoLoadingMotion.complete(reveal);setTimeout(reveal,900)}
      else reveal();
    },
    fail(error){
      const screen=document.getElementById("momoLoadingScreen");
      const reload=document.getElementById("momoLoadingReload");
      window.MomoLoadingMotion?.fail?.();
      if(screen){screen.classList.add("is-error");screen.setAttribute("role","alert");screen.setAttribute("aria-busy","false")}
      this.update("Start fehlgeschlagen",100,error?.message||"Momo konnte nicht vollständig geladen werden.");
      reload?.classList.remove("hidden");
      reload?.addEventListener("click",()=>location.reload(),{once:true});
    }
  };

  const nextPaint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  function windowLoaded(){
    if(document.readyState==="complete")return Promise.resolve();
    return new Promise(resolve=>window.addEventListener("load",resolve,{once:true}));
  }
  function settleWithin(promise,ms){
    return Promise.race([
      Promise.resolve(promise),
      new Promise(resolve=>setTimeout(resolve,ms))
    ]);
  }
  async function waitForImages(){
    const images=[...document.images];
    await Promise.all(images.map(img=>{
      if(img.complete&&img.naturalWidth>0)return img.decode?.().catch(()=>{})||Promise.resolve();
      return new Promise(resolve=>{
        const done=()=>resolve();
        img.addEventListener("load",done,{once:true});
        img.addEventListener("error",done,{once:true});
        setTimeout(done,700);
      });
    }));
  }
  async function waitForFullAvailability(){
    bootScreen.update("Webseite wird vollständig geladen …",94,"Assets, Fonts und Oberfläche werden geprüft");
    // Fonts, icons and late analytics must not hold the usable local chat.
    await settleWithin(windowLoaded(),1200);
    if(document.fonts?.ready)await settleWithin(document.fonts.ready,500);
    await settleWithin(waitForImages(),800);
    await nextPaint();

    const chatInner=document.getElementById("chatInner");
    const chatInput=document.getElementById("chatInput");
    const sendBtn=document.getElementById("sendBtn");
    const chatView=document.getElementById("view-chat");
    // Der Hintergrund ist Schmuck. Er startet jetzt bewusst erst, wenn die Seite fertig
    // ist - und darf deshalb nicht darüber entscheiden, ob die App bereit ist.  Vorher
    // hing die Startprüfung daran und schlug fehl, sobald der Teppich später kam.
    const chatReady=Boolean(chatInner&&chatInner.childElementCount>0&&chatInput&&sendBtn&&chatView);
    const runtimeReady=Boolean(ns.inference&&ns.momo&&ns.store&&ns.chats);
    if(!chatReady)throw new Error("Der Chat wurde nicht vollständig gerendert.");
    if(!runtimeReady)throw new Error("Die Momo Chat-Runtime ist noch nicht verfügbar.");
    return true;
  }

  /* Eine Ansicht kaputt — nicht leer zeigen. Wer eine Seite oeffnet und
   * nichts sieht, verliert das Vertrauen schneller als durch jede Fehlermeldung.
   * Deshalb: Fallback-Karte mit einem echten „Erneut laden"-Knopf. */
  function ensureViewContent(name){
    if(name==="settings"){
      const host=document.getElementById("settingsContent");
      try{ns.settings?.render?.()}
      catch(error){
        ns.core?.reportError?.(error,{scope:"view:settings",silent:true});
        if(host&&!host.innerHTML.trim())host.innerHTML='<section class="settings-card"><div class="eyebrow">EINSTELLUNGEN</div><h3>Momo Einstellungen</h3><p>Die Einstellungen werden erneut geladen.</p><button class="action-btn" id="viewSettingsRetry">Erneut laden</button></section>';
        document.getElementById("viewSettingsRetry")?.addEventListener("click",()=>ensureViewContent("settings"));
      }
      return;
    }

    if(name==="account"){
      const host=document.getElementById("accountContent");
      try{ns.billing?.renderAccount?.()}
      catch(error){
        ns.core?.reportError?.(error,{scope:"view:account",silent:true});
        if(host&&!host.innerHTML.trim())host.innerHTML='<div class="account-shell"><section class="account-card"><div class="eyebrow">MOMO ACCOUNT</div><h2>Account</h2><p>Account wird initialisiert.</p><button class="action-btn" id="viewAccountRetry">Erneut laden</button></section></div>';
        document.getElementById("viewAccountRetry")?.addEventListener("click",()=>ensureViewContent("account"));
      }
      return;
    }

    if(name==="pricing"){
      const host=document.getElementById("pricingContent");
      try{ns.billing?.renderPricing?.()}
      catch(error){
        ns.core?.reportError?.(error,{scope:"view:pricing",silent:true});
        if(host&&!host.innerHTML.trim())host.innerHTML='<div class="account-shell"><section class="account-card"><div class="eyebrow">MOMO PRICING</div><h2>Pricing wird geladen</h2><p>Plan- und Produktinformationen werden erneut geladen.</p><button class="action-btn" id="viewPricingRetry">Erneut laden</button></section></div>';
        document.getElementById("viewPricingRetry")?.addEventListener("click",()=>ensureViewContent("pricing"));
      }
    }
  }

  function activeView(){
    if(ns.navigation?.activeView)return ns.navigation.activeView();
    const current=[...document.querySelectorAll(".view")].find(v=>!v.classList.contains("hidden"));
    return current?.id?.replace(/^view-/,"")||"chat";
  }

  /* Der zentrale Torschlag. Drei Pruefungen, bevor eine Seite wechselt:
   * 1. Namen normalisieren — alte Ansichten leben als Alias weiter.
   * 2. Guard: Funktionsseiten verlangen Login, Features verlangen Freischaltung.
   * 3. Erst dann zeichnen. Wer nicht durch darf, sieht Account oder das
   *    Gate — nie eine halbe Seite. */
  function openView(name,{remember=true}={}){
    if(name==="tasks")name="chat";
    name=String(name||"chat").trim()||"chat";
    // Alte Namen (Match, Suggests, Bubble, Tarot) auf die neuen Seiten lenken — siehe navigation.js
    try{name=ns.navigation?.normalize?.(name)||name}catch{}
    // Harter Schutz: Funktionsseiten nur mit Login — sonst Account-Seite.
    if(ns.guard&&!ns.guard.viewErlaubt(name))return false;
    if(remember)requestedView=name;
    const feature=name==="projects"?"projects":name==="planned"?"planned":name==="coding"?"coding-work":name==="apps"?"momo-apps":null;
    // Suggests+ ist absichtlich nicht in dieser Liste: anschauen darf jeder (23.09.).
    // Account + Credits verlangt erst das Starten einer Kampagne (pushCampaign, credits.js).
    if(feature&&ns.entitlements&&!ns.entitlements.can(feature)){
      try{ns.entitlements.showGate(feature)}catch(error){ns.core?.reportError?.(error,{scope:"view:gate",silent:true})}
      return false;
    }
    const target=document.getElementById("view-"+name);
    if(!target)return false;
    const navigationShown=ns.navigation?.applyViewState?.(name,{remember});
    if(navigationShown===false)return false;
    if(navigationShown==null){
      document.querySelectorAll(".view").forEach(v=>v.classList.add("hidden"));
      target.classList.remove("hidden");
      document.querySelectorAll("[data-view]").forEach(btn=>btn.classList.toggle("active",btn.dataset.view===name));
    }
    const meta=viewMeta[name]||["Momo",""];
    const title=document.getElementById("pageTitle");
    const subtitle=document.getElementById("pageSubtitle");
    if(title)title.textContent=meta[0];
    if(subtitle)subtitle.textContent=meta[1];
    try{
      if(name==="projects")ns.projects?.render?.();
      if(name==="library")ns.library?.render?.();
      if(name==="planned")ns.planned?.render?.();
      if(name==="archived")ns.chats?.renderArchived?.();
      if(name==="account"||name==="pricing"||name==="settings")ensureViewContent(name);
    }catch(error){ns.core?.reportError?.(error,{scope:`view:${name}:render`,silent:true})}
    try{if(window.matchMedia("(max-width:720px)").matches)ns.sidebar?.setOpen?.(false)}catch{}
    try{ns.polish?.updateView?.(name,meta)}catch(error){ns.core?.reportError?.(error,{scope:`view:${name}:polish`,silent:true})}
    try{updateProjectChip()}catch(error){ns.core?.reportError?.(error,{scope:`view:${name}:project-chip`,silent:true})}
    return true;
  }

  function updateProjectChip(){
    const chip=document.getElementById("projectChip");
    if(!chip||!ns.store)return;
    const s=ns.store.activeSession();
    if(s?.temporary){chip.textContent="Temporär";chip.classList.remove("hidden");return}
    const projectId=s?.projectId||null;
    const p=projectId?ns.store.project(projectId):null;
    if(p){
      chip.textContent=p.name;
      chip.classList.remove("hidden");
      chip.dataset.projectId=p.id;
    }else{
      chip.classList.add("hidden");
      chip.textContent="";
      delete chip.dataset.projectId;
    }
  }

  function withTimeout(promise,ms,label){
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error(`${label} timeout after ${ms}ms`)),ms))
    ]);
  }

  /* Der Start darf nie auf einen Service Worker, einen Beweis-Fetch oder
   * einen Speicheranbieter warten. Kern-Module bleiben fehlergeschlossen;
   * optionale Module duerfen fertig werden, nachdem der Chat benutzbar ist.
   * Ein Haenger im Netz ist kein Grund, die App lahmzulegen — offline ist
   * der Normalfall, nicht die Ausnahme. */
  function bootModule(name,initializer,{required=true,timeout=6000}={}){
    return ns.core.initModule(name,()=>withTimeout(initializer(),timeout,name),{required});
  }

  /* Optionales Modul im Hintergrund starten: Erfolg oder Fehler werden
   * gemeldet, aber nie blockiert. */
  function startBackgroundModule(name,initializer,{timeout=4500}={}){
    void bootModule(name,initializer,{required:false,timeout});
  }

  /* Cloud-Module nachziehen lassen — Account, Billing und Push gehoeren zum
   * Komfort, nicht zur Bereitschaft. Ohne Netz startet Momo trotzdem, nur
   * diese Faehigkeiten melden sich spaeter. */
  async function initOptionalCloudModules(){
    try{
      // Auth läuft bereits seit dem frühen Boot — hier nur noch den Stand lesen,
      // nicht ein zweites Mal initialisieren (initModule dedupliziert nicht).
      const authReady=Boolean(ns.auth?.currentSession?.());
      ns.core.setCapability("authModuleReady",Boolean(authReady));
      ns.core.setCapability("signedIn",Boolean(ns.auth?.currentSession?.()));
      const [accountReady,billingReady]=await Promise.all([
        ns.core.initModule("account",()=>withTimeout(ns.account?.init?.(),3500,"Account"),{required:false}),
        ns.core.initModule("billing",()=>withTimeout(ns.billing?.init?.(),3500,"Billing"),{required:false})
      ]);
      const pushReady=await ns.core.initModule("push-notifications",()=>withTimeout(ns.pushNotifications?.init?.(),4500,"Push"),{required:false});
      ns.core.setCapability("accountModuleReady",Boolean(accountReady));
      ns.core.setCapability("billingUIReady",Boolean(billingReady));
      ns.core.setCapability("pushModuleReady",Boolean(pushReady));
      if(activeView()==="account")ensureViewContent("account");
      if(activeView()==="pricing")ensureViewContent("pricing");
      return {authReady,accountReady,billingReady,pushReady};
    }catch(err){
      ns.core.reportError(err,{scope:"optional-cloud",silent:true});
      return {authReady:false,accountReady:false,billingReady:false};
    }
  }

  // After the first visit Momo lives in device storage and is never fetched
  // again. But without explicit permission the browser may evict that storage
  // whenever space is tight — then the user would reload nine megabytes again.
  // So the permission is asked exactly when it is most likely granted: as soon
  // as Momo is really there.  Once per device, silently, without a banner.
  // The button in settings stays, in case the browser said no here.  Ask when
  // the value is proven, not at the front door.
  let geraetespeicherGefragt=false;
  function sichereMomoAufDemGeraet(){
    if(geraetespeicherGefragt)return;
    geraetespeicherGefragt=true;
    try{
      if(localStorage.getItem("momo:geraetespeicher")==="1")return;
    }catch(_){/* ohne localStorage einfach fragen */}
    if(!navigator.storage?.persist)return;
    navigator.storage.persisted?.().then(schon=>{
      if(schon){ns.core?.setCapability?.("persistentStorage",true);return true}
      return ns.store?.requestPersistentStorage?.();
    }).then(ok=>{
      if(!ok)return;
      try{localStorage.setItem("momo:geraetespeicher","1")}catch(_){}
    }).catch(()=>{});
  }

  // Momos Zustand in Seitenleiste und Kopfzeile zeigen
  function momoStatusUI(st){
    const stats=document.getElementById("engineStats");
    const conn=document.getElementById("connectionText");
    const busy=document.getElementById("connectionStatus")?.classList.contains("busy");
    const i=st?.info;
    const fmt=n=>new Intl.NumberFormat("de-CH").format(Number(n)||0);
    if(st?.status==="ready"&&i){
      const ueT=(s)=>ns.i18n?.t?.(s)||s;
      if(stats)stats.textContent=`${(Number(i.modes)||0)/1e6>=0.05?((Number(i.modes)||0)/1e6).toFixed(1).replace(".",","):"—"} ${ueT("Mio. Obertöne")} · ${fmt(i.memoryNumbers)} ${ueT("Gedächtniszahlen")}`;
      if(conn&&!busy)conn.textContent=navigator.onLine===false?"MOMO · KEINE VERBINDUNG":"MOMO · BEREIT";
      document.documentElement.dataset.momo="ready";
      sichereMomoAufDemGeraet();
    }else if(st?.status==="error"){
      if(stats)stats.textContent="Momo konnte nicht starten";
      if(conn&&!busy)conn.textContent="MOMO · FEHLER";
      document.documentElement.dataset.momo="error";
    }else{
      const pct=Math.round((st?.progress||0)*100);
      if(stats)stats.textContent=`Saite wird gestimmt … ${pct} %`;
      if(conn&&!busy)conn.textContent="MOMO";
      document.documentElement.dataset.momo="loading";
    }
    const title=document.querySelector(".sidebar-engine-title");
    if(title)title.textContent="Momo";
  }

  async function init(){
    try{
      bootScreen.update("Momo startet …",8,"Deine lokale KI von OpenOS");
      if(!ns.core)throw new Error("Momo Kern fehlt.");
      ns.core.requireDOM([
        "app","sidebar","chatInput","chatInner","chatScroll","sessionList",
        "projectContent","connectionText","engineStats","pageTitle","pageSubtitle"
      ]);
      if(!ns.persistence)throw new Error("Momo Speicher fehlt.");
      if(!ns.store)throw new Error("Momo Workspace fehlt.");
      if(!ns.inference||!ns.momo||!ns.momoTools)throw new Error("Momo fehlt.");

      // Momo startet sofort im Hintergrund-Thread — die Oberfläche wartet nicht darauf.
      ns.momo.subscribe(momoStatusUI);
      const momoStart=()=>ns.momo.start().catch(error=>ns.core?.reportError?.(error,{scope:"momo:start",silent:true}));
      // Das Modell auf dem Geraet nur hochfahren, wenn es schon heruntergeladen
      // ist — sonst laedt niemand ungefragt mehrere hundert Megabyte.
      ns.momoWebLLM?.autoLaden?.().catch(()=>{});
      if("requestIdleCallback" in window)requestIdleCallback(momoStart,{timeout:600});else setTimeout(momoStart,120);

      bootScreen.update("Deine Daten werden geladen …",22,"Chats und Einstellungen bleiben auf diesem Gerät");
      /* Auth frueh starten (Hintergrund, blockiert nicht): Credits, Guard,
       * Push, Plugins und Desktop-Zugriff lesen den Anmeldestand — ist er
       * noch nicht da, gilt ein angemeldeter Nutzer bis zum Neuladen als
       * Gast. Der erste Eindruck darf nicht vom Netz abhaengen. */
      startBackgroundModule("auth",()=>ns.auth?.init?.(),{timeout:6000});
      await bootModule("persistence",()=>ns.persistence.init(),{timeout:5000});
      await bootModule("store",()=>ns.store.ready(),{timeout:6000});
      await bootModule("reliability",()=>ns.reliability.init(),{timeout:5000});
      startBackgroundModule("pwa",()=>ns.pwa.init(),{timeout:8000});
      startBackgroundModule("production",()=>ns.production?.init?.());
      await bootModule("polish",()=>ns.polish.init(),{timeout:4000});
      startBackgroundModule("momo-chain",()=>ns.momoChain.init(),{timeout:8000});
      startBackgroundModule("momo-push",()=>ns.momoPush.start());
      startBackgroundModule("edna",()=>ns.momoEDNA?.init?.(),{timeout:4000});
      Object.assign(ns.app||{}, {openView,updateProjectChip,diagnostics:()=>ns.core.diagnostics()});

      window.Momo?.branding?.init?.();
      bootScreen.update("Oberfläche wird vorbereitet …",55,"Navigation, Netzwerk und Projekte");
      await bootModule("security",()=>{if(!ns.security)throw new Error("Sicherheitsmodul fehlt")});
      await bootModule("sidebar",()=>ns.sidebar.init());
      await bootModule("settings",()=>ns.settings.init());
      // Guthaben VOR den Berechtigungen laden: ohne Credits darf nichts freigeschaltet
      // werden, und die Berechtigungen fragen das Guthaben ab.
      await bootModule("credits",()=>ns.momoCredits.init(),{timeout:6000});
      await bootModule("entitlements",()=>ns.entitlements.init());
      await bootModule("file-knowledge",()=>{if(!ns.fileKnowledge)throw new Error("Dateiwissen fehlt")});
      await bootModule("library",()=>ns.library?.init?.());
      await bootModule("planned",()=>ns.planned?.init?.());
      await bootModule("sources",()=>ns.sources.init());
      await bootModule("project-context",()=>{if(!ns.projectContext)throw new Error("Projektkontext fehlt")});
      document.addEventListener("momo:authchange",()=>{
        if(activeView()==="account")ensureViewContent("account");
        if(activeView()==="pricing")ensureViewContent("pricing");
      }); // view-resilience-authchange
      await bootModule("projects",()=>ns.projects.init());
      await bootModule("renderer",()=>{if(!ns.renderer)throw new Error("Renderer fehlt")});
      await bootModule("artifacts",()=>ns.artifacts.init());
      await bootModule("chat-ux",()=>ns.chatUX.init());
      await bootModule("search",()=>ns.search.init());
      await bootModule("ui",()=>ns.ui.init());
      if(ns.reliability?.recoveryInfo?.().uncleanShutdown||ns.reliability?.recoveryInfo?.().storageRecovered){ns.ui?.toast?.("Momo hat Wiederherstellungsdaten erkannt und auf diesem Gerät gesichert.")}
      startBackgroundModule("momo-tools",async()=>{const res=await fetch("momo/momo-tools.json?v="+(window.MOMO_BUILD||"dev"),{cache:"force-cache"});ns.momoTools.load(await res.json());});
      bootScreen.update("Chat wird geladen …",78,"Gespräche werden dargestellt");
      await bootModule("chats",()=>ns.chats.init());
      if(!ns.store.state.activeSessionId&&ns.store.visibleSessions().length){
        ns.store.activateSession(ns.store.visibleSessions()[0].id);
      }
      ns.chats?.renderAll?.();

      document.addEventListener("momo:storechange",updateProjectChip);
      document.getElementById("projectChip")?.addEventListener("click",e=>{
        const id=e.currentTarget.dataset.projectId||null;
        openView("projects");
        if(id)ns.projects?.openWorkspace?.(id);
      });
      // Normale Starts beginnen immer im privaten Momo-Chat; ?view= Deep-Links setzt pwa.handleLaunchShortcut() danach.
      requestedView=null;
      ns.navigation?.clearRequestedView?.();
      // Seit 27.09. (Wunsch Sebastian) oeffnet die App wieder im Chat.  Start bleibt
      // im Menue unter Network, einen Klick entfernt.
      const startAnsicht="chat";
      openView(startAnsicht,{remember:false});
      if(startAnsicht==="chat"&&!window.matchMedia("(max-width:720px)").matches)document.getElementById("chatInput")?.focus();

      ns.core.setCapability("workspaceSchema",ns.store.CURRENT_SCHEMA);
      ns.core.setCapability("persistenceMode",ns.persistence.diagnostics().mode);
      ns.core.setCapability("indexedDB",ns.persistence.diagnostics().mode==="indexeddb");
      ns.core.setCapability("momo",ns.inference.VERSION);
      ns.core.setCapability("momoChain",Boolean(ns.momoChain));
      ns.core.setCapability("responseProvenance",true);
      ns.pwa?.handleLaunchShortcut?.();

      bootScreen.update("Fast fertig …",90,"Cloud-Dienste verbinden sich unabhängig im Hintergrund");
      if(window.MOMO_SELFTEST!==true)void initOptionalCloudModules();
      else{ns.core.setCapability("authModuleReady",false);ns.core.setCapability("accountModuleReady",false);ns.core.setCapability("signedIn",false);ns.core.setCapability("billingUIReady",false);ns.core.setCapability("pushModuleReady",false);}
      ns.navigation?.reassertRequestedCriticalView?.();

      await waitForFullAvailability();
      ns.navigation?.reassertRequestedCriticalView?.();
      ns.core.markReady();
      ns.reliability?.markReady?.();
      bootScreen.finish();
      console.info("Momo ready",{core:ns.core.VERSION,schema:ns.store.CURRENT_SCHEMA,momo:ns.inference.VERSION,ms:Math.round(performance.now())});
    }catch(error){
      bootScreen.fail(error);
      if(ns.core)ns.core.reportError(error,{scope:"boot",fatal:true});
      else console.error(error);
    }
  }

  /* Navigation sofort veroeffentlichen, noch vor dem asynchronen Boot.
   * Account, Pricing und Einstellungen muessen erreichbar bleiben und duerfen
   * vom spaeten Boot-Standard nie ueberschrieben werden. */
  ns.app=Object.assign(ns.app||{}, {
    openView,
    updateProjectChip,
    activeView,
    requestedView:()=>requestedView||ns.navigation?.requestedView?.()||null,
    diagnostics:()=>ns.core?.diagnostics?.()||{}
  });

  /* Allgemeine Klick-Delegation.  Kritische Account-/Pricing-/Settings-Klicks
   * fängt navigation.js vor dem Bubbling ab — dieser Handler kommt danach
   * und kuemmert sich um den Rest. */
  document.addEventListener("click",event=>{
    const target=event.target?.closest?.("[data-view]");
    if(!target)return;
    const name=String(target.dataset?.view||"").trim();
    if(!name||ns.navigation?.isCriticalView?.(name))return;
    event.preventDefault();
    openView(name);
  });

  /* Das Skript kann nach DOMContentLoaded geladen werden (z.  B. aus einem
   * gecachten Netlify-Dokument). Dann feuert der alte Listener nie mehr,
   * und der Ladebildschirm bliebe fuer immer — darum hier noch einmal
   * pruefen statt blind auf das Event warten. */
  let bootStarted=false;
  const startBoot=()=>{
    if(bootStarted)return;
    bootStarted=true;
    void init();
  };
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",startBoot,{once:true});
  else startBoot();
})(window.MomoApp=window.MomoApp||{});