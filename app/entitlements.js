"use strict";
(function(ns){
  /* Wer darf was.
   *
   * Seit dem 21.09. gilt: OpenOS braucht keinen Account.  Man kann die App oeffnen
   * und sofort damit arbeiten — chatten, Projekte anlegen, Presence bauen, Social,
   * Match, News, Rooms, Suggests. Alles liegt ohnehin auf dem Geraet.
   *
   * GENAU EINE AUSNAHME: Suggests+.  Wer selbst Werbung ausspielt, kauft dafuer
   * Credits, und Credits brauchen ein Konto, dem sie gehoeren. Dort — und nur dort
   * — steht "account:true" und "credits:true".
   *
   * Die Suggests+ Credits sind ein EIGENER Topf (suggests_credit_wallets_v1,
   * 1 Credit = CHF 0.30) und haben mit dem alten Momo-Guthaben nichts zu tun.
   * Darum fragt hatGuthaben() genau diesen Topf.
   */
  const FEATURES={
    "local-chat":{label:"Momo Chat"},
    "projects":{label:"Projekte"},
    "planned":{label:"Geplant"},
    "local-files":{label:"Eigene Dateien"},
    "presence":{label:"Eigene AI-lesbare Presence"},
    "social":{label:"Social"},
    "match":{label:"Match"},
    "news":{label:"News"},
    "room":{label:"Room"},
    "store":{label:"App Store"},
    "suggests":{label:"Suggests"},
    "project-memory":{label:"Project Memory"},
    "artifacts":{label:"Artifacts / Work Surface"},
    "web-research":{label:"Web & Research"},
    "cloud-sync":{label:"Cloud-Sync"},
    "advanced-projects":{label:"Erweiterte Projektfunktionen"},
    "suggests-plus":{label:"Suggests+",account:true,credits:true}
  };
  let initialized=false,lastSnapshot=null;

  const signedIn=()=>Boolean(ns.auth?.currentUser?.());
  // Der Suggests+ Topf, nicht das alte Momo-Guthaben.
  const guthaben=()=>Number(ns.momoSuggestsCredits?.snapshot?.()?.balance||0);
  const hatGuthaben=()=>guthaben()>0;
  // Bleiben als Stummel, weil aeltere Stellen sie noch aufrufen.  Es gibt nur
  // noch eine Art Zugang.
  const plan=()=>"credits";
  const planLabel=()=>"Credits";

  function evaluate(feature){
    const def=FEATURES[feature]||{label:feature,account:true};
    if(def.account&&!signedIn()){
      return {allowed:false,feature,label:def.label,reason:"auth_required",
        message:`${def.label} braucht einen Account per Magic Link — als Einziges in OpenOS.`};
    }
    if(def.credits&&!hatGuthaben()){
      return {allowed:false,feature,label:def.label,reason:"keine_credits",
        message:`${def.label} braucht Suggests+ Credits. Unter Pricing kannst du welche kaufen.`};
    }
    return {allowed:true,feature,label:def.label,reason:"allowed",message:"Verfügbar"};
  }

  const can=(feature)=>evaluate(feature).allowed;

  function assert(feature){
    const result=evaluate(feature);
    if(result.allowed)return true;
    const error=new Error(result.message);
    error.code="ENTITLEMENT_DENIED";
    error.entitlement=result;
    throw error;
  }

  function snapshot(){
    const features={};
    Object.keys(FEATURES).forEach(key=>features[key]=evaluate(key));
    return {plan:plan(),planLabel:planLabel(),signedIn:signedIn(),
      guthaben:guthaben(),hatGuthaben:hatGuthaben(),features};
  }

  function reasonLabel(reason){
    return {auth_required:"Account erforderlich",keine_credits:"Guthaben aufgebraucht"}[reason]||"Nicht verfügbar";
  }

  function showGate(feature){
    const result=evaluate(feature);
    if(result.allowed)return true;
    const dialog=document.getElementById("entitlementDialog");
    if(!dialog)return false;
    const set=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value};
    set("entitlementEyebrow",reasonLabel(result.reason).toUpperCase());
    set("entitlementTitle",result.label);
    set("entitlementCopy",result.message);
    set("entitlementPlan",result.reason==="keine_credits"
      ? `Guthaben: ${ns.momoPreise?.zeigeCredits?.(guthaben())??guthaben()} Credits`
      : "Anmelden genügt — danach Credits kaufen.");
    dialog.dataset.feature=feature;
    dialog.classList.add("open");
    return false;
  }

  const closeGate=()=>document.getElementById("entitlementDialog")?.classList.remove("open");

  /** Was was kostet. Ein Credit = 1 Satoshi (0,00000001 BTC); jede Funktion
      kostet 1 Credit: 1 Chat-Antwort, 1 GB gespeicherte Daten, 1 Eintrag. */
  const TARIFE=[
    ["Momo Chat","1 Credit pro Antwort","1 Satoshi"],
    ["Kompression","1 Credit pro GB","1 Satoshi"],
    ["Projekte","1 Credit pro GB","1 Satoshi"],
    ["Geplant","1 Credit pro Eintrag","1 Satoshi"],
    ["Eigene Dateien","1 Credit pro GB","1 Satoshi"],
    ["Artifacts / Work Surface","1 Credit pro GB","1 Satoshi"],
    ["Cloud-Sync","1 Credit pro GB","1 Satoshi"],
    ["App Store","1 Credit pro Eintrag","1 Satoshi"]
  ];
  function renderMatrix(){
    const zeile=([name,verbrauch,preis])=>
      `<div class="entitlement-row"><strong>${name}</strong><span>${verbrauch}</span><span>${preis}</span><span></span></div>`;
    return `<section class="account-card entitlement-matrix-card">
      <div class="eyebrow">FUNKTIONEN & VERBRAUCH</div><h3>Alles nach Verbrauch</h3>
      <p>Es gibt keine Gratis-Variante mehr: Jede Funktion verbraucht Credits.
         1 Credit = 1 Satoshi (0,00000001 BTC) — jede Funktion kostet 1 Credit: 1 Chat-Antwort, 1 GB gespeicherte Daten, 1 Eintrag.</p>
      <div class="entitlement-table">
        <div class="entitlement-row entitlement-head"><strong>Funktion</strong><span>Verbrauch</span><span>Preis</span><span></span></div>${TARIFE.map(zeile).join("")}
      </div></section>`;
  }

  function refresh(){
    lastSnapshot=snapshot();
    ns.core?.setCapability?.("entitlements",Object.fromEntries(Object.entries(lastSnapshot.features).map(([k,v])=>[k,v.allowed])));
    ns.core?.emit?.("entitlements-change",lastSnapshot);
    document.dispatchEvent(new CustomEvent("momo:entitlementschange",{detail:lastSnapshot}));
    return lastSnapshot;
  }

  function init(){
    if(initialized)return refresh();
    initialized=true;
    document.addEventListener("momo:billingchange",refresh);
    document.addEventListener("momo:authchange",refresh);
    document.addEventListener("momo:guthabenstand",refresh);
    document.getElementById("entitlementCloseBtn")?.addEventListener("click",closeGate);
    document.getElementById("entitlementLaterBtn")?.addEventListener("click",closeGate);
    document.getElementById("entitlementPlansBtn")?.addEventListener("click",()=>{closeGate();ns.app?.openView?.("pricing")});
    document.getElementById("entitlementDialog")?.addEventListener("click",e=>{if(e.target.id==="entitlementDialog")closeGate()});
    return refresh();
  }

  ns.entitlements={FEATURES,init,plan,planLabel,evaluate,can,assert,showGate,closeGate,renderMatrix,refresh,
    diagnostics:()=>lastSnapshot||snapshot()};
})(window.MomoApp=window.MomoApp||{});