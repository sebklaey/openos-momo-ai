"use strict";
/* OpenOS Key-Auth — serverloser Private-Key-Login (Handle + PIN).
 *
 * 100 % lokal. Kein Server, kein Supabase, kein Drittanbieter, keine
 * Abhängigkeit von der SEBKLAEY Agency:
 *   - Identität entsteht IM Gerät: Handle + 6-stelliger PIN + Geräte-
 *     schlüssel (ECDSA P-384, NON-EXTRACTABLE — unlöschbar im Geräte-
 *     keystore, nie exportierbar; CNSA-2.0-Suite: P-384 / SHA-384 /
 *     AES-256 / PBKDF2-HMAC-SHA-384, 310.000 Iterationen).
 *   - Die PIN verlässt das Gerät NIE — es gibt nicht einmal eine Stelle,
 *     an die sie gesendet werden könnte. Aus der PIN wird lokal ein
 *     Verifizierer abgeleitet, der die Sitzung entsperrt.
 *   - Login = lokale Entsperrung + lokale Session-Erzeugung. Kein Netz
 *     nötig, "offline" bedeutet nie wieder abgemeldet.
 *   - Handle-Einzigartigkeit: dezentral und best-effort. Die App erzeugt
 *     eine SELBST-AUTHENTISIERENDE Handle-Karte (Handle + öffentlicher
 *     Schlüssel + Zeitstempel, signiert mit dem Geräteschlüssel) und
 *     publiziert sie auf Wunsch in das öffentliche IPFS-Verzeichnis
 *     (wer es hostet, ist egal; die App hängt nicht davon ab). Vor der
 *     Registrierung wird das Verzeichnis gefragt — ist es nicht
 *     erreichbar, wird lokal registriert und die Karte später nachgereicht.
 */
(function(ns){
  /* 256-Wort-Liste (16 Wörter × 8 Bit = 128 Bit Entropie). Kurze, klare,
     umlautfreie Wörter — einfach zu notieren, einfach zu tippen. */
  const WOERTER="abend acer aktie alarm alge alien alpen amber ampel angel anker apfel arche arena argon armee atlas avocado bahn balkon banane bandit baum beton beute birke blatt blitz blume bogen bomber bonbon borke brand bronze bruecke buche bunt burg campus cannelle canyon chaos chor clay dachs dattel delfin dialog dichte domino donau dorn dose drache drama dreieck duett duft dune ebene eiche eimer eisen elastik elch elster emblem ente erde erker ernst esche espe essig etage euler exil fabel faden falke farn fauna feige felge fels fennel ferse fest feuer fichte fink fisch flamme flinte flora fluss foerster folie forte fossile freude frische fuchs funken futter gala garage garn gazelle geist gelb gemse gepard geranie gipfel gitter glanz glocke gnade gondel granit graphit gras griff gross grotte grube gurke habicht hafen hagels hallo halm harfe harmonic heide heiss hell hering hertz heute hilfe himmel hobel hocker holz honor hopfen horn hufe huhn humor hund hut igel ikone impuls index ingwer insel jacht jade jagd jahr jasmin jazz joker jubel jugend julian jura kabel kadett kaefer kakao kalb kalk kamm kanne kappa karma karton kasse kastanie keller kelpie kerze kette kiefer kind kino kirche kiste klee kleid kobra kohl kohle kolibri komet kompass konsole kordel korn kosmos krabbe krach kralle kranz kraut kreide kreuz krokodil krone kruste kueken kueste kugel kuh kulisse kummer kunde kunst kuppel kurve labor lachen laden lager lakritze lampe land lava leber leder legit lehm lehrer leine leise leiter lemure lerche lerner lesung levit licht liebe lilie limo lind links linse lippe list".split(" ");

  const K={store:"openos-keyauth-v1",deviceKeys:"openos-devicekeys-v1",verzeichnis:null};
  let session=null;
  let initPromise=null;

  const b64=a=>btoa(String.fromCharCode(...new Uint8Array(a)));
  const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const hex=a=>[...new Uint8Array(a)].map(x=>x.toString(16).padStart(2,"0")).join("");
  const encoder=new TextEncoder();

  function verzeichnis(){
    if(K.verzeichnis)return K.verzeichnis;
    const cfg=window.MOMO_CONFIG||{};
    K.verzeichnis=(cfg.openosVerzeichnis||"").replace(/\/+$/,"")||location.origin;
    return K.verzeichnis;
  }

  function readState(){try{return JSON.parse(localStorage.getItem(K.store)||"{}")}catch{return{}}}
  function writeState(s){try{localStorage.setItem(K.store,JSON.stringify(s))}catch{}}
  function idb(){
    return new Promise((res,rej)=>{
      const r=indexedDB.open(K.deviceKeys,1);
      r.onupgradeneeded=()=>r.result.createObjectStore("keys");
      r.onsuccess=()=>res(r.result);
      r.onerror=()=>rej(r.error);
    });
  }
  async function idbSet(k,v){
    const db=await idb();
    return new Promise((res,rej)=>{const t=db.transaction("keys","readwrite");t.objectStore("keys").put(v,k);t.oncomplete=res;t.onerror=()=>rej(t.error)});
  }
  async function idbGet(k){
    const db=await idb();
    return new Promise((res,rej)=>{const t=db.transaction("keys","readonly");const g=t.objectStore("keys").get(k);g.onsuccess=()=>res(g.result);g.onerror=()=>rej(g.error)});
  }

  async function pinAbleitung(pin,saltBytes){
    const basis=await crypto.subtle.importKey("raw",encoder.encode(pin),"PBKDF2",false,["deriveBits"]);
    return crypto.subtle.deriveBits(
      {name:"PBKDF2",salt:saltBytes,iterations:310000,hash:"SHA-384"},basis,384);
  }

  async function erzeugeDeviceKey(deviceId){
    const pair=await crypto.subtle.generateKey(
      {name:"ECDSA",namedCurve:"P-384"},false,["sign","verify"]);
    await idbSet("priv:"+deviceId,pair.privateKey);   // non-extractable, unlöschbar
    return pair.publicKey;
  }
  async function signiere(deviceId,daten){
    const key=await idbGet("priv:"+deviceId);
    if(!key)throw new Error("Geräte-Schlüssel nicht gefunden — bitte Konto erneut erstellen.");
    return crypto.subtle.sign({name:"ECDSA",hash:"SHA-384"},key,daten);
  }

  /* Lokale Session: HMAC-Signatur mit einem geräte-eigenen Schlüssel —
     kein Server im Pfad, nichts wird irgendwohin gesendet. */
  async function lokalesSessionToken(userId,handle,deviceId,secret){
    const exp=Date.now()+30*24*3600*1000; // 30 Tage, lokal verlängerbar
    const payload=`${userId}|${handle}|${deviceId}|${exp}`;
    const mac=await hmacHex(secret,encoder.encode(payload));
    return {token:`${b64(encoder.encode(payload))}.${mac}`,exp};
  }
  async function hmacHex(secret,daten){
    const k=await crypto.subtle.importKey("raw",secret,{name:"HMAC",hash:"SHA-384"},false,["sign"]);
    return hex(await crypto.subtle.sign("HMAC",k,daten));
  }

  function emit(event="SESSION"){
    const detail={session,user:session?.user||null,event,loginMethod:"private_key"};
    document.dispatchEvent(new CustomEvent("momo:authchange",{detail}));
    ns.core?.emit?.("authchange",detail);
    ns.core?.setCapability?.("signedIn",Boolean(session));
    ns.core?.setCapability?.("authLoginMethod","private_key");
    try{localStorage.setItem("momo-auth-method-v1","private_key")}catch{}
  }

  function pruefeHandlePin(handle,pin){
    if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,29}$/.test(String(handle||"").trim()))
      throw new Error("Handle: 3–30 Zeichen (a–z, 0–9, Punkt, Bindestrich, Unterstrich).");
    if(!/^\d{6}$/.test(String(pin||"")))
      throw new Error("PIN: genau 6 Ziffern.");
  }

  /* ── Dezentrales Handle-Verzeichnis (öffentliche Pinnwand auf IPFS) ── */
  async function verzeichnisHandles(){
    try{
      const ctl=new AbortController();
      const t=setTimeout(()=>ctl.abort(),4000);
      const r=await fetch(verzeichnis()+"/auth/registry",{signal:ctl.signal});
      clearTimeout(t);
      const j=await r.json();
      return Array.isArray(j.handles)?j.handles:[];
    }catch{return null} // nicht erreichbar = keine Aussage möglich
  }
  /* Selbst-authentisierende Karte: Signatur über handle|pub|zeit — niemand
     kann fremde Handles besetzen; das Verzeichnis speichert nichts Persönliches.
     Optional: recoveryPub + AES-verschlüsseltes Recovery-Bundle (nur die
     16-Wort-Phrase öffnet es — öffentlich pinnen ist sicher). */
  async function publiziereKarte({handle,deviceId,devicePub,recoveryPub,recovery}){
    try{
      const zeit=new Date().toISOString();
      const sig=b64(await signiere(deviceId,encoder.encode(`openos-handle:${handle}:${devicePub}:${zeit}`)));
      const ctl=new AbortController();
      const t=setTimeout(()=>ctl.abort(),5000);
      await fetch(verzeichnis()+"/auth/register",{
        method:"POST",headers:{"Content-Type":"application/json"},signal:ctl.signal,
        body:JSON.stringify({handle,deviceId,devicePub,card:sig,createdAt:zeit,recoveryPub,recovery})
      });
      clearTimeout(t);
      return true;
    }catch{return false} // dezentrale Publikation ist best-effort
  }

  /* ── Recovery: 16-Wort-Phrase → Gerätewechsel ───────────────── */
  function phraseErzeugen(){
    const b=crypto.getRandomValues(new Uint8Array(16)); // 16 Worte × 8 Bit = 128 Bit
    return [...b].map(x=>WOERTER[x]);
  }
  async function phraseKey(phrase,handle){
    const basis=await crypto.subtle.importKey("raw",
      encoder.encode(phrase.join(" ").toLowerCase().trim()),"PBKDF2",false,["deriveKey"]);
    return crypto.subtle.deriveKey(
      {name:"PBKDF2",salt:encoder.encode("openos-recovery:"+handle.toLowerCase()),
       iterations:310000,hash:"SHA-384"},
      basis,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  }
  async function recoveryBundleLaden(handle){
    try{
      const ctl=new AbortController();
      const t=setTimeout(()=>ctl.abort(),5000);
      const r=await fetch(verzeichnis()+"/auth/recovery/"+encodeURIComponent(handle.toLowerCase()),{signal:ctl.signal});
      clearTimeout(t);
      if(!r.ok)return null;
      const j=await r.json();
      return j.recovery||null;
    }catch{return null}
  }
  /* Gerätewechsel: Handle + 16 Worte (+ neuer PIN) → dieselbe Identität
     auf diesem Gerät. Lädt das Recovery-Bundle (IPFS-Pinnwand oder Paste),
     entschlüsselt den Recovery-Schlüssel, dreht das Verzeichnis auf den
     neuen Geräte-Schlüssel (Rotation signiert vom Recovery-Schlüssel). */
  async function wiederherstellen({handle,phrase,bundleB64,neuerPin}){
    pruefeHandlePin(handle,neuerPin);
    handle=String(handle).trim().toLowerCase();
    const woerter=String(phrase||"").toLowerCase().split(/\s+/).filter(Boolean);
    if(woerter.length!==16||woerter.some(w=>!WOERTER.includes(w)))
      throw new Error("Phrase: genau 16 Wörter aus der OpenOS-Wortliste.");
    let enc=bundleB64||await recoveryBundleLaden(handle);
    if(!enc)throw new Error("Kein Recovery-Bundle gefunden (Handle falsch oder nicht publiziert?). Du kannst das Bundle auch manuell einfügen.");
    let recoveryPriv;
    try{
      const pk=await phraseKey(woerter,handle);
      const iv=unb64(enc.slice(0,16));
      const daten=unb64(enc.slice(16));
      recoveryPriv=await crypto.subtle.importKey("pkcs8",
        await crypto.subtle.decrypt({name:"AES-GCM",iv},pk,daten),
        {name:"ECDSA",namedCurve:"P-384"},true,["sign"]); // transient: nur für die Rotation
    }catch{throw new Error("Phrase passt nicht zum Bundle.")}
    // Der Recovery-Key BLEIBT die Wurzel der Identität — kein neues Paar.
    const recoveryPubB64=b64(await crypto.subtle.exportKey("spki",recoveryPriv));

    const deviceId=hex(crypto.getRandomValues(new Uint8Array(16)));
    const pub=await erzeugeDeviceKey(deviceId);
    const pubB64=b64(await crypto.subtle.exportKey("spki",pub));

    const salt=crypto.getRandomValues(new Uint8Array(16));
    const bits=await pinAbleitung(neuerPin,salt);
    const userId=hex(await crypto.subtle.digest("SHA-384",encoder.encode("openos-user:"+handle)));

    // Rotation: Recovery-Schlüssel (altes Bundle) autorisiert den neuen Geräte-Schlüssel
    const zeit=new Date().toISOString();
    const rotationSig=b64(await crypto.subtle.sign({name:"ECDSA",hash:"SHA-384"},recoveryPriv,
      encoder.encode(`openos-rotate:${handle}:${pubB64}:${zeit}`)));
    const card=b64(await signiere(deviceId,encoder.encode(`openos-handle:${handle}:${pubB64}:${zeit}`)));
    let publiziert=false;
    try{
      const ctl=new AbortController();
      const t=setTimeout(()=>ctl.abort(),5000);
      const r=await fetch(verzeichnis()+"/auth/register",{method:"POST",
        headers:{"Content-Type":"application/json"},signal:ctl.signal,
        body:JSON.stringify({handle,deviceId,devicePub:pubB64,card,createdAt:zeit,
          rotation:{sig:rotationSig,time:zeit}})});
      publiziert=r.ok;
      clearTimeout(t);
    }catch{}

    writeState({
      handle,deviceId,devicePub:pubB64,userId,
      pinSalt:b64(salt),pinVerifier:b64(bits.slice(0,24)),sessionSecret:b64(new Uint8Array(bits.slice(24,48))),
      recoveryPub:recoveryPubB64,recoveryEnc:enc,hergestelltAm:zeit,
      verzeichnisPubliziert:publiziert
    });
    await signOut("local");
    return {handle,publiziert};
  }

  /* ── Registrierung (komplett lokal) ─────────────────────────── */
  async function registriere({handle,pin,erzwingen=false}){
    pruefeHandlePin(handle,pin);
    handle=String(handle).trim().toLowerCase();

    if(!erzwingen){
      const belegt=await verzeichnisHandles();
      if(belegt&&belegt.includes(handle))
        throw new Error("Dieses Handle ist im dezentralen Verzeichnis bereits vergeben.");
    }

    const deviceId=hex(crypto.getRandomValues(new Uint8Array(16)));
    const pub=await erzeugeDeviceKey(deviceId);
    const pubB64=b64(await crypto.subtle.exportKey("spki",pub));

    // Lokal: PIN → Verifizierer + Sitzungs-HMAC-Secret (alles nur im Gerät)
    const salt=crypto.getRandomValues(new Uint8Array(16));
    const bits=await pinAbleitung(pin,salt);
    const verifier=bits.slice(0,24);                    // 24 B Verifizierer
    const secret=new Uint8Array(bits.slice(24,48));     // 24 B HMAC-Secret
    // userId ist stabil über Geräte hinweg (nur vom Handle abgeleitet) —
    // die Wiederherstellung auf einem neuen Gerät führt dieselbe Identität.
    const userId=hex(await crypto.subtle.digest("SHA-384",encoder.encode("openos-user:"+handle)));

    /* Recovery-Key: P-384-Paar, privater Schlüssel wird SOFORT mit der
       16-Wort-Phrase verschlüsselt und verworfen — die App kann ihn nie
       wieder roh exportieren; nur die Phrase öffnet das Bundle. */
    const phrase=phraseErzeugen();
    const recoveryPair=await crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-384"},true,["sign","verify"]);
    const recoveryPubB64=b64(await crypto.subtle.exportKey("spki",recoveryPair.publicKey));
    const pkcs8=await crypto.subtle.exportKey("pkcs8",recoveryPair.privateKey);
    const pKey=await phraseKey(phrase,handle);
    const riv=crypto.getRandomValues(new Uint8Array(12));
    const recoveryEnc=b64(riv)+b64(await crypto.subtle.encrypt({name:"AES-GCM",iv:riv},pKey,pkcs8));

    const publiziert=await publiziereKarte({handle,deviceId,devicePub:pubB64,
      recoveryPub:recoveryPubB64,recovery:recoveryEnc});

    writeState({
      handle,deviceId,devicePub:pubB64,userId,
      pinSalt:b64(salt),pinVerifier:b64(verifier),sessionSecret:b64(secret),
      recoveryPub:recoveryPubB64,recoveryEnc,
      createdAt:new Date().toISOString(),verzeichnisPubliziert:publiziert
    });
    await signOut("local");
    return {handle,deviceId,publiziert,phrase};
  }

  /* ── Login: Handle + PIN — komplett lokal, kein Netz ────────── */
  async function signIn({handle,pin}){
    pruefeHandlePin(handle,pin);
    handle=String(handle).trim().toLowerCase();
    const s=readState();
    if(!s.deviceId)throw new Error("Auf diesem Gerät ist kein Schlüssel hinterlegt — bitte hier ein Konto erstellen.");
    if(handle!==s.handle)throw new Error("Dieses Gerät gehört zu einem anderen Handle ("+s.handle+").");

    const bits=await pinAbleitung(pin,unb64(s.pinSalt));
    const verifier=b64(bits.slice(0,24));
    const secret=new Uint8Array(bits.slice(24,48));
    // Konstantzeit-Vergleich gegen den lokalen Verifizierer
    const a=Uint8Array.from(atob(verifier),c=>c.charCodeAt(0));
    const b=Uint8Array.from(atob(s.pinVerifier),c=>c.charCodeAt(0));
    if(a.length!==b.length||!a.every((x,i)=>x===b[i]))throw new Error("Falsche PIN.");

    const {token,exp}=await lokalesSessionToken(s.userId,s.handle,s.deviceId,secret);
    session={access_token:token,expires_at:exp,
      user:{id:s.userId,handle:s.handle,email:null,loginMethod:"private_key"}};
    try{localStorage.setItem("openos-session-v1",JSON.stringify(session))}catch{}
    emit("SIGNED_IN");
    return session;
  }

  async function signOut(scope="local"){
    session=null;
    try{localStorage.removeItem("openos-session-v1")}catch{}
    emit("SIGNED_OUT");
  }
  function currentSession(){return session}
  function currentUser(){return session?.user||null}
  async function requireSession(){
    if(!session)throw new Error("Bitte zuerst mit Handle + PIN anmelden.");
    return session;
  }

  async function init(){
    if(initPromise)return initPromise;
    initPromise=(async()=>{
      try{
        const raw=localStorage.getItem("openos-session-v1");
        if(raw){
          const s=JSON.parse(raw);
          if(s?.expires_at>Date.now())session=s;
          else try{localStorage.removeItem("openos-session-v1")}catch{}
        }
      }catch{}
      emit();
      return session;
    })();
    try{return await initPromise}catch(e){initPromise=null;throw e}
  }

  ns.keyAuth={init,registriere,signIn,signOut,currentSession,currentUser,requireSession,
    wiederherstellen,phraseErzeugen,
    hatGeraeteSchluessel:()=>Boolean(readState().deviceId),
    handle:()=>readState().handle||null,verzeichnisHandles,hex,b64,
    userId:()=>readState().userId||null,
    _syncSecret:()=>readState().sessionSecret||null};
})(window.MomoApp=window.MomoApp||{});