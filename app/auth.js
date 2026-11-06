"use strict";
/* OpenOS Auth — Private-Key-Token-Login (Handle + PIN).
 *
 * Das E-Mail-Magic-Link-Login ist ersetzt: Identität = privater Geräte-
 * Schlüssel (P-384, non-extractable, unlöschbar im Gerät) + universelles
 * Handle + 6-stelliger PIN. Challenge-Response gegen den eigenen Auth-
 * Service auf openos.benz (Registry auf IPFS gepinnt). Die PIN verlässt
 * das Gerät nie — der Server prüft nur einen PBKDF2-Verifizierer.
 *
 * getClient() liefert den lokalen OpenOS-Backend-Client: dieselbe
 * Supabase-API-Oberfläche (from/select/insert/upsert/update/eq/order/
 * maybeSingle/single), aber die Daten leben im Gerät (localStorage,
 * pro User) — Cloud-Sync folgt verschlüsselt über denselben Dienst.
 * Offline heißt nie wieder abgemeldet.
 */
(function(ns){
  const DB_KEY="openos-db-v1";
  const detectedLocale=()=>{
    const candidates=[...(navigator.languages||[]),navigator.language].filter(Boolean);
    for(const value of candidates){
      try{
        const canonical=Intl.getCanonicalLocales(String(value))[0];
        if(canonical)return canonical.slice(0,24);
      }catch{}
    }
    return "en";
  };
  const redirectURL=()=>{
    const u=new URL(location.href);
    u.search="";u.hash="";
    return u.toString();
  };
  const magicLinkVerification=()=>null;

  /* ── Lokaler OpenOS-Backend-Client ──────────────────────────── */
  function ladeDb(){
    try{return JSON.parse(localStorage.getItem(DB_KEY)||"{}")}catch{return{}}
  }
  function speichereDb(db){
    try{localStorage.setItem(DB_KEY,JSON.stringify(db))}catch{}
  }
  function uid(){
    return "os_"+crypto.getRandomValues(new Uint8Array(16)).reduce((s,b)=>s+b.toString(16).padStart(2,"0"),"");
  }
  function query(usr,table){
    const filters=[];let patch=null;let op="select";let orderBy=null;let lim=null;
    const client={
      select(){op="select";return client},
      insert(rows){op="insert";patch=Array.isArray(rows)?rows:[rows];return client},
      upsert(row){op="upsert";patch=[row];return client},
      update(p){op="update";patch=p;return client},
      delete(){op="delete";return client},
      eq(f,v){filters.push(r=>String(r?.[f])===String(v));return client},
      neq(f,v){filters.push(r=>String(r?.[f])!==String(v));return client},
      is(f,v){filters.push(r=>(r?.[f]==null)===Boolean(v));return client},
      order(col,{ascending=true}={}){
        orderBy={col,dir:ascending?1:-1};return client;
      },
      limit(n){lim=n;return client},
      async maybeSingle(){const r=await ausfuehren();if(r.error)return{data:null,error:r.error};
        return{data:(r.data&&r.data[0])??null,error:null}},
      async single(){const r=await ausfuehren();if(r.error)return{data:null,error:r.error};
        if(!r.data?.length)return{data:null,error:{message:"Nicht gefunden."}};
        if(r.data.length>1)return{data:null,error:{message:"Mehrdeutig."}};
        return{data:r.data[0],error:null}},
      then(res,rej){return ausfuehren().then(res,rej)}
    };
    async function ausfuehren(){
      const db=ladeDb();
      const slot=(db[usr.id]=db[usr.id]||{});
      const rows=(slot[table]=slot[table]||[]);
      const treffer=()=>rows.filter(r=>filters.every(f=>f(r)));
      if(op==="select"){
        let out=treffer().map(r=>({...r}));
        if(orderBy)out.sort((a,b)=>{
          const x=a?.[orderBy.col],y=b?.[orderBy.col];
          return(x<y?-1:x>y?1:0)*orderBy.dir;
        });
        if(lim!=null)out=out.slice(0,lim);
        return{data:out,error:null};
      }
      if(op==="insert"){
        const neu=patch.map(r=>({id:r.id||uid(),created_at:r.created_at||new Date().toISOString(),...r}));
        rows.push(...neu);
        speichereDb(db);
        return{data:neu.length===1?neu[0]:neu,error:null};
      }
      if(op==="upsert"){
        for(const r of patch){
          const vorhanden=rows.find(x=>x.id===r.id);
          if(vorhanden)Object.assign(vorhanden,r,{updated_at:new Date().toISOString()});
          else rows.push({id:r.id||uid(),created_at:new Date().toISOString(),...r});
        }
        speichereDb(db);
        return{data:patch.length===1?patch[0]:patch,error:null};
      }
      if(op==="update"){
        const t=treffer();
        for(const r of t)Object.assign(r,patch,{updated_at:new Date().toISOString()});
        speichereDb(db);
        return{data:t,error:null};
      }
      if(op==="delete"){
        const t=treffer();
        slot[table]=rows.filter(r=>!t.includes(r));
        speichereDb(db);
        return{data:t,error:null};
      }
      return{data:null,error:{message:"Unbekannte Operation."}};
    }
    return client;
  }

  /* ── Lokales Credit-Ledger (openos-credits-v1) ───────────────
   * Ersetzt die serverseitige Buchung: Status-RPC liefert den lokalen
   * Stand, der Verbrauchs-RPC bucht idempotent (p_ref) lokal ab.
   * Kauf-Gutschriften (Bitcoin) schreiben direkt hier ein. */
  const WALLET_KEY="openos-credits-v1";
  function wallet(){try{return JSON.parse(localStorage.getItem(WALLET_KEY)||"{}")}catch{return{}}}
  function walletSpeichern(w){try{localStorage.setItem(WALLET_KEY,JSON.stringify(w))}catch{}}
  function walletStand(){
    const w=wallet();
    return{credits:{balance:Number(w.balance||0),available:Number(w.balance||0),reserved:0,
      purchased:Number(w.purchased||0),spent:Number(w.spent||0)},analytics:null};
  }
  function walletBuchen(menge,grund,ref){
    const w=wallet();
    w.refs=w.refs||{};
    if(ref&&w.refs[ref])return{ok:true,balance:Number(w.balance||0),bereitsBuchung:true};
    const m=Math.max(0,Number(menge)||0);
    w.balance=Math.max(0,Number(w.balance||0)-m);
    w.spent=Number(w.spent||0)+m;
    if(ref)w.refs[ref]=m;
    walletSpeichern(w);
    return{ok:true,balance:w.balance};
  }
  function walletGutschreiben(menge,ref){
    const w=wallet();
    w.refs=w.refs||{};
    if(ref&&w.refs["kauf:"+ref])return{ok:true,balance:Number(w.balance||0),bereitsBuchung:true};
    const m=Math.max(0,Number(menge)||0);
    w.balance=Number(w.balance||0)+m;
    w.purchased=Number(w.purchased||0)+m;
    if(ref)w.refs["kauf:"+ref]=m;
    walletSpeichern(w);
    return{ok:true,balance:w.balance};
  }

  let clientCache=null;
  async function getClient(){
    if(clientCache)return clientCache;
    const user=ns.keyAuth.currentUser();
    if(!user)throw new Error("Bitte zuerst mit Handle + PIN anmelden.");
    const usr=user;
    clientCache={
      from:t=>query(usr,t),
      auth:{
        signOut:()=>ns.keyAuth.signOut(),
        getSession:async()=>({data:{session:ns.keyAuth.currentSession()}}),
        onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})
      },
      functions:{
        invoke:async(name,args)=>{
          // Kredit-Status lokal beantworten; alles andere ehrlich ablehnen.
          if(String(name).includes("manage_status")||String(name).includes("credit")){
            const w=JSON.parse(localStorage.getItem("openos-credits-v1")||'{"guthaben":0,"warteschlange":[]}');
            return{data:{guthaben:w.guthaben,waehrung:"credits"},error:null};
          }
          return{data:null,error:{message:"Funktion '"+name+"' läuft auf dem lokalen OpenOS-Backend noch nicht — Etappe 2 (IPFS-Sync)."}};
        }
      },
      rpc:async(name,args)=>{
        const n=String(name||"");
        const cfg=window.MOMO_CONFIG||{};
        // Credit-Status: lokales Ledger
        if(n===cfg.credits?.statusRpc||/manage_status|credit_status/i.test(n)){
          return{data:walletStand(),error:null};
        }
        // Credit-Verbrauch: lokal, idempotent über p_ref
        if(/consume_credit/i.test(n)){
          const r=walletBuchen(args?.p_amount,args?.p_reason,args?.p_ref);
          return{data:{ok:r.ok,balance:r.balance},error:null};
        }
        return{data:null,error:{message:"Funktion '"+n+"' läuft lokal noch nicht — dezentraler Sync folgt."}};
      },
      /* Direkter Zugriff fuer den Bitcoin-Kauf (Gutschrift nach Zahlungseingang). */
      openosWallet:{stand:walletStand,gutschreiben:walletGutschreiben,buchen:walletBuchen,wallet,walletSpeichern}
    };
    return clientCache;
  }

  /* ── Auth-API der App (gleiche Oberfläche wie bisher) ───────── */
  async function init(){
    const initP=ns.keyAuth.init();
    // Login-Formular (Handle + PIN) verdrahten
    if(document.readyState==="loading"){
      document.addEventListener("DOMContentLoaded",bindeLoginUI);
    }else bindeLoginUI();
    return initP;
  }

  function loginFormularHTML(){
    const hatSchluessel=ns.keyAuth.hatGeraeteSchluessel();
    return `
      <div class="email-login key-login" style="flex-direction:column;align-items:stretch;gap:10px">
        <input id="keyAuthHandle" autocomplete="username" placeholder="Handle (z. B. satoshi)" aria-label="Handle"
          value="${hatSchluessel?escAttr(ns.keyAuth.handle()||""):""}" ${hatSchluessel?"readonly":""}>
        <input id="keyAuthPin" type="password" inputmode="numeric" maxlength="6" autocomplete="off"
          placeholder="6-stelliger PIN" aria-label="PIN">
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="action-btn white" id="keyAuthSignIn" type="button">Anmelden</button>
          <button class="action-btn" id="keyAuthRegister" type="button">${hatSchluessel?"Neues Konto (löscht Geräteschlüssel)":"Konto erstellen"}</button>
        </div>
        <button class="action-btn" id="keyAuthRecoverToggle" type="button" style="align-self:flex-start;opacity:.85">Konto wiederherstellen (16 Worte)</button>
        <div id="keyAuthRecoverBox" hidden style="display:flex;flex-direction:column;gap:8px;border-top:1px solid rgba(255,255,255,.12);padding-top:10px">
          <input id="keyAuthRecHandle" placeholder="Handle" aria-label="Handle wiederherstellen" autocomplete="username">
          <textarea id="keyAuthRecPhrase" rows="3" placeholder="16 Worte, Leerzeichen-getrennt" aria-label="Recovery-Phrase"></textarea>
          <details><summary style="cursor:pointer;opacity:.75;font-size:12px">Bundle manuell einfügen (nur falls automatischer Abruf fehlschlägt)</summary>
            <textarea id="keyAuthRecBundle" rows="2" placeholder="iv.ciphertext (base64.base64)" aria-label="Recovery-Bundle"></textarea>
          </details>
          <input id="keyAuthRecPin" type="password" inputmode="numeric" maxlength="6" placeholder="Neuer 6-stelliger PIN" aria-label="Neue PIN">
          <button class="action-btn white" id="keyAuthRecover" type="button">Wiederherstellen</button>
        </div>
      </div>
      <p class="auth-note">Private-Key-Login: Dein Geräteschlüssel (P-384, CNSA 2.0) ist unlöschbar in diesem Gerät gespeichert —
        er kann nie exportiert werden. Die PIN verlässt dein Gerät nie. Ohne Internet bleibst du angemeldet.</p>`;
  }
  const escAttr=s=>String(s??"").replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;");

  /* Recovery-Phrase nach der Registrierung einmalig zeigen. */
  function zeigePhrase(phrase,handle){
    if(!Array.isArray(phrase)||!phrase.length)return;
    const alt=document.getElementById("keyAuthPhraseModal");
    if(alt)alt.remove();
    const worte=phrase.map((w,i)=>`<span style="display:inline-block;background:rgba(255,255,255,.08);border-radius:8px;padding:4px 8px;margin:2px"><b style="opacity:.6;font-size:10px">${i+1}</b> ${escAttr(w)}</span>`).join(" ");
    const modal=document.createElement("div");
    modal.id="keyAuthPhraseModal";
    modal.setAttribute("role","dialog");
    modal.setAttribute("aria-modal","true");
    modal.style.cssText="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:20px";
    modal.innerHTML=`<div style="max-width:560px;width:100%;background:#14161c;border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:24px;color:#fff">
      <h3 style="margin:0 0 8px">Deine 16 Worte — einmalig sichtbar</h3>
      <p style="opacity:.8;font-size:13px;line-height:1.5">Diese Worte sind der <b>einzige</b> Weg, dein Konto <b>@${escAttr(String(handle||"").toLowerCase())}</b> auf einem neuen Gerät wiederherzustellen.
        Notiere sie <b>offline</b> (Papier). Sie werden nirgends gespeichert und können nicht erneut angezeigt werden.
        Das dezentrale Recovery-Bundle ist öffentlich, aber nur diese Worte öffnen es.</p>
      <div style="margin:14px 0;line-height:2">${worte}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end">
        <button class="action-btn" id="keyAuthPhraseCopy" type="button">Kopieren</button>
        <button class="action-btn white" id="keyAuthPhraseOk" type="button">Ich habe sie notiert</button>
      </div></div>`;
    document.body.appendChild(modal);
    document.getElementById("keyAuthPhraseCopy").addEventListener("click",()=>{
      navigator.clipboard?.writeText(phrase.join(" ")).then(()=>ns.ui?.toast?.("Phrase kopiert — bitte danach offline notieren."));
    });
    document.getElementById("keyAuthPhraseOk").addEventListener("click",()=>modal.remove());
  }

  function bindeLoginUI(){
    document.querySelectorAll(".email-login").forEach(feld=>{
      if(feld.dataset.keyauth==="1")return;
      feld.dataset.keyauth="1";
      feld.outerHTML=loginFormularHTML();
    });
    document.getElementById("keyAuthSignIn")?.addEventListener("click",()=>{
      const handle=document.getElementById("keyAuthHandle")?.value||"";
      const pin=document.getElementById("keyAuthPin")?.value||"";
      ns.keyAuth.signIn({handle,pin}).catch(e=>ns.ui?.toast?.(e.message||"Anmeldung fehlgeschlagen."));
    });
    document.getElementById("keyAuthRegister")?.addEventListener("click",async()=>{
      const handle=document.getElementById("keyAuthHandle")?.value||"";
      const pin=document.getElementById("keyAuthPin")?.value||"";
      try{
        const r=await ns.keyAuth.registriere({handle,pin});
        zeigePhrase(r.phrase,r.handle);
        bindeLoginUI();
      }catch(e){ns.ui?.toast?.(e.message||"Registrierung fehlgeschlagen.")}
    });
    document.getElementById("keyAuthRecoverToggle")?.addEventListener("click",()=>{
      const box=document.getElementById("keyAuthRecoverBox");
      if(box)box.hidden=!box.hidden;
    });
    document.getElementById("keyAuthRecover")?.addEventListener("click",async()=>{
      const handle=document.getElementById("keyAuthRecHandle")?.value||"";
      const phrase=(document.getElementById("keyAuthRecPhrase")?.value||"").trim();
      const bundleB64=(document.getElementById("keyAuthRecBundle")?.value||"").trim();
      const neuerPin=document.getElementById("keyAuthRecPin")?.value||"";
      try{
        await ns.keyAuth.wiederherstellen({handle,phrase,bundleB64,neuerPin});
        ns.ui?.toast?.("Konto @"+handle.toLowerCase()+" wiederhergestellt — bitte mit neuer PIN anmelden.");
        bindeLoginUI();
      }catch(e){ns.ui?.toast?.(e.message||"Wiederherstellung fehlgeschlagen.")}
    });
    document.getElementById("keyAuthPin")?.addEventListener("keydown",e=>{
      if(e.key==="Enter")document.getElementById("keyAuthSignIn")?.click();
    });
  }

  async function signInEmail(){
    throw new Error("E-Mail-Login ist ersetzt durch Private-Key-Login: Handle + PIN.");
  }
  async function refresh(){return ns.keyAuth.currentSession()}
  async function requireSession(opts){return ns.keyAuth.requireSession(opts)}
  function currentSession(){return ns.keyAuth.currentSession()}
  function currentUser(){return ns.keyAuth.currentUser()}
  async function signOut(scope="local"){return ns.keyAuth.signOut(scope)}
  async function signOutOtherSessions(){return{error:null}}

  ns.auth={init,refresh,signInEmail,signOut,signOutOtherSessions,currentSession,currentUser,
    requireSession,getClient,redirectURL,detectedLocale,magicLinkVerification};
})(window.MomoApp=window.MomoApp||{});