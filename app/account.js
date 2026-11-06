"use strict";
(function(ns){
  const DEVICE_KEY_STORAGE="momo-device-key-v1";
  let profile=null;
  let devices=[];
  let loading=false;
  let localBindingConflict=null;
  let apiKeys=[];
  let apiKeysLoading=false;
  let lastCreatedKey=null;
  let apiError="";

  const esc=v=>String(v??"")
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;");

  function deviceKey(){
    let key="";
    try{key=localStorage.getItem(DEVICE_KEY_STORAGE)||""}catch{}
    if(key.length>=16)return key;

    const bytes=new Uint8Array(18);
    crypto.getRandomValues(bytes);
    key="momo_"+[...bytes].map(b=>b.toString(16).padStart(2,"0")).join("");
    try{localStorage.setItem(DEVICE_KEY_STORAGE,key)}catch{}
    return key;
  }

  function platform(){
    const ua=navigator.userAgent||"";
    if(/iPhone|iPad|iPod/i.test(ua))return "iOS";
    if(/Android/i.test(ua))return "Android";
    if(/Mac/i.test(ua))return "macOS";
    if(/Win/i.test(ua))return "Windows";
    if(/Linux/i.test(ua))return "Linux";
    return navigator.platform||"Web";
  }

  function defaultDeviceLabel(){
    return `${platform()} · ${navigator.userAgentData?.mobile?"Mobile":"Browser"}`;
  }

  function detectedLocale(){
    const candidates=[...(navigator.languages||[]),navigator.language].filter(Boolean);
    for(const value of candidates){
      try{
        const canonical=Intl.getCanonicalLocales(String(value))[0];
        if(canonical)return canonical.slice(0,24);
      }catch{}
    }
    return "en";
  }

  function localeLabel(locale=detectedLocale()){
    try{
      const display=new Intl.DisplayNames([locale,"en"],{type:"language"});
      const language=locale.split("-")[0];
      const name=display.of(language)||locale;
      return `${name} (${locale})`;
    }catch{return locale}
  }

  async function syncAutoLocale(client){
    if(!profile?.id)return;
    const locale=detectedLocale();
    if(profile.locale===locale)return;
    const {error}=await client.from(momoDb("profiles")).update({
      locale,
      last_seen_at:new Date().toISOString(),
      updated_at:new Date().toISOString()
    }).eq("id",profile.id);
    if(error)throw error;
    profile={...profile,locale};
  }

  async function load(){
    const user=ns.auth?.currentUser?.();
    if(!user){
      profile=null;devices=[];localBindingConflict=null;
      ns.sidebar?.syncAccountIdentity?.();
      document.dispatchEvent(new CustomEvent("momo:accountprofile",{detail:{signedIn:false}}));
      render();
      return;
    }

    loading=true;
    render();

    try{
      const c=await ns.auth.getClient();
      const [p,d]=await Promise.all([
        c.from(momoDb("profiles")).select("id,display_name,avatar_url,plan,locale,onboarding_completed,last_seen_at,created_at,updated_at").eq("id",user.id).maybeSingle(),
        c.from(momoDb("devices")).select("id,device_key,label,platform,created_at,last_seen_at,revoked_at").eq("user_id",user.id).order("last_seen_at",{ascending:false})
      ]);
      if(p.error)throw p.error;
      if(d.error)throw d.error;
      profile=p.data||null;
      devices=d.data||[];

      await syncAutoLocale(c);
      await registerDevice();
      await detectLocalBinding();
      ns.core?.setCapability?.("accountProfileLoaded",Boolean(profile));
      ns.core?.setCapability?.("registeredDevices",devices.filter(x=>!x.revoked_at).length);
    }catch(error){
      ns.core?.reportError?.(error,{scope:"account:load",silent:true});
    }finally{
      loading=false;
      ns.sidebar?.syncAccountIdentity?.();
      document.dispatchEvent(new CustomEvent("momo:accountprofile",{detail:{signedIn:Boolean(ns.auth?.currentUser?.()),displayName:profile?.display_name||null}}));
      render();
    }
  }

  async function registerDevice(){
    const user=ns.auth.currentUser();
    if(!user)return;
    const c=await ns.auth.getClient();
    const key=deviceKey();

    const row={
      user_id:user.id,
      device_key:key,
      label:defaultDeviceLabel(),
      platform:platform(),
      user_agent:(navigator.userAgent||"").slice(0,500),
      last_seen_at:new Date().toISOString(),
      revoked_at:null
    };

    const {error}=await c.from(momoDb("devices")).upsert(row,{onConflict:"user_id,device_key"});
    if(error)throw error;

    const {data}=await c.from(momoDb("devices"))
      .select("id,device_key,label,platform,created_at,last_seen_at,revoked_at")
      .eq("user_id",user.id).order("last_seen_at",{ascending:false});
    devices=data||[];
  }

  function hasLocalData(){
    return Boolean(
      ns.store?.state?.sessions?.length ||
      ns.store?.state?.projects?.length ||
      ns.store?.state?.learnedMemory?.facts?.length
    );
  }

  async function detectLocalBinding(){
    const user=ns.auth.currentUser();
    const binding=ns.store?.state?.accountBinding||null;
    if(!user){localBindingConflict=null;return}

    if(binding?.userId && binding.userId!==user.id){
      localBindingConflict={
        previousUserId:binding.userId,
        currentUserId:user.id,
        hasLocalData:hasLocalData()
      };
      return;
    }
    localBindingConflict=null;
  }

  async function adoptLocalWorkspace(){
    const user=ns.auth.currentUser();
    if(!user)throw new Error("Nicht angemeldet.");
    await ns.store.createSnapshot("Vor Account-Zuordnung");
    ns.store.bindAccount({
      userId:user.id,
      email:user.handle||user.email||"",
      boundAt:new Date().toISOString()
    });
    await ns.store.flush();
    localBindingConflict=null;
    render();
    ns.ui?.toast?.("Lokaler Workspace diesem Account zugeordnet");
  }

  async function detachLocalWorkspace(){
    ns.store.unbindAccount();
    await ns.store.flush();
    localBindingConflict=null;
    render();
    ns.ui?.toast?.("Lokale Account-Zuordnung entfernt");
  }

  async function saveProfile(){
    const user=ns.auth.currentUser();
    if(!user)throw new Error("Nicht angemeldet.");
    const displayName=String(document.getElementById("profileDisplayName")?.value||"").trim().slice(0,80);
    const locale=detectedLocale();

    const c=await ns.auth.getClient();
    const {error}=await c.from(momoDb("profiles")).update({
      display_name:displayName||null,
      locale,
      onboarding_completed:true,
      last_seen_at:new Date().toISOString(),
      updated_at:new Date().toISOString()
    }).eq("id",user.id);
    if(error)throw error;
    ns.ui?.toast?.("Profil gespeichert");
    await load();
  }

  async function revokeDevice(id){
    const user=ns.auth.currentUser();
    if(!user)return;
    const device=devices.find(x=>x.id===id);
    if(!device)return;
    if(device.device_key===deviceKey())throw new Error("Das aktuelle Gerät kann hier nicht widerrufen werden. Melde dich stattdessen ab.");

    const c=await ns.auth.getClient();
    const {error}=await c.from(momoDb("devices"))
      .update({revoked_at:new Date().toISOString()})
      .eq("id",id).eq("user_id",user.id);
    if(error)throw error;
    ns.ui?.toast?.("Gerät widerrufen");
    await load();
  }


  function devicesHTML(){
    const key=deviceKey();
    const active=devices.filter(d=>!d.revoked_at);
    if(!active.length)return '<div class="runtime-source-detail">Noch keine registrierten Geräte.</div>';

    return active.map(d=>`
      <div class="device-row">
        <div class="device-icon">◇</div>
        <div class="device-copy">
          <strong>${esc(d.label||d.platform||"Momo Device")} ${d.device_key===key?'<span class="current-device">Dieses Gerät</span>':""}</strong>
          <span>${esc(d.platform||"Web")} · zuletzt ${d.last_seen_at?new Date(d.last_seen_at).toLocaleString():"—"}</span>
        </div>
        ${d.device_key!==key?`<button class="action-btn danger" data-revoke-device="${d.id}">Widerrufen</button>`:""}
      </div>
    `).join("");
  }

  function migrationHTML(){
    const user=ns.auth.currentUser();
    if(!user)return "";
    const binding=ns.store?.state?.accountBinding||null;

    if(localBindingConflict){
      return `
        <section class="account-card account-warning">
          <div class="eyebrow">LOKALE DATEN</div>
          <h3>Dieser Browser enthält einen Workspace eines anderen Accounts.</h3>
          <p>Momo lädt lokale Chats niemals automatisch in einen anderen Account. Du entscheidest ausdrücklich, was mit diesen Daten passiert.</p>
          <div class="account-actions">
            <button class="action-btn white" id="adoptLocalBtn">Diesem Account zuordnen</button>
            <button class="action-btn" id="keepLocalSeparateBtn">Nicht zuordnen</button>
          </div>
        </section>`;
    }

    if(!binding?.userId && hasLocalData()){
      return `
        <section class="account-card">
          <div class="eyebrow">LOKALER WORKSPACE</div>
          <h3>Lokale Momo-Daten mit diesem Account verbinden?</h3>
          <p>Die Daten bleiben zunächst auf diesem Gerät. Die Zuordnung erlaubt später einen kontrollierten Cloud-Sync.</p>
          <div class="account-actions">
            <button class="action-btn white" id="adoptLocalBtn">Lokale Daten zuordnen</button>
          </div>
        </section>`;
    }

    if(binding?.userId===user.id){
      return `
        <section class="account-card compact-account-card">
          <div>
            <div class="eyebrow">LOKALER WORKSPACE</div>
            <h3>Mit diesem Account verbunden</h3>
            <p>Lokale Daten werden nur nach deiner ausdrücklichen Sync-Aktion in die Cloud übertragen.</p>
          </div>
          <button class="action-btn" id="detachLocalBtn">Zuordnung lösen</button>
        </section>`;
    }

    return "";
  }

  function apiSectionHTML(){
    /* EIN Block, der komplett ins Terminal (zsh/bash) kopiert werden kann:
       lädt das SDK, schreibt test.cjs per Heredoc und führt es aus.
       Der JS-Code steht in 'EOF'-Anführungen — die Shell fasst ihn nicht an.
       Hinweis: Backticks im JS müssen hier escaped bleiben, das Template
       literal baut den Block zur Laufzeit. */
    const sdk=`# ===== Momo AI SDK — Schnelltest (einen Block ins Terminal kopieren) =====
mkdir -p momo-test && cd momo-test && \
curl -sL "https://app.openos.space/momo-sdk.js" -o momo-sdk.cjs && \
cat > test.cjs <<'MOMO_SDK_EOF'
const MomoAI = require("./momo-sdk.cjs");

(async () => {
  const client = MomoAI.createClient({ apiKey: "DEIN_API_KEY_HIER" });

  // Kompression: 40 Credits pro GB, mindestens 1 Credit
  const fileBytes = new TextEncoder().encode("Hallo Momo AI ".repeat(1000));
  const compressed = await client.compress(fileBytes, { name: "daten.bin" });
  console.log("Ratio %:", compressed.ratio_percent,
              "| Archiv-Bytes:", compressed.archive.length);

  // Dekompression: 0 Credits
  const restored = await client.decompress(compressed.archive);
  console.log("Bit-exakt:",
    Buffer.compare(Buffer.from(restored.data), Buffer.from(fileBytes)) === 0);

  // Dieselbe Momo AI auch als Chat: 1 Credit pro Antwort
  const analyse = await client.chat("Analysiere die komprimierten Daten.", {
    context: "OpenOS Momo AI Kompression",
  });
  console.log(analyse.text || analyse);
})().catch((e) => { console.error("Fehler:", e.message || e); process.exit(1); });
MOMO_SDK_EOF
# API-Key einsetzen (ersetze DEIN_API_KEY_HIER) und starten:
sed -i '' 's/DEIN_API_KEY_HIER/osk_live_…/' test.cjs 2>/dev/null || true
node test.cjs`;
    return `
      <section class="account-card api-access-card">
        <div class="account-section-head">
          <div>
            <div class="eyebrow">API-ZUGANG & SDK</div>
            <h3>Momo AI in deine Systeme integrieren</h3>
            <p>Ein Endpunkt, eine KI, ein Guthaben: Kompression, Dekompression und Chat für Kunden-Workflows. Kompression kostet 40 Credits pro GB (mindestens 1 Credit), Dekompression ist gratis, Chat kostet 1 Credit pro Antwort.</p>
          </div>
          <div class="account-actions">
            <button class="action-btn white" id="createApiKeyBtn">Neuen API-Key erstellen</button>
            <button class="action-btn" id="refreshApiKeysBtn">Aktualisieren</button>
          </div>
        </div>
        <div id="apiKeyState" class="runtime-source-detail">API-Keys werden geladen …</div>
        <div id="apiKeyList" class="api-key-list"></div>
        ${lastCreatedKey?`
          <div class="api-created-key">
            <div class="eyebrow">NEUER SCHLÜSSEL — NUR EINMAL SICHTBAR</div>
            <div class="api-key-value-row">
              <input id="createdApiKey" readonly value="${esc(lastCreatedKey.api_key)}">
              <button class="action-btn white" id="copyCreatedApiKeyBtn">Kopieren</button>
            </div>
          </div>`:""}
        <div class="api-sdk-grid">
          <div>
            <div class="eyebrow">MCP-ENDPUNKT</div>
            <div class="api-endpoint-row">
              <code class="api-endpoint" id="mcpEndpointText">https://app.openos.space/mcp</code>
              <button class="action-btn white" id="copyEndpointBtn">Kopieren</button>
            </div>
            <p class="runtime-source-detail">Protokoll: MCP über JSON-RPC. Authorization: <code>Bearer osk_live_…</code></p>
          </div>
          <div>
            <div class="eyebrow">JAVASCRIPT-SDK</div>
            <pre class="api-sdk-code"><code>${esc(sdk)}</code></pre>
            <button class="action-btn" id="copySdkBtn">SDK-Beispiel kopieren</button>
          </div>
        </div>
      </section>`;
  }

  function apiRowsHTML(){
    if(apiKeysLoading)return "";
    if(!apiKeys.length)return '<div class="runtime-source-detail">Noch keine API-Keys. Erstelle einen Schlüssel für deine Integration.</div>';
    return apiKeys.map(k=>`
      <div class="device-row api-key-row">
        <div class="device-icon">⌁</div>
        <div class="device-copy">
          <strong>${esc(k.name||"Momo AI API")} <span class="status-pill ${k.status==="active"?"ok":""}">${esc(k.status)}</span></strong>
          <span>${esc(k.key_prefix||"osk_…")}…${esc(k.last_four||"")} · erstellt ${k.created_at?new Date(k.created_at).toLocaleString():"—"} · zuletzt ${k.last_used_at?new Date(k.last_used_at).toLocaleString():"nie"}</span>
        </div>
        ${k.status==="active"?`<button class="action-btn danger" data-revoke-api-key="${esc(k.id)}">Widerrufen</button>`:""}
      </div>`).join("");
  }

  function paintApiKeys(){
    const list=document.getElementById("apiKeyList");
    const state=document.getElementById("apiKeyState");
    if(!list||!state)return;
    state.textContent=apiKeysLoading?"API-Keys werden geladen …":apiError?apiError:"";
    list.innerHTML=apiRowsHTML();
    list.querySelectorAll("[data-revoke-api-key]").forEach(btn=>btn.addEventListener("click",()=>revokeApiKey(btn.dataset.revokeApiKey).catch(e=>ns.ui?.toast?.(e.message))));
  }

  async function apiRequest(action, payload={}){
    const session=await (ns.auth?.requireSession?.({minValiditySeconds:90})||ns.auth?.currentSession?.());
    if(!session?.access_token)throw new Error("Bitte zuerst anmelden.");
    const res=await fetch(`${window.MOMO_CONFIG?.functionsBase}/openos-mcp-v1`,{
      method:"POST",
      headers:{
        "authorization":"Bearer "+session.access_token,
        "apikey":window.MOMO_CONFIG?.supabasePublishableKey||"",
        "content-type":"application/json"
      },
      body:JSON.stringify({action,...payload})
    });
    const data=await res.json().catch(()=>({}));
    if(!res.ok||data?.ok===false)throw new Error(String(data?.error||`API-Fehler ${res.status}`));
    return data;
  }

  async function refreshApiKeys(){
    if(!ns.auth?.currentUser?.())return;
    apiKeysLoading=true; apiError=""; paintApiKeys();
    try{ apiKeys=(await apiRequest("list-keys")).keys||[]; }
    catch(e){ apiError=String(e.message||e); }
    apiKeysLoading=false; paintApiKeys();
  }

  async function createApiKey(){
    apiKeysLoading=true; paintApiKeys();
    try{
      lastCreatedKey=(await apiRequest("create-key",{label:"Momo AI Integration"})).key||null;
      ns.ui?.toast?.("API-Key erstellt. Kopiere ihn jetzt — er wird nur einmal vollständig gezeigt.");
      await refreshApiKeys();
      render();
    }catch(e){ apiKeysLoading=false; apiError=String(e.message||e); paintApiKeys(); ns.ui?.toast?.(apiError); }
  }

  async function revokeApiKey(id){
    if(!id)return;
    if(!confirm("Diesen API-Key wirklich widerrufen? Bestehende Integrationen verlieren sofort den Zugriff."))return;
    await apiRequest("revoke-key",{id});
    ns.ui?.toast?.("API-Key widerrufen.");
    await refreshApiKeys();
  }

  async function copyText(text){
    try{ await navigator.clipboard.writeText(String(text||"")); ns.ui?.toast?.("Kopiert."); }
    catch{ ns.ui?.toast?.("Kopieren nicht möglich — bitte manuell markieren."); }
  }

  // ---------------------------------------------------------------- Daten-Kette (lokal, signiert)
  let chainStats = null;
  function chainSectionHTML(){
    const s = chainStats;
    const headHash = s?.head?.hash ? s.head.hash.slice(0,18)+"…" : "…";
    const addr = s?.systemAddress ? s.systemAddress.slice(0,10)+"…"+s.systemAddress.slice(-8) : "…";
    const lastSign = s?.lastUserSign ? new Date(s.lastUserSign.at).toLocaleString() : null;
    return `
      <section class="account-card">
        <div class="account-section-head">
          <div>
            <div class="eyebrow">DATEN-KETTE · LOKAL SIGNIERT</div>
            <h3>Kryptografische Kette aller deiner Daten</h3>
            <p>Jede Nachricht, jedes Projekt, jede Datei und jedes Kompressions-Archiv wird live — auch offline — gehasht, mit dem vorherigen Eintrag verkettet und vom OpenOS-System-Wallet gaslos signiert (Base, EIP-191). Inhalte bleiben auf diesem Gerät; die Kette wird nie an OpenOS-Server geschickt.</p>
          </div>
          <div class="account-actions">
            <button class="action-btn white" id="chainVerifyBtn">Kette prüfen</button>
            <button class="action-btn" id="chainExportBtn">Exportieren</button>
            <button class="action-btn" id="chainSignBtn">Mit meiner Wallet signieren</button>
          </div>
        </div>
        <div class="settings-field"><span>Eingehängte Daten</span><strong id="chainCount">${s?s.entries.toLocaleString():"…"}</strong></div>
        <div class="settings-field"><span>Kopf-Hash</span><strong class="mono" id="chainHead">${headHash}</strong></div>
        <div class="settings-field"><span>System-Wallet (Base, gaslos)</span><strong class="mono" id="chainAddr">${addr}</strong></div>
        <div class="settings-field"><span>Deine Wallet-Signatur</span><strong id="chainUserSign">${lastSign?lastSign+" · "+(s.lastUserSign.count||0)+" Einträge":"noch nicht — braucht Online-Verbindung"}</strong></div>
        <div id="chainWalletBlock">${chainWalletHTML()}</div>
        <small id="chainStatus" class="settings-note" aria-live="polite">Die Hash-Kette läuft offline weiter. Base-Signaturen mit deiner Wallet sind online möglich.</small>
      </section>`;
  }

  // Wallet-Login (SIWE) — einzige Implementierung, gehostet von momoChain.
  // Das regelmässige Signieren (live) delegiert an dieselbe Daten-Kette.
  function chainWalletHTML(){
    const MC = ns.momoChain;
    if(!MC) return "";
    const w = MC.wallet?.();
    const list = MC.walletList?.() || [];
    const s = MC.settings?.() || {};
    const walletOptions = list.map((x)=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
    if(w){
      return `
        <div class="settings-field"><span>Deine Wallet (Base)</span><strong class="mono">${esc(w.address.slice(0,10))}…${esc(w.address.slice(-8))}</strong></div>
        <label class="settings-toggle"><span><strong>Kopf-Hash regelmässig signieren</strong><small>Deine Wallet signiert den Stand der Daten-Kette automatisch. Es geht keine Transaktion an Base, es wird nichts in die Blockchain geschrieben.</small></span><input id="chainWalletLive" type="checkbox" ${s.live?"checked":""}></label>
        <label class="settings-field"><span>Alle … Einträge</span><input id="chainWalletEvery" type="number" min="1" max="10000" value="${Number(s.every)||25}"></label>
        <div class="account-actions">
          <button class="action-btn white" type="button" id="chainWalletSignNow">Jetzt signieren</button>
          <button class="action-btn" type="button" id="chainWalletLogout">Wallet abmelden</button>
        </div>`;
    }
    return `
      <p style="margin:10px 0 6px">Melde dich mit deiner eigenen Wallet an (z. B. Coinbase Wallet, MetaMask, Rabby), um den Kopf der Kette zusätzlich mit deiner Wallet zu signieren. Private Schlüssel bleiben in der Wallet — die Anmeldung ist mit „Sign-In with Ethereum" signiert.</p>
      ${list.length>1?`<label class="settings-field"><span>Wallet</span><select id="chainWalletSelect">${walletOptions}</select></label>`:""}
      <div class="account-actions"><button class="action-btn white" type="button" id="chainWalletLogin">${list.length?"Mit Wallet anmelden":"Keine Wallet gefunden"}</button></div>`;
  }

  async function repaintWalletBlock(){
    const el = document.getElementById("chainWalletBlock");
    if(el) el.innerHTML = chainWalletHTML();
    bindChainWalletUI();
  }

  function bindChainWalletUI(){
    const MC = ns.momoChain;
    if(!MC) return;
    const status = (t)=>{ const el=document.getElementById("chainStatus"); if(el) el.textContent=t; };
    document.getElementById("chainWalletLogin")?.addEventListener("click", async ()=>{
      try{ await MC.login(document.getElementById("chainWalletSelect")?.value); ns.ui?.toast?.("Mit Wallet angemeldet."); await repaintWalletBlock(); await paintChain(); }
      catch(e){ ns.ui?.toast?.(e?.message||"Anmeldung abgebrochen."); }
    });
    document.getElementById("chainWalletLogout")?.addEventListener("click", async ()=>{
      await MC.logout(); ns.ui?.toast?.("Wallet abgemeldet."); await repaintWalletBlock(); await paintChain();
    });
    document.getElementById("chainWalletLive")?.addEventListener("change", (e)=>{ MC.saveSettings({ live:e.target.checked }); });
    document.getElementById("chainWalletEvery")?.addEventListener("change", (e)=>{ MC.saveSettings({ every:Math.max(1, Number(e.target.value)||25) }); });
    document.getElementById("chainWalletSignNow")?.addEventListener("click", async ()=>{
      try{
        status("Warte auf die Wallet-Signatur …");
        const rec = await MC.anchor({ reason:"account" });
        status(`Signiert: Kopf-Hash (${rec.count} Einträge) mit ${rec.address.slice(0,6)}…${rec.address.slice(-4)} auf Base (gaslos, keine Transaktion).`);
        await paintChain();
      }catch(e){ status(String(e?.message||"Signatur abgebrochen.")); }
    });
  }

  async function paintChain(){
    const D = ns.dataChain;
    if(!D) return;
    chainStats = await D.stats().catch(()=>null);
    const set = (id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
    if(!chainStats) return;
    set("chainCount", chainStats.entries.toLocaleString());
    set("chainHead", chainStats.head?.hash ? chainStats.head.hash.slice(0,18)+"…" : "–");
    set("chainAddr", chainStats.systemAddress ? chainStats.systemAddress.slice(0,10)+"…"+chainStats.systemAddress.slice(-8) : "–");
    set("chainUserSign", chainStats.lastUserSign ? new Date(chainStats.lastUserSign.at).toLocaleString()+" · "+(chainStats.lastUserSign.count||0)+" Einträge" : "noch nicht — braucht Online-Verbindung");
  }

  function bindChainUI(){
    const status = (t)=>{ const el=document.getElementById("chainStatus"); if(el) el.textContent=t; };
    document.getElementById("chainVerifyBtn")?.addEventListener("click", async ()=>{
      status("Prüfe Verkettung, Hashes und alle Signaturen …");
      const r = await ns.dataChain.verify({ checkData:true });
      status(r.valid
        ? `Gültig: ${r.entries.toLocaleString()} Einträge, alle Signaturen stimmen${r.checked?` — ${r.checked} echte Daten erneut gehasht, ${r.changed} Abweichungen`:""}.`
        : `Ungültig bei Eintrag ${r.brokenAt}: ${r.reason}`);
    });
    document.getElementById("chainExportBtn")?.addEventListener("click", async ()=>{
      ns.dataChain.download("momo-datachain.json", await ns.dataChain.exportChain());
      status("Kette exportiert — nur Hashes und Signaturen, keine Inhalte.");
    });
    document.getElementById("chainSignBtn")?.addEventListener("click", async ()=>{
      try{
        status("Warte auf die Wallet-Signatur …");
        const rec = await ns.dataChain.signHeadWithUserWallet({ reason:"account" });
        status(`Signiert: Kopf-Hash mit ${rec.address.slice(0,6)}…${rec.address.slice(-4)} auf Base (gaslos, keine Transaktion).`);
        await paintChain();
      }catch(e){ status(String(e?.message||"Signatur abgebrochen.")); }
    });
    document.addEventListener("momo:datachain", ()=>paintChain(), { passive:true });
    document.addEventListener("momo:datachain-sign", ()=>paintChain(), { passive:true });
    document.addEventListener("momo:wallet", ()=>repaintWalletBlock(), { passive:true });
    bindChainWalletUI();
  }

  function bindApiUI(){
    document.getElementById("createApiKeyBtn")?.addEventListener("click",()=>createApiKey());
    document.getElementById("refreshApiKeysBtn")?.addEventListener("click",()=>refreshApiKeys().catch(e=>ns.ui?.toast?.(e.message)));
    document.getElementById("copyCreatedApiKeyBtn")?.addEventListener("click",()=>copyText(lastCreatedKey?.api_key||""));
    document.getElementById("copySdkBtn")?.addEventListener("click",()=>copyText(document.querySelector(".api-sdk-code code")?.textContent||""));
    document.getElementById("copyEndpointBtn")?.addEventListener("click",()=>copyText(document.getElementById("mcpEndpointText")?.textContent?.trim()||""));
  }

  function render(){
    const host=document.getElementById("accountIdentityContent");
    if(!host)return;

    const user=ns.auth?.currentUser?.();
    if(!user){
      host.innerHTML="";
      return;
    }
    if(loading){
      host.innerHTML=ns.polish?.loadingHTML?.("Account wird geladen …",3)||'<div class="runtime-source-detail">Account wird geladen …</div>';
      return;
    }

    host.innerHTML=`
      ${migrationHTML()}

      <div class="account-columns">
        <section class="account-card">
          <div class="eyebrow">PROFIL</div>
          <div class="profile-form">
            <label>Anzeigename
              <input id="profileDisplayName" value="${esc(profile?.display_name||"")}" maxlength="80" placeholder="Dein Name">
            </label>
            <div class="profile-auto-locale" aria-live="polite">
              <span>Sprache</span>
              <strong>Automatisch · ${esc(localeLabel())}</strong>
            </div>
          </div>
          <button class="action-btn white" id="saveProfileBtn">Profil speichern</button>
        </section>

        <section class="account-card">
          <div class="eyebrow">ANMELDEMETHODE</div>
          <div class="identity-list">
            <div class="identity-row">
              <div>
                <strong>Privater Geräte-Schlüssel</strong>
                <span>Handle + 6-stelliger PIN. Der P-384-Schlüssel (CNSA 2.0) ist unlöschbar in diesem Gerät gespeichert und kann nie exportiert werden — die PIN verlässt dein Gerät nie.</span>
              </div>
              <span class="status-pill ok">Aktiv</span>
            </div>
          </div>
        </section>
      </div>

      <section class="account-card">
        <div class="account-section-head">
          <div>
            <div class="eyebrow">GERÄTE</div>
            <h3>Angemeldete Momo-Geräte</h3>
            <p>Hier siehst du Geräte, die diesen Momo-Account verwendet haben.</p>
          </div>
          <button class="action-btn" id="signOutOthersBtn">Andere Sessions abmelden</button>
        </div>
        <div class="device-list">${devicesHTML()}</div>
      </section>

      ${apiSectionHTML()}

      ${chainSectionHTML()}
    `;

    document.getElementById("saveProfileBtn")?.addEventListener("click",()=>saveProfile().catch(e=>ns.ui?.toast?.(e.message)));
    document.getElementById("adoptLocalBtn")?.addEventListener("click",()=>adoptLocalWorkspace().catch(e=>ns.ui?.toast?.(e.message)));
    document.getElementById("keepLocalSeparateBtn")?.addEventListener("click",()=>{localBindingConflict=null;render()});
    document.getElementById("detachLocalBtn")?.addEventListener("click",()=>detachLocalWorkspace().catch(e=>ns.ui?.toast?.(e.message)));
    document.getElementById("signOutOthersBtn")?.addEventListener("click",()=>ns.auth.signOutOtherSessions().then(()=>ns.ui?.toast?.("Andere Sessions abgemeldet")).catch(e=>ns.ui?.toast?.(e.message)));

    host.querySelectorAll("[data-revoke-device]").forEach(btn=>btn.addEventListener("click",()=>revokeDevice(btn.dataset.revokeDevice).catch(e=>ns.ui?.toast?.(e.message))));
    bindApiUI();
    paintApiKeys();
    refreshApiKeys();
    bindChainUI();
    paintChain();
  }

  async function init(){
    document.addEventListener("momo:authchange",()=>void load());
    await load();
  }

  ns.account={init,load,render,profile:()=>profile,devices:()=>[...devices],deviceKey,hasLocalData,detectedLocale,refreshApiKeys};
})(window.MomoApp=window.MomoApp||{});