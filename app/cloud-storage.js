"use strict";
/* OpenOS Dezentraler Cloud-Speicher — Bibliothekserweiterung.
 *
 * Der Nutzer lädt Originaldateien hoch: 1 Credit pro 1 GB Originalgrösse
 * pro Upload, Download ist gratis.  Ablauf vollständig clientseitig:
 *   1. Bitseed-Kompression (Engine auf dem Gerät, .hyb)
 *   2. AES-256-GCM-Verschlüsselung — Key per HKDF-SHA-384 aus dem
 *      P-384-gebundenen Session-Secret (CNSA-2.0-Kette); IV wird vorangestellt
 *   3. Upload des Ciphertext an /cloud/<userId>/<fileId> → IPFS-Pin
 * Der Server sieht nie Namen, nie Klartext, nie die Kompression im Original.
 * Metadaten (CID, Grössen) liegen nur im Gerät (openos-cloud-v1).
 *
 * Einschränkung (Etappe 1): Der Key hängt an der PIN-Session — nach
 * PIN-Wechsel/Wiederherstellung mit neuer PIN sind alte Cloud-Dateien
 * nicht mehr entschlüsselbar. */
(function(ns){
  const GB=1024*1024*1024;
  const STORE="openos-cloud-v1";
  const encoder=new TextEncoder();
  function esc(s){return String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;")}
  function b64(a){return btoa(String.fromCharCode(...new Uint8Array(a)))}
  function ab64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
  function fmt(b){const n=Number(b)||0;if(n>=GB)return(n/GB).toFixed(2)+" GB";if(n>=1048576)return(n/1048576).toFixed(1)+" MB";if(n>=1024)return Math.round(n/1024)+" KB";return n+" B"}
  function uid(p){return p+"-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8)}
  function userId(){const id=ns.keyAuth?.userId?.()||ns.auth?.currentUser?.()?.id;if(!id)throw new Error("Bitte zuerst anmelden.");return String(id).toLowerCase()}
  function eintraege(){
    try{const r=JSON.parse(localStorage.getItem(STORE)||"{}");return Array.isArray(r.files)?r.files:[]}
    catch{return[]}
  }
  function speichern(liste){
    try{localStorage.setItem(STORE,JSON.stringify({version:1,userId:userId(),files:liste}))}catch{}
  }
  /* Cloud-Key: HKDF aus Session-Secret (CNSA-2.0-Kette, AES-256-GCM). */
  async function cloudKey(){
    const secretB64=ns.keyAuth?._syncSecret?.();
    if(!secretB64)throw new Error("Keine lokale Sitzung — bitte anmelden.");
    const km=await crypto.subtle.importKey("raw",ab64(secretB64),"HKDF",false,["deriveKey"]);
    return crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-384",salt:encoder.encode("openos-cloud:"+userId()),info:encoder.encode("aes")},km,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  }
  async function sha256Hex(buffer){const h=await crypto.subtle.digest("SHA-256",buffer);return[...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,"0")).join("")}
  async function abbuchen(noetig){
    let rest=noetig;
    while(rest>0){const teil=Math.min(100,rest);await ns.momoCredits.verbrauchen(teil,"bitseed_cloud",uid("cl"));rest-=teil}
  }
  function status(an,text,frac){
    const host=document.getElementById("cloudStorageStatus");if(!host)return;
    host.style.display=an?"flex":"none";
    if(an)host.innerHTML=`<span>${esc(text)}</span><div class="momo-compression-bar"><i style="width:${Math.max(0,Math.min(100,Math.round((frac||0)*100)))}%"></i></div>`;
  }
  /* ── Upload: lesen → buchen → komprimieren → verschlüsseln → pinnen ── */
  async function hochladen(file){
    if(!ns.auth?.currentUser?.()){ns.ui?.toast?.("Bitte melde dich an, um Cloud-Speicher zu nutzen.");return}
    if(!ns.compression?.encode){ns.ui?.toast?.("Bitseed-Engine nicht verfügbar.");return}
    const original=await file.arrayBuffer();
    const noetig=Math.max(1,Math.ceil(original.byteLength/GB));
    let guthaben=0;
    try{await ns.momoCredits?.laden?.(true)}catch{}
    try{guthaben=ns.momoCredits?.guthaben?.()||0}catch{}
    if(guthaben<noetig){ns.ui?.toast?.("Nicht genügend Credits ("+noetig+" nötig, 1 Credit pro GB).");try{ns.app?.openView?.("pricing")}catch{};return}
    const id=uid("cloud");
    try{
      status(true,"Komprimiere „"+file.name+"“ …",0.05);
      await abbuchen(noetig);
      const hyb=await ns.compression.encode(original.slice(0),(f)=>status(true,"Komprimiere „"+file.name+"“ …",0.05+f*0.4));
      status(true,"Verschlüssle (AES-256-GCM, CNSA 2.0) …",0.5);
      const key=await cloudKey();
      const iv=crypto.getRandomValues(new Uint8Array(12));
      const ct=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,hyb);
      const blob=new Uint8Array(12+ct.byteLength);blob.set(iv,0);blob.set(new Uint8Array(ct),12);
      status(true,"Lade auf den dezentralen IPFS-Speicher hoch …",0.6);
      const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),10*60*1000);
      let j;
      try{
        const r=await fetch(location.origin+"/cloud/"+userId()+"/"+id,{method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:blob,signal:ctl.signal});
        j=await r.json().catch(()=>null);
        if(!r.ok||!j?.ok)throw new Error(j?.error||("Upload fehlgeschlagen ("+r.status+")."));
      }finally{clearTimeout(t)}
      status(true,"Eintrage in der Bibliothek …",0.95);
      const liste=eintraege();
      liste.push({id,name:file.name,size:original.byteLength,hybSize:blob.length,cid:j.cid,sha256:await sha256Hex(blob),uploadedAt:new Date().toISOString()});
      speichern(liste);
      status(false);
      const delta=original.byteLength?(100-blob.length/original.byteLength*100):0;
      ns.ui?.toast?.("„"+file.name+"“ in der dezentralen Cloud — "+fmt(original.byteLength)+" → "+fmt(blob.length)+" ("+delta.toFixed(1)+" % kleiner) · "+noetig+" Credits · CID "+j.cid.slice(0,12)+"…");
      einfuegen();
    }catch(err){
      status(false);
      ns.ui?.toast?.("Cloud-Upload fehlgeschlagen: "+((err&&err.message)||err));
    }
  }
  /* ── Download: gratis — Ciphertext holen → entschlüsseln → entpacken ── */
  async function herunterladen(entry){
    try{
      status(true,"Lade Ciphertext vom IPFS-Gateway …",0.1);
      const r=await fetch(location.origin+"/ipfs/"+entry.cid);
      if(!r.ok)throw new Error("Gateway liefert "+r.status+" — Datei evtl. noch im Netz auffindbar.");
      const buf=await r.arrayBuffer();
      if(await sha256Hex(buf)!==entry.sha256)throw new Error("Prüfsumme stimmt nicht — Daten beschädigt.");
      status(true,"Entschlüssele …",0.5);
      const key=await cloudKey();
      let hyb;
      try{hyb=await crypto.subtle.decrypt({name:"AES-GCM",iv:buf.slice(0,12)},key,buf.slice(12))}
      catch{throw new Error("Entschlüsselung fehlgeschlagen — PIN seit dem Upload geändert?")}
      status(true,"Entpacke (Bitseed, bit-exakt) …",0.6);
      const data=await ns.compression.decode(hyb.slice(0),(f)=>status(true,"Entpacke …",0.6+f*0.35));
      status(false);
      const url=URL.createObjectURL(new Blob([data],{type:"application/octet-stream"}));
      const a=document.createElement("a");a.href=url;a.download=entry.name;document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),4000);
      ns.ui?.toast?.("„"+entry.name+"“ wiederhergestellt — "+fmt(data.byteLength)+" · Download war gratis.");
    }catch(err){status(false);ns.ui?.toast?.("Cloud-Download fehlgeschlagen: "+((err&&err.message)||err))}
  }
  function loeschen(entry){
    const liste=eintraege().filter(e=>e.id!==entry.id);
    speichern(liste);
    ns.ui?.toast?.("Eintrag „"+entry.name+"“ entfernt. Der gepinnte Ciphertext verbleibt unlesbar im Netz (nur du hattest den Key) und läuft bei Nichtnutzung aus dem Pin.");
    einfuegen();
  }
  /* ── UI: Sektion in die Bibliothek einfügen (nach jedem render()). ── */
  function einfuegen(){
    const host=document.getElementById("libraryContent");if(!host)return;
    document.getElementById("cloudStorageSection")?.remove();
    const sec=document.createElement("section");
    sec.id="cloudStorageSection";
    sec.className="momo-library-info";
    const liste=eintraege();
    const angemeldet=Boolean(ns.auth?.currentUser?.());
    sec.innerHTML=`<strong>☁ Dezentraler Cloud-Speicher (IPFS)</strong>
      <p>Originaldaten auf unserem eigenen, dezentralen IPFS-Speicher ablegen — so viel du willst. Jeder Upload: automatisch Bitseed-komprimiert, AES-256-GCM-verschlüsselt (CNSA-2.0-Kette) und gepinnt. Abrechnung: <b>1 Credit pro 1 GB Originalgrösse pro Upload</b> — Download ist gratis. Der Server sieht nur Ciphertext; der Key existiert nur in deinem Gerät.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px">
        <label class="momo-library-add"><input id="cloudFileInput" type="file" multiple hidden ${angemeldet?"":"disabled"}><span>☁ In die dezentrale Cloud laden</span></label>
        <span class="momo-library-private">${angemeldet?"Ciphertext · IPFS · nur du kannst öffnen":"Anmeldung nötig"}</span>
      </div>
      <div id="cloudStorageStatus" class="momo-compression-status" style="display:none"></div>
      <div style="margin-top:10px;display:grid;gap:8px">${liste.length?liste.map(e=>`<div class="momo-library-item"><div><strong>${esc(e.name)}</strong><span>Original ${fmt(e.size)} · Cloud ${fmt(e.hybSize)} · CID ${esc(e.cid.slice(0,16))}…</span><small>Upload ${new Date(e.uploadedAt).toLocaleString()} · Download gratis</small></div><div style="display:flex;gap:8px"><button type="button" data-cloud-download="${esc(e.id)}">Herunterladen</button><button type="button" data-cloud-remove="${esc(e.id)}" aria-label="Eintrag entfernen">Entfernen</button></div></div>`).join(""):'<small style="opacity:.6">Noch keine Cloud-Dateien — der erste Upload erklärt sich von selbst.</small>'}</div>`;
    host.appendChild(sec);
    document.getElementById("cloudFileInput")?.addEventListener("change",ev=>{
      const files=[...ev.target.files];ev.target.value="";
      files.forEach(f=>hochladen(f));
    });
    sec.querySelectorAll("[data-cloud-download]").forEach(b=>b.addEventListener("click",()=>{
      const e=eintraege().find(x=>x.id===b.dataset.cloudDownload);if(e)herunterladen(e);
    }));
    sec.querySelectorAll("[data-cloud-remove]").forEach(b=>b.addEventListener("click",()=>{
      const e=eintraege().find(x=>x.id===b.dataset.cloudRemove);if(e)loeschen(e);
    }));
  }
  /* In die Bibliothek einhaken: render() wird nach jedem Zeichnen ergänzt. */
  function css(){
    if(document.getElementById("momoCloudStorageCss"))return;
    const st=document.createElement("style");st.id="momoCloudStorageCss";
    st.textContent=`#cloudStorageSection .momo-compression-status{display:flex;align-items:center;gap:12px;padding:10px 14px;margin:10px 0 0;border:1px solid var(--line,#2b2b2b);border-radius:14px;background:color-mix(in srgb,var(--text,#f4f4f4) 4%,transparent);font-size:13px}#cloudStorageSection .momo-compression-bar{flex:1;max-width:220px;height:6px;border-radius:999px;background:color-mix(in srgb,var(--text,#f4f4f4) 10%,transparent);overflow:hidden}#cloudStorageSection .momo-compression-bar i{display:block;height:100%;border-radius:999px;background:var(--accent,#6c8cff);transition:width .2s}#cloudStorageSection button{display:inline-flex;align-items:center;border:1px solid var(--line,#2b2b2b);border-radius:999px;padding:7px 11px;cursor:pointer;background:var(--surface-2,#171717);color:inherit;font-size:12.5px;white-space:nowrap}`;
    document.head.appendChild(st);
  }
  function init(){
    css();
    if(!ns.library||ns.library.__cloudHook)return;
    const orig=ns.library.render;
    ns.library.render=function(){orig.apply(this,arguments);try{einfuegen()}catch{}};
    ns.library.__cloudHook=true;
    if(document.getElementById("libraryContent"))einfuegen();
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
  ns.cloudStorage={hochladen,herunterladen,loeschen,einfuege:()=>einfuegen()};
})(window.MomoApp=window.MomoApp||{});
