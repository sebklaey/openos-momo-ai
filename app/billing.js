"use strict";
(function(ns){
  let profile=null;
  let subscription=null;
  let serverEntitlement=null;
  const ACTIVE_BILLING=new Set(["active","trialing","past_due"]);

  function normalizePlan(value){
    const p=String(value||"free").toLowerCase();
    return p==="plus"||p==="pro"?p:"basic";
  }

  function localEntitlement(){
    const profilePlan=normalizePlan(profile?.plan);
    const profileStatus=String(profile?.billing_status||"free");
    const subscriptionPlan=normalizePlan(subscription?.plan);
    const subscriptionStatus=String(subscription?.status||"free");
    if(subscriptionPlan!=="free"&&ACTIVE_BILLING.has(subscriptionStatus)){
      return {plan:subscriptionPlan,status:subscriptionStatus,active:true,source:"subscription"};
    }
    if(profilePlan!=="free"&&ACTIVE_BILLING.has(profileStatus)){
      return {plan:profilePlan,status:profileStatus,active:true,source:"profile"};
    }
    const visiblePlan=profilePlan!=="free"?profilePlan:subscriptionPlan;
    const visibleStatus=profileStatus!=="free"?profileStatus:subscriptionStatus;
    return {plan:visiblePlan,status:visibleStatus,active:false,source:"inactive"};
  }

  function effectiveEntitlement(){
    const e=serverEntitlement;
    if(e&&e.verified){
      const plan=normalizePlan(e.plan),status=String(e.status||"free");
      return {plan,status,active:plan!=="free"&&ACTIVE_BILLING.has(status),source:e.source||"server"};
    }
    return localEntitlement();
  }

  async function authHeaders(){
    const s=await ns.auth.requireSession?.({minValiditySeconds:90})||ns.auth.currentSession();
    if(!s)throw new Error("Bitte zuerst anmelden.");
    return {
      "Authorization":"Bearer "+s.access_token,
      "apikey":window.MOMO_CONFIG.supabasePublishableKey,
      "Content-Type":"application/json"
    };
  }

  async function loadStatus(){
    const user=ns.auth.currentUser();
    if(!user){
      profile=null;subscription=null;serverEntitlement=null;
      ns.core?.setCapability?.("serverPlan","basic");
      ns.core?.setCapability?.("billingStatus","basic");
      renderAccount();
      renderPricing();
      document.dispatchEvent(new CustomEvent("momo:billingchange",{detail:{plan:"basic",status:"basic"}}));
      return;
    }

    /* Draw what is known locally, right now: the login state is already
       here; only profile and balance come from the network.  Skip these lines
       and pricing shows a false "not signed in" during several network calls —
       or forever after a failure.  An account is an account, everywhere in the
       same app.  There is no second truth. */
    try{renderAccount()}catch{/* egal */}
    try{renderPricing()}catch{/* egal */}

    try{
      const c=await ns.auth.getClient();
      const p=await c.from(momoDb("profiles"))
        .select("id,display_name,avatar_url,plan,billing_status,billing_updated_at,stripe_customer_id,stripe_subscription_id,locale,onboarding_completed,last_seen_at,created_at,updated_at")
        .eq("id",user.id).maybeSingle();
      if(p.error)throw p.error;
      profile=p.data||null;

      const s=await c.from(momoDb("subscriptions"))
        .select("id,user_id,status,plan,price_id,product_id,customer_id,current_period_end,cancel_at_period_end,latest_invoice_id,ended_at,updated_at")
        .eq("user_id",user.id)
        .order("updated_at",{ascending:false})
        .limit(1).maybeSingle();
      if(s.error){
        subscription=null;
        ns.core?.reportError?.(s.error,{scope:"billing:subscription-status",silent:true});
      }else subscription=s.data||null;

      serverEntitlement=null;
      const local=localEntitlement();
      const needsRepair=(normalizePlan(profile?.plan)!=="free"&&!ACTIVE_BILLING.has(String(profile?.billing_status||"")))
        ||(normalizePlan(subscription?.plan)!=="free"&&ACTIVE_BILLING.has(String(subscription?.status||""))
          &&(normalizePlan(profile?.plan)!==normalizePlan(subscription?.plan)||String(profile?.billing_status||"")!==String(subscription?.status||"")));
      if(needsRepair){
        try{
          const r=await callFunction(momoFn("create-checkout"),{action:"entitlement_status"});
          const e=r?.entitlement||r;
          if(e&&e.verified!==false&&e.plan){serverEntitlement={...e,verified:true};}
        }catch(error){
          ns.core?.reportError?.(error,{scope:"billing:entitlement-reconcile",silent:true});
        }
      }
      const effective=effectiveEntitlement();
      ns.core?.setCapability?.("serverPlan",effective.plan);
      ns.core?.setCapability?.("billingStatus",effective.status);
      ns.core?.setCapability?.("billingBackendVerified",Boolean(profile));
    }catch(err){
      ns.core?.reportError?.(err,{scope:"billing:status",silent:true});
      profile=null;subscription=null;serverEntitlement=null;
      ns.core?.setCapability?.("billingBackendVerified",false);
      /* A network error does not mean "signed out": the login state drawn
         locally above stays visible; only the server profile is missing.  A
         disconnected device must never lie about identity. */
      try{renderAccount()}catch{/* egal */}
      try{renderPricing()}catch{/* egal */}
    }
    renderAccount();
    renderPricing();
    document.dispatchEvent(new CustomEvent("momo:billingchange",{detail:{plan:currentPlan(),status:billingStatus()}}));
  }

  function currentPlan(){
    return effectiveEntitlement().plan;
  }

  function billingStatus(){
    return effectiveEntitlement().status;
  }

  function statusLabel(status=billingStatus()){
    const map={
      basic:"Basic",
      free:"Basic",
      incomplete:"Zahlung unvollständig",
      incomplete_expired:"Checkout abgelaufen",
      trialing:"Aktiv · Trial",
      active:"Aktiv",
      past_due:"Zahlung überfällig",
      unpaid:"Nicht bezahlt",
      canceled:"Gekündigt",
      paused:"Pausiert"
    };
    return map[status]||status;
  }

  function accessActive(){
    /* Once: "has a paid plan". Then: "is signed in".  Now: always. Plans
       were a promise about the future; usage billing is a fact about the past.
       Facts scale better than promises.
       OpenOS braucht keinen Account; nur Suggests+ verlangt einen, und das
       prueft entitlements.js an seiner eigenen Stelle. */
    return true;
  }

  function planLabel(){
    // Es gibt keine Stufen mehr. Bleibt als Stummel, weil aeltere Stellen es rufen.
    return "Credits";
  }

  async function callFunction(name,body={}){
    const res=await fetch(`${window.MOMO_CONFIG.functionsBase}/${name}`,{
      method:"POST",
      headers:await authHeaders(),
      body:JSON.stringify({...body,origin:ns.production?.origin?.()||location.origin})
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||`HTTP ${res.status}`);
    return data;
  }

  async function checkout(plan){
    const user=ns.auth.currentUser();
    if(!user){ns.app.openView("account");showNotice("Bitte zuerst anmelden.");return}
    /* Stripe ist abgeschafft — der einzige Kaufweg ist Bitcoin (Pricing). */
    ns.app.openView("pricing");
    showNotice("Credits kaufst du per Bitcoin direkt unter Pricing.");
  }

  async function openPortal(){
    showNotice("Es gibt keine Abos mehr — nur Bitcoin-Credits unter Pricing.");
    ns.app.openView("pricing");
  }

  /* Spenden gibt es seit dem 02.11. nicht mehr — der gesamte Spenden-Code
     (bindDonateControls, donate) wurde entfernt. */

  function showNotice(text,error=false){
    const pricingView=document.getElementById("view-pricing");
    const pricingVisible=Boolean(pricingView&&!pricingView.classList.contains("hidden"));
    const el=pricingVisible
      ?(document.getElementById("pricingNotice")||document.getElementById("accountNotice"))
      :(document.getElementById("accountNotice")||document.getElementById("pricingNotice"));
    if(!el) return;
    el.textContent=text;
    el.classList.toggle("error",Boolean(error));
    el.classList.add("show");
  }

  function safeAccountSection(label,renderer){
    try{return typeof renderer==="function"?(renderer()||""):""}
    catch(error){
      ns.core?.reportError?.(error,{scope:`account:${label}`,silent:true});
      return `<section class="account-card account-degraded">
        <div class="eyebrow">ACCOUNT STATUS</div>
        <h3>${escapeHtml(label)}</h3>
        <p>Dieser Account-Bereich konnte gerade nicht geladen werden.</p>
      </section>`;
    }
  }

  function renderAccount(){
    const host=document.getElementById("accountContent");
    if(!host)return;

    const user=ns.auth?.currentUser?.();

    try{
      host.innerHTML=`
      <div class="account-shell">
        <section class="account-card">
          <div class="eyebrow">CREDITS</div>
          <h3>Verbleibende Credits</h3>
          <div class="credits-balken" data-credits-balken>
            <div class="credits-balken-top"><strong data-credits-text>…</strong><span data-credits-sub></span></div>
            <div class="credits-balken-track"><div class="credits-balken-fill" data-credits-fill></div></div>
          </div>
          <p class="account-muted">1 Credit = 1 Satoshi · Aufladen jederzeit unter Pricing (Bitcoin).</p>
        </section>

        <section class="account-card">
          <div class="account-head">
            <div class="account-logo-mark" data-momo-logo data-momo-logo-class="account-logo-svg"></div>
            <div>
              <div class="eyebrow">MOMO ACCOUNT</div>
              <h2>${user?escapeHtml(profile?.display_name||user.email||"Momo User"):"Kein Account"}</h2>
              <p>${user?`${escapeHtml(user.email||"")} · Account-ID ${escapeHtml(String(user.id).slice(0,8))}…`:"Für Momo brauchst du einen Account und Guthaben."}</p>
            </div>
          </div>

          <div class="account-actions">
            <button class="action-btn white" id="openAdminPageBtn">Analytics</button>
          </div>

          ${user?`
            <div class="account-actions">
              <button class="action-btn" id="signOutBtn">Überall abmelden</button>
            </div>
          `:`
            <div class="email-login magic-link-only">
              <input id="emailLoginInput" type="email" autocomplete="email" placeholder="E-Mail-Adresse">
              <button class="action-btn white" id="emailLoginBtn">Magic Link senden</button>
            </div>
            <p class="auth-note">Momo rechnet nach Verbrauch ab und braucht darum einen Account. Guthaben und Preise findest du unter Pricing.</p>
          `}
        </section>

        <div id="accountIdentityContent"></div>

        ${user&&accessActive()?`
          <section class="account-card">
            <div class="account-section-head">
              <div>
                <div class="eyebrow">CLOUD SYNC</div>
                <h3>Momo Workspace synchronisieren</h3>
                <p>Cloud-Sync erfolgt nur auf deine ausdrückliche Aktion. Chats werden nicht automatisch hochgeladen.</p>
              </div>
            </div>
            <div class="account-actions">
              <button class="action-btn white" id="cloudUploadBtn">Stand vom Gerät hochladen</button>
              <button class="action-btn" id="cloudDownloadBtn">Cloud-Stand laden</button>
              <button class="action-btn" id="cloudStatusBtn">Status prüfen</button>
            </div>
            <div class="sync-status" id="cloudSyncStatus" role="status" aria-live="polite"></div>
          </section>
        `:""}

        <div class="account-notice" id="accountNotice" role="status" aria-live="polite"></div>
      </div>`;

      document.getElementById("emailLoginBtn")?.addEventListener("click",async e=>{
        const button=e.currentTarget;
        const email=document.getElementById("emailLoginInput").value.trim();
        if(!email){showNotice("Bitte E-Mail-Adresse eingeben.",true);document.getElementById("emailLoginInput")?.focus();return}
        try{
          const result=await (ns.polish?.withBusy?.(button,"Wird gesendet …",()=>ns.auth.signInEmail(email))||ns.auth.signInEmail(email));
          if(result?.rateLimited){
            showNotice("Magic Link angefordert. Prüfe dein Postfach; bei zu vielen Anfragen kann die Zustellung kurz verzögert sein.");
          }else if(result?.branded){
            showNotice("Magic Link von Momo gesendet. Prüfe dein E-Mail-Postfach.");
          }else{
            showNotice("Magic Link gesendet. Der gebrandete Momo-Mailversand ist serverseitig noch nicht vollständig verbunden.",true);
          }
        }catch(err){showNotice(ns.polish?.friendlyError?.(err)||err.message,true)}
      });

      document.getElementById("signOutBtn")?.addEventListener("click",()=>ns.auth.signOut("global").then(async()=>{
        // Global abmelden: Profil-Cache und alle Abhaengigen sofort leeren,
        // damit Popover, Account-Seite und Credits denselben Stand zeigen.
        try{await ns.account?.load?.()}catch{}
        try{await ns.momoCredits?.laden?.(true)}catch{}
        ns.ui?.toast?.("Überall abgemeldet.");
      }).catch(err=>showNotice(err.message,true)));
      document.getElementById("openAdminPageBtn")?.addEventListener("click",()=>ns.adminAnalytics?.openDashboard?.());

      document.getElementById("cloudUploadBtn")?.addEventListener("click",async()=>{
        try{
          const result=await ns.cloudSync.upload();
          setSyncStatus(`Hochgeladen · Revision ${result.revision} · ${new Date(result.time).toLocaleString()}`);
        }catch(error){
          if(error.code==="CLOUD_CONFLICT"){
            setSyncStatus("Konflikt erkannt: Cloud wurde auf einem anderen Gerät geändert. Lade zuerst den Cloud-Stand oder überschreibe ihn bewusst.",true);
            const el=document.getElementById("cloudSyncStatus");
            if(el&&!document.getElementById("cloudForceUploadBtn")){
              const btn=document.createElement("button");btn.id="cloudForceUploadBtn";btn.className="action-btn danger";btn.textContent="Stand dieses Geräts bewusst überschreiben";btn.style.marginTop="8px";
              btn.addEventListener("click",async()=>{if(!confirm("Cloud-Stand wirklich mit dem Workspace dieses Geräts überschreiben?"))return;try{const r=await ns.cloudSync.upload({force:true});setSyncStatus(`Überschrieben · Revision ${r.revision}`);}catch(e){setSyncStatus(e.message,true)}});
              el.appendChild(btn);
            }
          }else setSyncStatus(error.message,true);
        }
      });
      document.getElementById("cloudDownloadBtn")?.addEventListener("click",async()=>{
        if(!confirm("Cloud-Workspace laden? Vorher wird automatisch ein Backup auf diesem Gerät erstellt."))return;
        try{
          const result=await ns.cloudSync.download();
          setSyncStatus(result?`Cloud-Stand geladen · Revision ${result.revision}`:"Noch kein Cloud-Workspace vorhanden.");
        }catch(error){setSyncStatus(error.message,true)}
      });
      document.getElementById("cloudStatusBtn")?.addEventListener("click",async()=>{
        const status=await ns.cloudSync.status();
        if(!status.available)return setSyncStatus(status.error||"Cloud-Sync derzeit nicht verfügbar.",true);
        setSyncStatus(status.remoteExists
          ?`${status.inSync?"Synchron":"Unterschiedlicher Stand"} · Cloud Revision ${status.remoteRevision} · ${status.remoteUpdatedAt?new Date(status.remoteUpdatedAt).toLocaleString():""}`
          :"Noch kein Cloud-Workspace vorhanden.");
      });

      try{ns.account?.render?.()}catch(error){ns.core?.reportError?.(error,{scope:"account:identity-render",silent:true})}
      try{window.Momo?.branding?.init?.()}catch(error){ns.core?.reportError?.(error,{scope:"account:branding",silent:true})}
      try{ns.momoCredits?.balkenAktualisieren?.()}catch{/* egal */}
    }catch(error){
      ns.core?.reportError?.(error,{scope:"account:render",silent:true});
      host.innerHTML=`<div class="account-shell account-render-fallback">
        <section class="account-card">
          <div class="eyebrow">MOMO ACCOUNT</div>
          <h2>Account</h2>
          <p>Account-Daten konnten gerade nicht vollständig geladen werden. Deine Daten auf diesem Gerät bleiben erhalten.</p>
          <div class="account-actions"><button class="action-btn" id="accountRetryBtn">Account erneut laden</button></div>
        </section>
      </div>`;
      document.getElementById("accountRetryBtn")?.addEventListener("click",renderAccount);
    }
  }

  /* Pricing (02.11.): nothing is free anymore. One credit = USD 0.009.
     Per-feature usage comes from entitlements.renderMatrix.  Any amount of
     credits is bought through Stripe (openos-credit-checkout-v1).  Donations
     are gone — a sustainable system bills honestly for what it costs to run. */
  const CREDIT_PREIS_USD = 0.009;
  function renderPricing(){
    const host=document.getElementById("pricingContent");
    if(!host)return;
    try{
      const user=ns.auth?.currentUser?.();
      const stand=ns.momoCredits?.stand?.();
      const guthaben=Number(ns.momoCredits?.guthaben?.()??0);
      host.innerHTML=`
      <div class="account-shell pricing-shell">
        <section class="account-card pricing-status-card">
          <div class="account-section-head">
            <div>
              <div class="eyebrow">PREISE</div>
              <h3>Alles nach Verbrauch</h3>
              <p><strong>1 Credit = 1 Satoshi (0,00000001 BTC).</strong> Jede Funktion verbraucht Credits —
                 Jede Funktion kostet 1 Credit: 1 Chat-Antwort, 1 Eintrag,
                 1 GB gespeicherte Daten (Kompression, Projekte, Dateien, Artifacts, Cloud-Sync).
                 Es gibt keine Gratis-Variante mehr.</p>
              <p>Bezahlt wird ausschließlich mit Bitcoin — direkt an die OpenOS-Adresse,
                 beliebiger Betrag: geschickte Satoshis = erhaltene Credits. Der Verbrauch
                 wird lokal in deinem Gerät gebucht; dein Stand steht auf dieser Seite.</p>
            </div>
            <div class="account-badges">
              <span class="plan-badge">1 Credit = 1 Satoshi</span>
            </div>
          </div>
          <p class="account-muted">${user
            ?(stand
              ?`Aktuelles Guthaben: <strong>${guthaben.toLocaleString("de-CH")} Credits</strong> (= ${guthaben.toLocaleString("de-CH")} Satoshi, Bitcoin).`
              :"Guthaben wird geladen …")
            :"Für Kauf und Buchung von Credits bitte anmelden."}</p>
        </section>

        <section class="account-card">
          <div class="account-section-head">
            <div>
              <div class="eyebrow">CREDITS KAUFEN</div>
              <h3>Bitcoin — die einzige Bezahlmöglichkeit</h3>
              <p><strong>1 Credit = 1 Satoshi.</strong> Direktzahlung an die OpenOS-Bitcoin-Adresse,
                 Gutschrift nach Zahlungseingang, idempotent, lokal verbucht.</p>
            </div>
          </div>
          <div id="bitcoinPayHost"></div>
          <p class="account-muted">Es gibt keinen Stripe-Checkout, keinen Zahlungsdienstleister und kein Abo —
             nur Bitcoin, direkt. Der Kurs kann einmalig aus der öffentlichen Blockchain-Preisquelle geprüft werden;
             es werden keine Nutzerdaten übertragen.</p>
        </section>

        ${safeAccountSection("Funktionen & Verbrauch",()=>ns.entitlements?.renderMatrix?.())}
        <div class="account-notice" id="pricingNotice" role="status" aria-live="polite"></div>
      </div>`;
      ns.bitcoinPay?.render?.(host.querySelector("#bitcoinPayHost"));
      document.querySelector("[data-credits-form]")?.addEventListener?.("submit",e=>e.preventDefault());
    }catch(error){
      ns.core?.reportError?.(error,{scope:"pricing:render",silent:true});
      host.innerHTML='<div class="account-shell"><section class="account-card"><div class="eyebrow">MOMO CREDITS</div><h2>Preise konnten nicht geladen werden</h2><p>Bitte versuche es erneut.</p><button class="action-btn" id="pricingRetryBtn">Erneut laden</button></section></div>';
      document.getElementById("pricingRetryBtn")?.addEventListener("click",renderPricing);
    }
  }

  function setSyncStatus(text,error=false){
    const el=document.getElementById("cloudSyncStatus");
    if(!el)return;
    el.textContent=String(text||"");
    el.classList.toggle("error",Boolean(error));
    el.classList.add("show");
  }

  function escapeHtml(v){
    return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
  }

  function canUse(feature){
    if(ns.entitlements?.can)return ns.entitlements.can(feature);
    // Notfallpfad, falls entitlements.js nicht geladen ist: angemeldet genuegt.
    return accessActive();
  }

  async function handleReturnState(){
    const url=new URL(location.href);
    const state=url.searchParams.get("billing");
    if(!state)return;
    try{ns.app?.openView?.("pricing");}catch{}
    if(state==="success"){
      showNotice("Zahlung abgeschlossen. Momo schreibt dein Guthaben gut …");
      const vorher=ns.momoCredits?.guthaben?.()??0;
      let jetzt=vorher;
      for(let versuch=0;versuch<6;versuch++){
        await ns.momoCredits?.laden?.(true);
        jetzt=ns.momoCredits?.guthaben?.()??0;
        if(jetzt>vorher)break;
        await new Promise(resolve=>setTimeout(resolve,900+versuch*350));
      }
      await loadStatus();
      showNotice(jetzt>vorher
        ?`Guthaben gutgeschrieben. Du hast jetzt ${Number(jetzt).toLocaleString("de-CH")} Credits.`
        :"Zahlung ist eingegangen. Die Gutschrift wird noch verarbeitet.");
    }else if(state==="cancelled"){
      showNotice("Checkout wurde abgebrochen.");
    }
    url.searchParams.delete("billing");
    url.searchParams.delete("session_id");
    history.replaceState({},document.title,url.pathname+url.search+url.hash);
  }

  async function init(){
    document.addEventListener("momo:authchange",loadStatus);
    // Nach jedem Verbrauch zeichnet billing die Views neu — und danach muessen
    // auch die frisch gebauten Balken erneut gefuellt werden.  Sonst blinkt die
    // Zahl kurz und faellt dann auf den Leerstand zurueck, bis etwas anders
    // anzeigen() ruft.
    document.addEventListener("momo:guthabenstand",()=>{try{renderPricing()}catch{/* egal */}try{renderAccount()}catch{/* egal */}try{ns.momoCredits?.anzeigen?.()}catch{/* egal */}});
    await loadStatus();
    try{await ns.momoCredits?.laden?.(true)}catch{/* egal */}
    await handleReturnState();
  }

  ns.billing={
    init,loadStatus,renderAccount,renderPricing,currentPlan,billingStatus,statusLabel,
    accessActive,canUse,checkout,openPortal,
    profile:()=>profile,subscription:()=>subscription,effectiveEntitlement
  };
})(window.MomoApp=window.MomoApp||{});