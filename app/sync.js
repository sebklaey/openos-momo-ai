"use strict";
/* OpenOS Dezentraler Sync — IPFS-Ciphertext-Blobs.
 *
 * Der Sync-Key wird NUR im Gerät abgeleitet (aus dem PIN-gebundenen
 * Sitzungs-Secret, HKDF), der Server sieht nie einen Klartext und nie
 * den Key — nur einen SHA-256-Hash des Keys als Schreib-Schutz und den
 * AES-256-GCM-Ciphertext.  Lesen ist offen (Ciphertext), Schreiben nur
 * mit passendem Key-Hash.  Kein Supabase, kein Dritter.
 *
 * Hinweis (Etappe 1): Der Key hängt an der PIN-Session.  Nach einem
 * PIN-Wechsel bzw. einer Wiederherstellung mit NEUER PIN ist ein alter
 * Sync-Stand nicht entschlüsselbar — dann gilt der lokale Stand als
 * neuen Stand hochladen (Push). */
(function(ns){
  const encoder=new TextEncoder();
  const SYNC_KEYS=["openos-db-v1","openos-credits-v1"]; // klarsynchronisierte Speicher
  function b64(a){return btoa(String.fromCharCode(...new Uint8Array(a)))}
  function ab64(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
  async function hex(a){return[...new Uint8Array(a)].map(x=>x.toString(16).padStart(2,"0")).join("")}
  function basis(){return location.origin}
  function userId(){
    const id=ns.auth?.currentUser?.()?.id||ns.keyAuth?.userId?.();
    if(!id)throw new Error("Bitte zuerst anmelden.");
    return String(id).toLowerCase();
  }
  /* Sync-Key aus Sync-Secret (HKDF-SHA-384): keyAuth-Session (Legacy) oder
   * lokales Geräte-Geheimnis — funktioniert mit jeder Anmeldemethode. */
  function lokalesSyncSecret(){
    try{const v=localStorage.getItem("openos-sync-secret");if(v)return v}catch{}
    const s=b64(crypto.getRandomValues(new Uint8Array(48)));
    try{localStorage.setItem("openos-sync-secret",s)}catch{}
    return s;
  }
  async function syncMaterial(){
    const secretB64=ns.keyAuth?._syncSecret?.()||lokalesSyncSecret();
    if(!secretB64)throw new Error("Keine lokale Sitzung — bitte anmelden.");
    const secret=ab64(secretB64);
    const km=await crypto.subtle.importKey("raw",secret,"HKDF",false,["deriveBits","deriveKey"]);
    const key=await crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-384",salt:encoder.encode("openos-sync:"+userId()),info:encoder.encode("aes")},km,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
    const bits=await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-384",salt:encoder.encode("openos-sync:"+userId()),info:encoder.encode("hash")},km,256);
    return {key,keyHash:await hex(bits)};
  }
  /* Klar synchronisierte localStorage-Schlüssel einsammeln. */
  function sammeln(){
    const data={};
    for(const k of SYNC_KEYS){const v=localStorage.getItem(k);if(v)data[k]=v}
    return data;
  }
  function zurueckschreiben(data){
    if(!data||typeof data!=="object")return 0;
    let n=0;
    for(const k of SYNC_KEYS){if(typeof data[k]==="string"){localStorage.setItem(k,data[k]);n++}}
    return n;
  }
  async function push({extra}={}){
    const {key,keyHash}=await syncMaterial();
    const payload={version:1,userId:userId(),exportedAt:new Date().toISOString(),data:sammeln(),extra:extra||null};
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const ct=await crypto.subtle.encrypt({name:"AES-GCM",iv},key,encoder.encode(JSON.stringify(payload)));
    const blob=new Uint8Array(12+ct.byteLength);
    blob.set(iv,0);blob.set(new Uint8Array(ct),12);
    const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),25000);
    try{
      const r=await fetch(basis()+"/sync/"+userId(),{method:"PUT",headers:{"Content-Type":"application/octet-stream","x-openos-sync-hash":keyHash},body:blob,signal:ctl.signal});
      const j=await r.json().catch(()=>null);
      if(!r.ok||!j?.ok)throw new Error(j?.error||("Sync-Push fehlgeschlagen ("+r.status+")."));
      return j;
    }finally{clearTimeout(t)}
  }
  async function pull(){
    const {key}=await syncMaterial();
    const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),25000);
    try{
      const r=await fetch(basis()+"/sync/"+userId(),{signal:ctl.signal});
      if(r.status===404)return null;
      if(!r.ok)throw new Error("Sync-Abruf fehlgeschlagen ("+r.status+").");
      const ct=await r.arrayBuffer();
      let plain;
      try{plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:ct.slice(0,12)},key,ct.slice(12))}
      catch{throw new Error("Sync-Stand ist mit diesem Schlüssel nicht entschlüsselbar (PIN geändert?).")}
      return JSON.parse(new TextDecoder().decode(plain));
    }finally{clearTimeout(t)}
  }
  async function status(){
    try{
      const r=await fetch(basis()+"/sync/"+userId(),{method:"HEAD"}).catch(()=>null);
      return {erreichbar:Boolean(r?.ok),remoteGroesse:r?.headers?.get("content-length")||null};
    }catch{return{erreichbar:false}}
  }
  ns.sync={push,pull,status,SYNC_KEYS};
})(window.MomoApp=window.MomoApp||{});
