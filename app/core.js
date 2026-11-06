"use strict";
(function(ns){
  const VERSION="23.1-product-core.23.5";
  const SCHEMA_VERSION=23;
  const listeners=new Map();
  const errors=[];
  const modules={};
  const capabilities={
    localChat:true,
    localProjects:true,
    localSearch:true,
    localArtifacts:true,
    chatFeedback:true,
    speechPlayback:true,
    keyboardShortcuts:true,
    localFiles:true,
    continualLearning:true,
    runtimePipeline:true,
    inferenceAbort:true,
    inferenceTimeout:true,
    responseConfidence:true,
    responseProvenance:true,
    indexedDBPersistence:true,
    recoverySnapshots:true,
    persistentStorageAPI:Boolean(navigator.storage?.persist),
    largeLocalFiles:true,
    accountBinding:true,
    deviceRegistry:true,
    magicLinkAuth:true,
    oauthPKCE:true,
    sessionManagement:true,
    stripeCheckout:true,
    stripePortal:true,
    stripeWebhook:true,
    serverEntitlements:true,
    centralEntitlements:true,
    failClosedPaidFeatures:true,
    securityHardening:true,
    reliabilityLayer:true,
    requestStateTracking:true,
    retryBackoff:true,
    crashRecovery:true,
    offlineRecovery:true,
    releaseQualityGate:true,
    releaseRegressionSuite:true,
    releaseBlockingChecks:true,
    pwaInstallable:true,
    serviceWorkerOfflineShell:true,
    pwaUpdateFlow:true,
    mobileSafeAreas:true,
    visualViewportKeyboard:true,
    pwaAppLifecycle:true,
    productionDeployment:true,
    productionHealthCheck:true,
    hardenedBillingOrigins:true,
    productionConfig:true,
    productPolish:true,
    nonBlockingOnboarding:true,
    accessibleLiveRegions:true,
    polishedEmptyStates:true,
    releaseCandidateE2E:true,
    goNoGoGate:true,
    manualE2ESignoff:true,
    liveBuildFingerprint:true,
    foundationBundleFingerprint:true,
    foundationBundleIntegrityCheck:true,
    dualRuntimeIdentity:true,
    resilientSettingsView:true,
    resilientAccountView:true,
    coherentAssetLoading:true,
    staleServiceWorkerMigration:true,
    brandedMagicLink:true,
    serverSideMagicLink:true,
    uploadedBrandLogo:true,
    strictCSP:true,
    xssSafeRenderer:true,
    safeExternalNavigation:true,
    toolArgumentValidation:true,
    previewMessageIsolation:true,
    planFeatureMatrix:true,
    agentPersistentQueue:true,
    agentApprovalGate:true,
    agentRemoteWorker:false,
    projectContextRetrieval:true,
    projectMemory:true,
    crossChatProjectContext:true,
    projectKnowledgeRetrieval:true,
    fileKnowledgeIndex:true,
    pdfKnowledge:true,
    sourceCitations:true,
    attachmentRetrieval:true,
    artifactWorkSurface:true,
    artifactVersioning:true,
    artifactCodeEditor:true,
    artifactSandboxPreview:true,
    toolRouter:true,
    toolPlanning:true,
    toolAuditTrail:true,
    toolPermissionGuard:true,
    localReadTools:true,
    webResearch:true,
    personalizationSettings:true,
    privacyControls:true,
    webModeControl:true,
    memoryControl:true,
    webFetch:true,
    webCitations:true,
    networkReadTools:true,
    conflictSafeCloudSync:true,
    staticBranding:true,
    // Auth ist serverlos (key-auth.js): der private Geräte-Schlüssel +
    // Handle + PIN laufen komplett lokal — verfügbar, sobald WebCrypto da ist.
    authConfigured:typeof crypto!=="undefined"&&Boolean(crypto.subtle),
    billingConfigured:Boolean(window.MOMO_CONFIG?.stripe?.plusPriceId&&window.MOMO_CONFIG?.stripe?.proPriceId),
    // Cloud-Sync über Supabase ist ersetzt: die Datenbank lebt lokal im Gerät
    // (openos-db-v1); dezentraler IPFS-Sync folgt als eigene Etappe.
    cloudSyncConfigured:false,
    billingBackendVerified:false,
    cloudOnline:false
  };

  function on(name,handler){
    if(!listeners.has(name))listeners.set(name,new Set());
    listeners.get(name).add(handler);
    return ()=>listeners.get(name)?.delete(handler);
  }
  function emit(name,detail={}){
    for(const fn of listeners.get(name)||[]){
      try{fn(detail)}catch(err){reportError(err,{scope:`event:${name}`,silent:true})}
    }
    document.dispatchEvent(new CustomEvent(`momo:${name}`,{detail}));
  }

  function serializeError(error){
    if(error instanceof Error){
      return {name:error.name,message:error.message,stack:error.stack||""};
    }
    return {name:"Error",message:String(error),stack:""};
  }

  function reportError(error,{scope="app",fatal=false,silent=false}={}){
    const record={...serializeError(error),scope,fatal:Boolean(fatal),time:new Date().toISOString()};
    errors.push(record);
    if(errors.length>50)errors.splice(0,errors.length-50);
    console.error(`[Momo:${scope}]`,error);
    emit("error",record);
    if(!silent&&modules.ui?.status==="ready"&&ns.ui?.toast){
      try{ns.ui.toast(fatal?"Momo konnte nicht vollständig starten.":`Fehler in ${scope}`)}catch{}
    }
    if(fatal)showFatal(record);
    return record;
  }

  function showFatal(record){
    let host=document.getElementById("momoFatalError");
    if(!host){
      host=document.createElement("div");
      host.id="momoFatalError";
      host.className="fatal-error";
      document.body.appendChild(host);
    }
    host.innerHTML=`<div class="fatal-card"><div class="fatal-kicker">MOMO PRODUCT CORE</div><h2>Die App konnte nicht vollständig starten.</h2><p>${escapeHTML(record.message)}</p><div class="fatal-actions"><button id="fatalReload">Neu laden</button><button id="fatalDismiss">Schließen</button></div></div>`;
    host.classList.add("show");
    document.getElementById("fatalReload")?.addEventListener("click",()=>location.reload());
    document.getElementById("fatalDismiss")?.addEventListener("click",()=>host.classList.remove("show"));
  }

  function escapeHTML(v){
    return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
  }

  async function initModule(name,initializer,{required=true}={}){
    const started=performance.now();
    try{
      if(typeof initializer!=="function")throw new Error(`Initializer for ${name} is missing`);
      await initializer();
      modules[name]={status:"ready",required,durationMs:Math.round((performance.now()-started)*10)/10};
      emit("module-ready",{name,...modules[name]});
      return true;
    }catch(error){
      modules[name]={status:"failed",required,durationMs:Math.round((performance.now()-started)*10)/10,error:serializeError(error)};
      reportError(error,{scope:`module:${name}`,fatal:required,silent:!required});
      emit("module-failed",{name,...modules[name]});
      if(required)throw error;
      return false;
    }
  }

  function requireDOM(ids){
    const missing=ids.filter(id=>!document.getElementById(id));
    if(missing.length)throw new Error(`Fehlende UI-Elemente: ${missing.join(", ")}`);
    return true;
  }

  function setCapability(name,value){
    capabilities[name]=value;
    emit("capability",{name,value});
  }

  function diagnostics(){
    return {
      coreVersion:VERSION,
      schemaVersion:SCHEMA_VERSION,
      momo:ns.momo?.status?.()||null,
      modules:JSON.parse(JSON.stringify(modules)),
      capabilities:{...capabilities},
      errors:[...errors],
      protocol:location.protocol,
      online:navigator.onLine,
      inference:ns.inference?.diagnostics?.()||null,
      store:ns.store?.diagnostics?.()||null,
      persistence:ns.persistence?.diagnostics?.()||null,
      entitlements:ns.entitlements?.diagnostics?.()||null,
      security:ns.security?.diagnostics?.()||null,
      reliability:ns.reliability?.diagnostics?.()||null,
      pwa:ns.pwa?.diagnostics?.()||null,
      production:ns.production?.diagnostics?.()||null,
      polish:ns.polish?.diagnostics?.()||null
    };
  }

  function markReady(){
    document.documentElement.dataset.momoReady="true";
    emit("ready",diagnostics());
  }

  window.addEventListener("error",event=>{
    reportError(event.error||event.message,{scope:"window",silent:true});
  });
  window.addEventListener("unhandledrejection",event=>{
    reportError(event.reason||"Unhandled promise rejection",{scope:"promise",silent:true});
  });
  window.addEventListener("online",()=>{setCapability("cloudOnline",true)});
  window.addEventListener("offline",()=>{setCapability("cloudOnline",false)});
  capabilities.cloudOnline=navigator.onLine;

  ns.core={VERSION,SCHEMA_VERSION,on,emit,reportError,initModule,requireDOM,setCapability,diagnostics,markReady,capabilities,modules,errors};
})(window.MomoApp=window.MomoApp||{});