"use strict";
/* Momo AI — Bibliothek.
 *
 * Jede Datei des Nutzers bleibt auf seinem Geraet. Das ist keine
 * Richtlinie, sondern die Architektur: Inhalt lebt im IndexedDB des
 * Browsers, der Server sieht nie ein Byte. Cloud-Sync, Remote Work
 * und Analytics bekommen keinen Zugriff auf diese Liste — der
 * Verdrahtung nach, nicht der Versprechen nach.
 *
 * Dazu gehoert: Registrierung (mit Dedupe und Deckel 500), lokale
 * Aufnahme ueber file-knowledge, Suche fuer den Chat-Kontext,
 * Kompression und Entpacken ueber die Bitseed-Engine direkt hier,
 * sowie der Ordner-Bezug zum echten Dateisystem des Nutzers. */
(function(ns){
  const VERSION="1.0.0";
  let bound=false;
  const esc=v=>ns.security?.escapeHTML?.(String(v??""))||String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  const files=()=>Array.isArray(ns.store?.state?.libraryFiles)?ns.store.state.libraryFiles:[];
  const fmtBytes=n=>{n=Number(n)||0;if(n<1024)return `${n} B`;if(n<1024*1024)return `${(n/1024).toFixed(1)} KB`;return `${(n/1024/1024).toFixed(1)} MB`};
  /* Eine Datei in der Bibliothek eintragen. Dieselbe Datei kann aus Chat,
   * Projekt oder Upload kommen — fileId oder Pruefsumme entscheiden, ob sie
   * schon bekannt ist; bekannt heisst aktualisieren, nicht duplizieren.
   * Deckel 500: die Bibliothek ist ein Arbeitsregal, kein Archiv. */
  function register(descriptor,{origin="upload",silent=false}={}){
    if(!descriptor||!ns.store?.state)return null;
    const list=files();
    const fileId=String(descriptor.fileId||"");
    const checksum=String(descriptor.checksum||"");
    const existing=list.find(x=>(fileId&&String(x.fileId||"")===fileId)||(checksum&&String(x.checksum||"")===checksum&&String(x.name||"")===String(descriptor.name||"")));
    const item={...descriptor,localOnly:true,deviceStorage:"indexeddb",cloudEligible:false,libraryOrigin:String(origin||"upload"),libraryAddedAt:descriptor.libraryAddedAt||new Date().toISOString()};
    if(existing)Object.assign(existing,item,{id:existing.id||item.id}); else list.unshift(item);
    ns.store.state.libraryFiles=list.slice(0,500);
    ns.store.save({reason:"library-register"});
    try{ns.dataChain?.record?.(String(origin||"").startsWith("bitseed")?"compression.archive":"library.file",item.id||item.fileId,ns.dataChain.payloads.file(item),{name:item.name,size:item.size,origin});}catch{/* Kette ist optional — die Datei gilt auch ohne Eintrag. */}
    if(!silent)render();
    return existing||item;
  }
  /* Bestand aus aelteren Teilen der App uebernehmen: Dateien, die schon als
   * Chat-Anhang oder Projekt-Wissen existieren, gehoeren automatisch ins
   * Regal.  Nichts wird kopiert — es wird nur dieselbe lokale Datei unter
   * ihrem zweiten Gesichtspunkt registriert. */
  function migrateExisting(){
    let added=0;
    for(const s of ns.store?.state?.sessions||[])for(const m of s.messages||[])for(const f of m.attachments||[]){const before=files().length;register(f,{origin:"chat-attachment",silent:true});if(files().length>before)added++}
    for(const p of ns.store?.state?.projects||[])for(const f of p.knowledgeFiles||[]){const before=files().length;register(f,{origin:`project:${p.id}`,silent:true});if(files().length>before)added++}
    return added;
  }
  function search(query,{limit=6,fallback=1}={}){return ns.fileKnowledge?.searchFiles?.(files(),String(query||""),{limit,fallback})||[]}
  function context(query,{limit=6}={}){
    const hits=search(query,{limit,fallback:1});
    return {hits,text:hits.map((x,i)=>`[L${i+1} · Bibliothek · ${x.name}${x.locatorLabel?` · ${x.locatorLabel}`:""}]\n${x.text}`).join("\n\n")};
  }
  /* Upload: lesen, indexieren, eintragen — in dieser Reihenfolge, auf diesem
   * Geraet. Der Guard bucht die Credits vor dem Einlesen; ein Lesefehler
   * kostet nichts ausser einer ehrlichen Meldung. */
  async function addFiles(fileList){
    let count=0;
    for(const file of [...(fileList||[])]){
      try{
        if(ns.guard&&!(await ns.guard.nutzung("dateien",{bytes:file?.size||0})))continue;
        const d=await ns.fileKnowledge.ingest(file,{source:"library-upload"});
        if(ns.guard)await ns.guard.buchen("dateien",{bytes:file?.size||0,reason:"momo_files"});
        register(d,{origin:"library-upload",silent:true});count++}
      catch(error){ns.ui?.toast?.(error?.message||`${file.name} konnte nicht gelesen werden.`)}
    }
    await ns.store?.garbageCollectFiles?.();render();
    if(count)ns.ui?.toast?.(`${count} Datei${count===1?"":"en"} lokal zur Bibliothek hinzugefügt.`);
    return count;
  }
  async function remove(id){
    const idx=files().findIndex(x=>String(x.id)===String(id));if(idx<0)return false;
    const [item]=ns.store.state.libraryFiles.splice(idx,1);ns.store.save({reason:"library-remove"});
    await ns.store?.garbageCollectFiles?.();render();
    ns.ui?.toast?.(`${item?.name||"Datei"} aus der Bibliothek entfernt.`);return true;
  }
  /* Navigation und Ansicht traegt die Bibliothek selbst ein — Menue, Rail
   * und View kommen aus einem Modul, damit sie nie auseinanderlaufen. */
  function injectNavigation(){
    if(!document.querySelector('.sidebar-action[data-view="library"]')){
      const projects=document.querySelector('.sidebar-action[data-view="projects"]');
      if(projects){const btn=document.createElement("button");btn.className="sidebar-action";btn.dataset.view="library";btn.type="button";btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="4.2" height="14" rx="1.35"/><rect x="9.9" y="4.6" width="4.2" height="14.4" rx="1.35"/><g transform="rotate(-8 17.6 12)"><rect x="15.7" y="5" width="4.2" height="14" rx="1.35"/></g></svg><span>Bibliothek</span><span class="nav-count">LOCAL</span>';projects.after(btn)}
    }
    if(!document.querySelector('.rail-btn[data-view="library"]')){
      const railProject=document.querySelector('.rail-btn[data-view="projects"]');
      if(railProject){const r=document.createElement("button");r.className="rail-btn";r.dataset.view="library";r.type="button";r.setAttribute("aria-label","Bibliothek");r.title="Bibliothek";r.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="4.2" height="14" rx="1.35"/><rect x="9.9" y="4.6" width="4.2" height="14.4" rx="1.35"/><g transform="rotate(-8 17.6 12)"><rect x="15.7" y="5" width="4.2" height="14" rx="1.35"/></g></svg>';railProject.after(r)}
    }
  }
  function injectView(){
    if(document.getElementById("view-library"))return;
    const section=document.querySelector("main .content");if(!section)return;
    const view=document.createElement("div");view.className="view panel-view hidden";view.id="view-library";view.innerHTML='<div class="panel-wrap"><div class="panel-head"><div><h1>Bibliothek</h1><p>Du kannst beliebige Dateien hinzufügen. Sie bleiben ausschließlich auf diesem Gerät; Momo-Server erhalten weder Dateiinhalt noch Dateikopie.</p></div></div><div id="libraryContent"></div></div>';
    section.appendChild(view);
  }
  /* Rueckgabe an den Nutzer: der Inhalt kommt aus dem lokalen Speicher als
   * Blob, der Download-Link lebt vier Sekunden und stirbt. Kein Server,
   * keine Kopie unterwegs. */
  async function download(id){
    const item=files().find(x=>String(x.id)===String(id));if(!item)return;
    try{
      const rec=await ns.persistence?.getFile?.(item.fileId);
      const blob=rec?.blob||(rec?.text?new Blob([rec.text],{type:rec.type||"text/plain"}):null);
      if(!blob){ns.ui?.toast?.("Datei-Inhalt liegt nicht mehr auf diesem Gerät.");return}
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");a.href=url;a.download=item.name||rec?.name||"download";
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),4000);
    }catch(error){ns.ui?.toast?.("Download fehlgeschlagen.")}
  }
  /* „Momo-Ordner auf Desktop anzeigen" — Browser koennen keinen Datei-Manager
   * an einem Ordner-Handle oeffnen; ehrlich ist: Name + Ort zeigen,
   * synchronisieren, Ordner wechseln — oder beim ersten Mal direkt am
   * Desktop einrichten.  Mehr versprechen wuerde heissen, weniger zu
   * liefern. */
  async function ordnerAnzeigen(){
    const dev=ns.momoDevice;
    if(!dev?.systemOrdner){ns.ui?.toast?.("Geräte-Zugriff ist in diesem Browser nicht verfügbar.");return}
    let name=null;
    try{name=await dev.systemOrdnerName()}catch{}
    if(!name){
      // Noch nicht eingerichtet: Picker öffnet sich direkt am Desktop.
      const h=await dev.systemOrdner({fragen:true});
      if(h)render();
      return;
    }
    document.querySelector(".momo-library-ordner-modal")?.remove();
    const o=document.createElement("div");
    o.className="momo-device-modal momo-library-ordner-modal";
    o.innerHTML=`<div class="momo-device-modal-box" role="dialog" aria-modal="true" aria-label="Momo-Ordner">
      <strong>Momo-Ordner auf diesem Gerät</strong>
      <p class="muted">Dein Momo-Ordner heißt <b>„${esc(name)}“</b> und liegt genau dort, wo du ihn eingerichtet hast — z. B. auf dem Desktop. Öffne ihn dort direkt im Datei-Manager deines Betriebssystems. Dort liegen Originale, Komprimierte, Projekte und Chats.</p>
      <p class="muted momo-device-modal-hinweis">Alles bleibt auf diesem Gerät; es geht kein Byte an einen Server.</p>
      <div class="momo-device-modal-actions">
        <button type="button" data-lo="schliessen">Schließen</button>
        <button type="button" data-lo="wechseln">Anderen Ordner wählen</button>
        <button type="button" class="primary" data-lo="sync">Jetzt synchronisieren</button>
      </div>
    </div>`;
    document.body.appendChild(o);
    o.querySelector('[data-lo="schliessen"]').addEventListener("click",()=>o.remove());
    o.addEventListener("click",e=>{if(e.target===o)o.remove()});
    o.querySelector('[data-lo="sync"]').addEventListener("click",async()=>{o.remove();await ns.momoDesktop?.syncAlles?.()});
    o.querySelector('[data-lo="wechseln"]').addEventListener("click",async()=>{o.remove();try{await dev.systemOrdnerVergessen?.()}catch{};await dev.systemOrdner({fragen:true});render()});
  }
  /* Die Liste neu zeichnen.  Drei Regeln gelten dabei:
   * 1. Das Suchfeld verliert nie den Fokus — render() laeuft bei jedem
   *    Tastendruck, und ein Fokusverbot nach einem Zeichen waere ein Fehler.
   * 2. Komprimieren/Entpacken laeuft ueber die Bitseed-Engine auf diesem
   *    Geraet; das Archiv ersetzt das Original, nie beides.
   * 3.  Die Zuordnung zu Projekten ist eine Organisation im lokalen
   *    Momo-Ordner — kein Upload, keine Kopie irgendwohin. */
  function render(){
    const host=document.getElementById("libraryContent");if(!host)return;
    const list=files();const suchfeld=document.getElementById("librarySearch");const roh=String(suchfeld?.value||"");const imFokus=!!suchfeld&&document.activeElement===suchfeld;const marke=imFokus?suchfeld.selectionStart:null;const q=roh.trim().toLowerCase();
    const shown=q?list.filter(f=>[f.name,f.kind,f.libraryOrigin].some(v=>String(v||"").toLowerCase().includes(q))):list;
    const projekte=Array.isArray(ns.store?.state?.projects)?ns.store.state.projects:[];
    const zuordnenSelect=(f)=>projekte.length?`<select data-library-assign="${esc(f.id)}" aria-label="Zu Projekt zuordnen" style="max-width:150px;padding:7px 9px;border-radius:999px;font-size:12.5px;background:var(--surface-2,#171717);color:inherit;border:1px solid var(--line,#2b2b2b)"><option value="">Zu Projekt …</option>${projekte.map(p=>`<option value="${esc(p.id)}" ${(p.knowledgeFiles||[]).some(k=>String(k.id)===String(f.id)||(f.checksum&&k.checksum===f.checksum))?"selected":""}>${esc(p.name)}</option>`).join("")}</select>`:"";
    host.innerHTML=`<div class="momo-library-toolbar"><label class="momo-library-add"><input id="libraryFileInput" type="file" multiple hidden><span>＋ Daten hinzufügen</span></label><input id="librarySearch" type="search" value="${esc(roh)}" placeholder="Bibliothek durchsuchen …"><button type="button" id="libraryFolderShowBtn" title="Zu deinem Momo-Ordner auf dem Desktop geleitet werden — Originale, Komprimierte, Projekte und Chats">🗂 Momo-Ordner auf Desktop anzeigen</button><button type="button" id="libraryDesktopSyncBtn" title="Bibliothek, Projekte und Chats in den Momo-Ordner auf dem Desktop synchronisieren">⤓ Desktop-Ordner</button><span class="momo-library-private">Nur dieses Gerät</span></div>
      <section class="momo-library-info"><strong>Beliebige Dateitypen · nur lokal · mit Kompression</strong><p>PDF, Text, Code und andere lesbare Formate können lokal indexiert werden. Andere Formate werden trotzdem auf diesem Gerät gespeichert. Jede Datei kannst du hier direkt mit der Bitseed-Engine komprimieren und Archive wieder entpacken — verlustfrei, bit-exakt, komplett auf diesem Gerät (Kompression: 1 Credit pro GB, Entpacken kostenlos). Bibliotheksdateien werden niemals in Cloud-Sync, Remote Work, Analytics oder auf Momo-Server übertragen.</p></section>
      <div class="momo-library-list">${shown.length?shown.map(f=>{const archiv=ns.compression?.istArchiv?.(f.name);return `<article class="momo-library-item"><div><strong>${esc(f.name||"Datei")}</strong><span>${esc((f.kind||"Datei").toUpperCase())} · ${fmtBytes(f.size||f.storedBytes)} · ${esc(f.libraryOrigin||"upload")}</span><small>${f.pageCount?`${Number(f.pageCount)} Seiten · `:""}${Number(f.chunks?.length||0)} lokale Suchabschnitte · ${new Date(f.libraryAddedAt||f.addedAt||Date.now()).toLocaleDateString()}${f.compressedSize?` · komprimiert: ${fmtBytes(f.compressedSize)}`:""}</small></div><div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;align-items:center">${archiv?`<button type="button" data-library-decompress="${esc(f.id)}">Entpacken</button>`:`<button type="button" data-library-compress="${esc(f.id)}">Komprimieren</button>`}${zuordnenSelect(f)}<button type="button" data-library-download="${esc(f.id)}">Herunterladen</button><button type="button" data-library-remove="${esc(f.id)}" aria-label="Aus Bibliothek entfernen">Entfernen</button></div></article>`}).join(""):'<div class="momo-library-empty"><strong>Noch keine Daten in der Bibliothek</strong><p>Füge beliebige Dateien hinzu. Lesbare Formate werden lokal indexiert; andere bleiben als lokale Datei erhalten. Auch Dateien aus Chats und Projekten erscheinen automatisch hier. Dateien kannst du direkt hier komprimieren und entpacken — alles läuft auf diesem Gerät.</p></div>'}</div>`;
    document.getElementById("libraryFileInput")?.addEventListener("change",e=>addFiles(e.target.files));
    document.getElementById("libraryDesktopSyncBtn")?.addEventListener("click",()=>ns.momoDesktop?.syncAlles?.());
    document.getElementById("libraryFolderShowBtn")?.addEventListener("click",ordnerAnzeigen);
    host.querySelectorAll("[data-library-assign]").forEach(sel=>sel.addEventListener("change",()=>{
      if(!sel.value)return;
      const f=files().find(x=>String(x.id)===String(sel.dataset.libraryAssign));
      if(f)ns.momoDesktop?.zuordnen?.(f,sel.value).then(()=>render());
      sel.value="";
    }));
    document.getElementById("librarySearch")?.addEventListener("input",render);/* Beim Neuzeichnen blieb der Fokus weg: nur ein Zeichen pro Tippen war moeglich (23.09.). */if(imFokus){const s2=document.getElementById("librarySearch");s2?.focus();try{s2?.setSelectionRange(marke,marke)}catch{}}
    host.querySelectorAll("[data-library-remove]").forEach(b=>b.addEventListener("click",()=>remove(b.dataset.libraryRemove)));
    host.querySelectorAll("[data-library-download]").forEach(b=>b.addEventListener("click",()=>download(b.dataset.libraryDownload)));
    host.querySelectorAll("[data-library-compress]").forEach(b=>b.addEventListener("click",()=>{const f=files().find(x=>String(x.id)===String(b.dataset.libraryCompress));if(f)ns.compression?.komprimiere?.({descriptor:f});}));
    host.querySelectorAll("[data-library-decompress]").forEach(b=>b.addEventListener("click",()=>{const f=files().find(x=>String(x.id)===String(b.dataset.libraryDecompress));if(f)ns.compression?.dekomprimiere?.({descriptor:f});}));
    ns.locale?.translateRoot?.(host)?.catch?.(()=>{});
  }
  /* Das Regelwerk der Oberflaeche, als ein Style-Element.  Kein Build-Schritt,
   * kein externes Stylesheet — was die Bibliothek zeigt, definiert die
   * Bibliothek selbst. */
  function css(){if(document.getElementById("momoLibraryCss"))return;const st=document.createElement("style");st.id="momoLibraryCss";st.textContent=`.momo-library-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}.momo-library-toolbar input[type=search]{flex:1;min-width:220px}.momo-library-add span,.momo-library-item button{display:inline-flex;align-items:center;border:1px solid var(--line,#2b2b2b);border-radius:12px;padding:9px 12px;cursor:pointer;background:var(--surface-2,#171717);color:inherit}.momo-library-private{font-size:12px;opacity:.7}.momo-library-info{padding:16px;border:1px solid var(--line,#292929);border-radius:16px;margin-bottom:14px}.momo-library-info p{margin:6px 0 0;opacity:.72}.momo-library-list{display:grid;gap:10px}.momo-library-item{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:14px;border:1px solid var(--line,#292929);border-radius:15px}.momo-library-item div{display:grid;gap:3px}.momo-library-item span,.momo-library-item small{opacity:.68}.momo-library-empty{padding:28px;text-align:center;border:1px dashed var(--line,#333);border-radius:16px}.momo-library-empty p{opacity:.7}@media(max-width:720px){.momo-library-item{align-items:flex-start;flex-direction:column}.momo-library-item button{width:100%;justify-content:center}}/* Felder im Momo-Stil (23.09.) */:root:root .momo-library-toolbar{gap:12px}:root:root .momo-library-add span{height:44px;padding:0 18px;border-radius:999px;font-weight:500;gap:6px;border-color:color-mix(in srgb,var(--text,#f4f4f4) 11%,transparent);background:color-mix(in srgb,var(--text,#f4f4f4) 4%,transparent);transition:border-color .15s,background-color .15s}:root:root .momo-library-add span:hover{border-color:color-mix(in srgb,var(--text,#f4f4f4) 22%,transparent);background:color-mix(in srgb,var(--text,#f4f4f4) 7%,transparent)}:root:root .momo-library-add:focus-within span{box-shadow:0 0 0 4px color-mix(in srgb,var(--text,#f4f4f4) 7%,transparent)}:root:root #librarySearch{-webkit-appearance:none;appearance:none;height:44px;border-radius:999px;padding:0 18px 0 44px;background:color-mix(in srgb,var(--text,#f4f4f4) 4%,transparent);border:1px solid color-mix(in srgb,var(--text,#f4f4f4) 11%,transparent);color:var(--text,#f4f4f4);font:inherit;font-size:14px;outline:0;transition:border-color .15s ease,box-shadow .15s ease,background-color .15s ease;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23737373' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-3.5-3.5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:16px 50%;background-size:17px}:root:root #librarySearch:hover{border-color:color-mix(in srgb,var(--text,#f4f4f4) 20%,transparent);}:root:root #librarySearch:focus{border-color:color-mix(in srgb,var(--text,#f4f4f4) 34%,transparent);background-color:color-mix(in srgb,var(--text,#f4f4f4) 6%,transparent);box-shadow:0 0 0 4px color-mix(in srgb,var(--text,#f4f4f4) 7%,transparent);}:root:root #librarySearch::placeholder{color:var(--muted,#737373);opacity:1}:root:root #librarySearch::-webkit-search-cancel-button{-webkit-appearance:none;appearance:none}:root:root .momo-library-private{font-size:12px;color:var(--muted,#737373);opacity:1}:root:root #librarySearch:focus-visible{outline:0}:root:root #libraryFolderShowBtn,:root:root #libraryDesktopSyncBtn{display:inline-flex;align-items:center;gap:6px;height:44px;padding:0 18px;border-radius:999px;font-weight:500;font-size:13.5px;border:1px solid color-mix(in srgb,var(--text,#f4f4f4) 11%,transparent);background:color-mix(in srgb,var(--text,#f4f4f4) 4%,transparent);color:inherit;cursor:pointer;transition:border-color .15s,background-color .15s;font-family:inherit;white-space:nowrap}:root:root #libraryFolderShowBtn:hover,:root:root #libraryDesktopSyncBtn:hover{border-color:color-mix(in srgb,var(--text,#f4f4f4) 22%,transparent);background:color-mix(in srgb,var(--text,#f4f4f4) 7%,transparent)}`;document.head.appendChild(st)}
  function init(){css();injectNavigation();injectView();migrateExisting();render();if(!bound){bound=true;document.addEventListener("momo:viewchange",e=>{if(e.detail?.view==="library")render()});document.addEventListener("momo:storechange",()=>{if(ns.navigation?.activeView?.()==="library")render()})}return true}
  ns.library={VERSION,init,register,files,search,context,addFiles,remove,render,migrateExisting};
})(window.MomoApp=window.MomoApp||{});