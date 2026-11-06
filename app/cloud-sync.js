"use strict";
/* OpenOS Cloud-Sync — jetzt komplett dezentral über die IPFS-Sync-Schicht
 * (sync.js):  Der Workspace wird clientseitig mit AES-256-GCM verschlüsselt
 * und als Blob auf dem offenen IPFS-Sync-Raum abgelegt.  Kein Supabase,
 * kein Drittanbieter — wer den Blob hostet, sieht nur Ciphertext.
 *
 * API-Oberfläche bleibt wie bisher: upload/download/status/history.
 * Revision-Historie und Remote-Patches gibt es in Etappe 1 bewusst nicht —
 * der aktuelle Stand zählt. */
(function(ns){
  let lastSync=null;
  let busy=false;
  let knownRemoteRevision=0;

  function user(){
    const u=ns.auth?.currentUser?.();
    if(!u)throw new Error("Bitte zuerst anmelden.");
    return u;
  }
  function assertPaid(){
    if(ns.entitlements?.assert)return ns.entitlements.assert("cloud-sync");
    if(!ns.billing?.canUse?.("cloud-sync"))throw new Error("Cloud-Sync braucht einen angemeldeten Account.");
    return true;
  }
  function localChecksum(){return ns.persistence?._test?.checksum?.(ns.store.exportCloudObject?.()||ns.store.exportObject())||null;}

  async function remote(){
    user();assertPaid();
    const payload=await ns.sync.pull();
    const env=payload?.extra||null;
    if(env)knownRemoteRevision=Number(env.revision||0);
    return env;
  }

  async function upload({force=false}={}){
    if(busy)throw new Error("Cloud-Sync läuft bereits.");
    if(!ns.sync)throw new Error("Sync-Schicht nicht verfügbar.");
    // Harte Abrechnung: Cloud-Sync 1 Credit pro Vorgang — Login + Guthaben nötig.
    if(ns.guard&&!(await ns.guard.nutzung("sync",{bytes:0})))return;
    const u=user();assertPaid();busy=true;
    try{
      await ns.store.flush?.();
      const workspace=ns.store.exportCloudObject?.()||ns.store.exportObject();
      const checksum=localChecksum();
      let expected=knownRemoteRevision;
      if(!expected||force){try{const r=await remote();expected=Number(r?.revision||0)}catch{expected=0}}
      const revision=expected+1;
      const envelope={
        workspace,checksum,schema_version:ns.store.CURRENT_SCHEMA,
        device_key:ns.account?.deviceKey?.()||null,
        revision,updated_at:new Date().toISOString()
      };
      const j=await ns.sync.push({extra:envelope});
      knownRemoteRevision=revision;
      lastSync={direction:"upload",time:new Date().toISOString(),revision,checksum,changed:true,groesse:j?.groesse||null};
      ns.core?.setCapability?.("cloudOnline",true);ns.core?.emit?.("cloud-sync",lastSync);
      return lastSync;
    }finally{busy=false}
  }

  async function download(){
    if(busy)throw new Error("Cloud-Sync läuft bereits.");
    if(!ns.sync)throw new Error("Sync-Schicht nicht verfügbar.");
    const u=user();assertPaid();busy=true;
    try{
      const env=await remote();
      if(!env?.workspace)return false;
      if(env.checksum){
        const actual=ns.persistence?._test?.checksum?.(env.workspace);
        if(actual&&actual!==env.checksum)throw new Error("Sync-Workspace hat eine ungültige Prüfsumme.");
      }
      await ns.store.createSnapshot?.("Vor Sync-Download");
      const merged=ns.store.mergeCloudObjectWithLocalFiles?.(env.workspace)||env.workspace;
      ns.store.importWorkspace(merged);
      ns.store.bindAccount?.({userId:u.id,email:u.email||"",boundAt:new Date().toISOString()});
      await ns.store.flush?.();ns.chats?.renderAll?.();ns.projects?.render?.();
      knownRemoteRevision=Number(env.revision||1);
      lastSync={direction:"download",time:new Date().toISOString(),revision:knownRemoteRevision,checksum:env.checksum||null};
      ns.core?.setCapability?.("cloudOnline",true);ns.core?.emit?.("cloud-sync",lastSync);
      return lastSync;
    }finally{busy=false}
  }

  async function status(){
    if(!ns.auth?.currentUser?.()||!ns.billing?.canUse?.("cloud-sync"))return {available:false,lastSync};
    try{
      const env=await remote();
      const l=localChecksum();
      return {available:true,remoteExists:Boolean(env?.workspace),remoteRevision:Number(env?.revision||0),
        remoteUpdatedAt:env?.updated_at||null,remoteChecksum:env?.checksum||null,localChecksum:l,
        inSync:Boolean(env?.checksum&&env.checksum===l),dezentral:true,lastSync};
    }catch(error){return {available:false,error:error.message,dezentral:true,lastSync};}
  }

  async function history(){
    // Etappe 1: Der IPFS-Sync-Raum hält nur den aktuellen Stand.
    return [];
  }
  async function applyCodingPatch(){
    throw new Error("Remote-Patches gibt es im dezentralen Sync (Etappe 1) nicht — lokal generieren und pushen.");
  }
  ns.cloudSync={upload,download,status,history,applyCodingPatch,lastSync:()=>lastSync};
})(window.MomoApp=window.MomoApp||{});