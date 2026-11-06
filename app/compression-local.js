"use strict";
/*! Momo AI — lokale Kompression.
 *
 * Eine Datei, ein Engine-Worker, ein Credit-System. Die Bitseed-Engine
 * laeuft im Worker dieses Geraets — nicht auf einem Server, nicht in
 * einer Cloud. Kompression ist Intelligenz, privat ausgeuebt: Die Daten
 * lehren das Modell, das Modell zahlt in Bits zurueck, und kein Byte
 * verlaesst dafuer das Haus. */
(function (ns) {
  const VERSION = "1.0.0";
  const ENGINE_URL = "kompression/assets/bitseed-engine.js";
  const CREDITS_PRO_GB = 1;            // Preisliste: Kompression 1 Credit pro GB
  const GB = 1073741824;

  const esc = (v) => ns.security?.escapeHTML?.(String(v ?? "")) || String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtBytes = (n) => { n = Number(n) || 0; if (n < 1024) return `${n} B`; if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`; if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`; return `${(n / GB).toFixed(2)} GB`; };
  const uid = (p) => `${p || "cmp"}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  const istArchiv = (name) => /\.(hyb|seb)$/i.test(String(name || ""));

  /* ------------------------------------------------------------ Engine-Worker
   * Die Engine läuft als Worker auf diesem Gerät. Ein Job nach dem anderen —
   * die Bytes werden per Transfer in den Worker gegeben und kommen als
   * Ergebnis zurück, ohne dass eine Kopie den Prozess verlässt. */
  let worker = null, job = null, jobFortschritt = null;
  function engine() {
    if (!worker) {
      worker = new Worker(ENGINE_URL);
      worker.onmessage = (e) => { if (job) job(e.data || {}); };
      worker.onerror = (e) => { if (job) { const j = job; job = null; j({ type: "error", message: String(e?.message || "Engine-Fehler") }); } };
    }
    return worker;
  }
  function ausfuehren(cmd, transfer, onProgress) {
    return new Promise((res, rej) => {
      jobFortschritt = onProgress || null;
      job = (m) => {
        if (m.type === "progress") { try { jobFortschritt && jobFortschritt(Number(m.frac) || 0); } catch {} return; }
        job = null;
        if (m.type === "error") rej(new Error(m.message || "Engine-Fehler"));
        else res(m);
      };
      try { engine().postMessage(cmd, transfer || []); }
      catch (err) { job = null; rej(err); }
    });
  }
  const encode = (buffer, onProgress) => ausfuehren({ cmd: "encode", data: buffer }, [buffer], onProgress).then((m) => m.hyb);
  const decode = (buffer, onProgress) => ausfuehren({ cmd: "decode", hyb: buffer }, [buffer], onProgress).then((m) => m.data);

  /* ------------------------------------------------------------------ Status
   * Die Statuszeile gehört zur Ansicht, die gerade komprimiert — Bibliothek
   * oder Projekt.  Sie wird beim Start eingehängt und danach nur noch gefüllt. */
  function css() {
    if (document.getElementById("momoCompressionCss")) return;
    const st = document.createElement("style");
    st.id = "momoCompressionCss";
    st.textContent = `.momo-compression-status{display:flex;align-items:center;gap:12px;padding:10px 14px;margin-bottom:12px;border:1px solid var(--line,#2b2b2b);border-radius:14px;background:color-mix(in srgb,var(--text,#f4f4f4) 4%,transparent);font-size:13px}
.momo-compression-status .momo-compression-bar{flex:1;max-width:220px;height:6px;border-radius:999px;background:color-mix(in srgb,var(--text,#f4f4f4) 10%,transparent);overflow:hidden}
.momo-compression-status .momo-compression-bar i{display:block;height:100%;border-radius:999px;background:var(--accent,#6c8cff);transition:width .2s}
.momo-library-item [data-library-compress],.momo-library-item [data-library-decompress],.project-knowledge-card [data-project-compress],.project-knowledge-card [data-project-decompress]{white-space:nowrap;padding:7px 11px;border-radius:999px;font-size:12.5px}
.momo-compress-note{font-size:11px;opacity:.65}`;
    document.head.appendChild(st);
  }
  function status(an, text, frac) {
    css();
    let bar = document.getElementById("momoCompressionStatus");
    if (!an) { if (bar) bar.remove(); return; }
    if (!bar) {
      const host = document.getElementById("libraryContent") || document.querySelector(".project-workspace") || document.querySelector("main .content");
      if (!host) return;
      bar = document.createElement("div");
      bar.id = "momoCompressionStatus";
      bar.className = "momo-compression-status";
      host.prepend(bar);
    }
    bar.innerHTML = `<span>${esc(text)}</span><div class="momo-compression-bar"><i style="width:${Math.max(0, Math.min(100, Math.round((frac || 0) * 100)))}%"></i></div>`;
  }

  /* ------------------------------------------------------------------ Konto
   * Kompression ist bezahlte Arbeit — drei Tore, in dieser Reihenfolge:
   * Nicht angemeldet → Account-Seite.  Zu wenig Guthaben → Pricing-Seite.
   * Beim Buchen wird in Häppchen à 100 Credits abgebucht, damit ein Abbruch
   * nie den ganzen Betrag hängen lässt. */
  function kontoSicherstellen() {
    if (ns.auth?.currentUser?.()) return true;
    ns.ui?.toast?.("Bitte melde dich an, um die Kompression zu nutzen.");
    try { ns.app?.openView?.("account"); } catch {}
    return false;
  }
  async function creditsBenoetigt(bytes) { return Math.max(1, Math.ceil((Number(bytes) || 0) / GB * CREDITS_PRO_GB)); }
  async function guthabenPruefen(benoetigt) {
    let guthaben = 0;
    try { await ns.momoCredits?.laden?.(true); } catch {}
    try { guthaben = ns.momoCredits?.guthaben?.() || 0; } catch {}
    if (guthaben >= benoetigt) return true;
    ns.ui?.toast?.("Nicht genügend Credits für die Kompression.");
    try { ns.app?.openView?.("pricing"); } catch {}
    return false;
  }
  async function abbuchen(benoetigt) {
    let rest = benoetigt;
    while (rest > 0) {
      const teil = Math.min(100, rest);   // verbrauchen: max. 100 pro Buchung
      await ns.momoCredits.verbrauchen(teil, "bitseed_compression", uid("bs"));
      rest -= teil;
    }
  }

  /* ------------------------------------------------------------------ Bytes
   * Prüfsumme und Inhalt kommen aus IndexedDB auf diesem Gerät. WebCrypto
   * rechnet lokal; ein verschwundener Blob ist ein harter Fehler — besser
   * laut scheitern als still etwas anderes zu komprimieren. */
  async function sha256Hex(buffer) {
    try {
      const h = await crypto.subtle.digest("SHA-256", buffer);
      return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch { return ""; }
  }
  async function bytesLaden(descriptor) {
    const rec = await ns.persistence?.getFile?.(descriptor?.fileId);
    const blob = rec?.blob || (rec?.text != null ? new Blob([rec.text], { type: rec.type || "text/plain" }) : null);
    if (!blob) throw new Error("Datei-Inhalt liegt nicht mehr auf diesem Gerät.");
    return blob.arrayBuffer();
  }

  /* Herkunfts-Metadaten aus der Persistenz lesen — zweite Quelle neben dem
   * Deskriptor.  Wenn der Deskriptor seinen originalName schon verloren hat
   * (alte Speicherstände), steht er hier noch. Nichts davon geht je auf
   * einen Server; das ist der lokale Wiederherstellungsanker. */
  async function metaLesen(descriptor) {
    try {
      const rec = await ns.persistence?.getFile?.(descriptor?.fileId);
      return (rec && rec.metadata && typeof rec.metadata === "object") ? rec.metadata : null;
    } catch { return null; }
  }

  /* Endung sicherstellen, wenn der Originalname unbekannt ist: Ein ZIP ohne
   * Endung öffnet macOS nicht („Datei hat nicht das korrekte Format"). Der
   * Inhalt ist dann die Wahrheit — ein ZIP bleibt ein ZIP, auch wenn der
   * ursprüngliche Container anders hiess. */
  function nameSniffen(name, bytes) {
    const n = String(name || "").trim() || "daten";
    if (/\.[A-Za-z0-9]{1,12}$/.test(n)) return n;
    try {
      const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(0);
      if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7) && (b[3] === 4 || b[3] === 6 || b[3] === 8)) return n + ".zip";
      if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return n + ".pdf";
      if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return n + ".png";
    } catch {}
    return n;
  }

  /** Ergebnis-Deskriptor erzeugen + in Bibliothek registrieren.
   *  Das Ergebnis wird lokal persistiert (IndexedDB) und still in die
   *  Bibliothek eingetragen — Herkunft „bitseed".  Nichts davon geht
   *  auf einen Server; der Deskriptor trägt localOnly als Ehrensache. */
  async function ergebnisSpeichern({ name, bytes, meta }) {
    const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const checksum = await sha256Hex(buffer);
    const fileId = await ns.persistence?.putFile?.({
      name,
      type: "application/octet-stream",
      size: buffer.byteLength,
      text: "",
      blob: new Blob([buffer], { type: "application/octet-stream" }),
      metadata: { source: "bitseed-compression", localOnly: true, cloudEligible: false, ...meta },
    }) || "";
    const descriptor = {
      id: uid("knowledge"),
      fileId,
      name,
      type: "application/octet-stream",
      kind: meta?.kind || "archive",
      parser: "binary-local",
      status: "stored-local",
      localOnly: true,
      deviceStorage: "indexeddb",
      cloudEligible: false,
      size: buffer.byteLength,
      storedBytes: buffer.byteLength,
      pageCount: null,
      lineCount: null,
      wordCount: 0,
      checksum,
      indexedAt: new Date().toISOString(),
      text: "",
      chunks: [],
      ...meta,
    };
    ns.library?.register?.(descriptor, { origin: "bitseed", silent: true });
    return descriptor;
  }

  /* Original und Archiv in den Momo-Systemordner legen (Original/ + Komprimiert/,
     bei Projektstart auch Projekte/<Name>/…). Schlägt still fehl, wenn kein
     Ordner eingerichtet ist — die Bibliothek bleibt in jedem Fall die Quelle. */
  async function aufDesktop(root0, relativPfad, name, buffer) {
    try {
      const root = root0 || (await ns.momoDevice?.systemOrdner?.({ fragen: false }));
      if (!root) return false;
      let dir = root;
      for (const teil of relativPfad) dir = await dir.getDirectoryHandle(teil, { create: true });
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob([buffer]));
      await w.close();
      return true;
    } catch { return false; }
  }

  /* Ersetzt eine Datei in der Bibliothek: Original raus, Ergebnis bleibt.
     Still — kein „Entfernt“-Toast, das Ergebnis-Toast kommt ohnehin. */
  function ausBibliothekEntfernen(item) {
    try {
      const liste = ns.store?.state?.libraryFiles || [];
      const idx = liste.findIndex((x) => String(x.id) === String(item.id) || (item.fileId && String(x.fileId) === String(item.fileId)));
      if (idx >= 0) liste.splice(idx, 1);
      ns.store.save({ reason: "compression-replace" });
      ns.store?.garbageCollectFiles?.();
    } catch {}
    try {
      for (const p of ns.store?.state?.projects || []) {
        const ki = (p.knowledgeFiles || []).findIndex((f) => String(f.id) === String(item.id) || (item.fileId && String(f.fileId) === String(item.fileId)));
        if (ki >= 0) { p.knowledgeFiles.splice(ki, 1); ns.store.save({ reason: "compression-replace-project" }); }
      }
    } catch {}
  }

  /* -------------------------------------------------------------- Komprimieren
   * Ablauf: lesen → Preis prüfen → buchen → kodieren → Ergebnis speichern.
   * Die Ersetzen-Regel gilt immer: Das Original verschwindet, sichtbar bleibt
   * nur das Archiv.  Nie beides — Speicherplatz ist der Sinn der Sache. */
  async function komprimiere({ descriptor, projektId = null, statusHost = "library" }) {
    css();
    const item = descriptor;
    if (!item) return false;
    if (istArchiv(item.name)) { ns.ui?.toast?.("Das ist bereits ein Bitseed-Archiv."); return false; }
    if (!kontoSicherstellen()) return false;
    try {
      const original = await bytesLaden(item);
      const noetig = await creditsBenoetigt(original.byteLength);
      if (!(await guthabenPruefen(noetig))) return false;

      status(true, `Komprimiere „${item.name}“ …`, 0.02);
      await abbuchen(noetig);
      const hyb = await encode(original.slice(0), (f) => status(true, `Komprimiere „${item.name}“ …`, 0.05 + f * 0.85));
      const basis = String(item.name || "daten").replace(/\.[^.]+$/, "") || "daten";
      const archiv = await ergebnisSpeichern({
        name: `${basis}.hyb`,
        bytes: hyb,
        meta: {
          kind: "archive",
          compressedFrom: item.id || null,
          originalName: item.name || "Datei",
          originalSize: original.byteLength,
          originalChecksum: item.checksum || "",
          compression: "bitseed-bts1",
        },
      });
      // Momo-Systemordner: Original + Archiv ablegen (auch im Projektordner)
      const projekt = projektId ? ns.store?.project?.(projektId) : null;
      const projName = String(projekt?.name || "").replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 60);
      const desktopOriginal = await aufDesktop(null, ["Original"], String(item.name || "daten"), original);
      const desktopArchiv = await aufDesktop(null, ["Komprimiert"], `${basis}.hyb`, hyb);
      if (projektId && projName) {
        await aufDesktop(null, ["Projekte", projName, "Original"], String(item.name || "daten"), original);
        await aufDesktop(null, ["Projekte", projName, "Komprimiert"], `${basis}.hyb`, hyb);
      }
      // Ersetzen: das Original verschwindet aus der Bibliothek/Projekten,
      // sichtbar bleibt nur die komprimierte Datei.
      ausBibliothekEntfernen(item);
      if (projektId) inProjektEintragen(projektId, archiv);
      status(false);
      const delta = original.byteLength ? (100 - hyb.byteLength / original.byteLength * 100) : 0;
      ns.ui?.toast?.(`„${basis}.hyb“ fertig — ${fmtBytes(original.byteLength)} → ${fmtBytes(hyb.byteLength)} · ${delta.toFixed(1)} % kleiner${desktopArchiv ? ` · auch im Momo-Ordner (Original/ + Komprimiert/)` : ""}.`);
      ns.library?.render?.();
      return true;
    } catch (err) {
      status(false);
      ns.ui?.toast?.(`Kompression fehlgeschlagen: ${(err && err.message) || err}`);
      return false;
    }
  }

  /* ------------------------------------------------------------ Dekomprimieren
   * Der umgekehrte Weg, mit umgekehrter Ersetzen-Regel: Das Archiv
   * verschwindet, sichtbar bleibt nur das Original. Entpacken ist kostenlos —
   * Daten gehören ihrem Besitzer, und der darf sie jederzeit zurückholen. */
  async function dekomprimiere({ descriptor, projektId = null }) {
    css();
    const item = descriptor;
    if (!item) return false;
    if (!istArchiv(item.name)) { ns.ui?.toast?.("Nur Bitseed-Archive (.hyb) können entpackt werden."); return false; }
    if (!kontoSicherstellen()) return false;
    try {
      const hyb = await bytesLaden(item);
      status(true, `Entpacke „${item.name}“ …`, 0.05);
      const data = await decode(hyb.slice(0), (f) => status(true, `Entpacke „${item.name}“ …`, 0.05 + f * 0.9));
      // Drei Quellen, eine Wahrheit: Deskriptor → Persistenz-Metadaten →
      // Inhalt selbst.  So überlebt der Originalname auch einen früheren
      // Verlust im Deskriptor — die Endung kommt immer mit zurück.
      const herkunft = await metaLesen(item);
      const name = nameSniffen(
        String(item.originalName || herkunft?.originalName || String(item.name || "archiv.hyb").replace(/\.(hyb|seb)$/i, "")) || "daten",
        data
      );
      const wiederhergestellt = await ergebnisSpeichern({
        name,
        bytes: data,
        meta: { kind: "binary", restoredFrom: item.id || null, compression: "bitseed-bts1", restored: true },
      });
      if (projektId) inProjektEintragen(projektId, wiederhergestellt);
      // Momo-Systemordner: wiederhergestelltes Original ablegen (auch im Projektordner)
      const projekt = projektId ? ns.store?.project?.(projektId) : null;
      const projName = String(projekt?.name || "").replace(/[\\/:*?"<>|]/g, " ").trim().slice(0, 60);
      const desktopOk = await aufDesktop(null, ["Original"], name, data);
      if (projektId && projName) await aufDesktop(null, ["Projekte", projName, "Original"], name, data);
      // Ersetzen: das Archiv verschwindet, sichtbar bleibt nur das Original.
      ausBibliothekEntfernen(item);
      status(false);
      ns.ui?.toast?.(`„${name}“ wiederhergestellt — ${fmtBytes(data.byteLength)} · Dekompression ist kostenlos${desktopOk ? " · auch im Momo-Ordner (Original/)" : ""}.`);
      ns.library?.render?.();
      return true;
    } catch (err) {
      status(false);
      ns.ui?.toast?.(`Dekompression fehlgeschlagen: ${(err && err.message) || err}`);
      return false;
    }
  }

  function inProjektEintragen(projektId, descriptor) {
    try {
      const p = ns.store?.project?.(projektId);
      if (!p) return;
      p.knowledgeFiles = Array.isArray(p.knowledgeFiles) ? p.knowledgeFiles : [];
      const vorhanden = p.knowledgeFiles.some((f) => f.name === descriptor.name && f.checksum === descriptor.checksum);
      if (!vorhanden) p.knowledgeFiles.push(descriptor);
      ns.store.save?.({ reason: "compression-project" });
    } catch {}
  }

  ns.compression = {
    VERSION, CREDITS_PRO_GB,
    encode, decode,
    komprimiere, dekomprimiere,
    istArchiv, fmtBytes,
  };

  /* Eingebettete Kompressions-STARTSEITE (/kompression/ im iframe): Es wird
   * absichtlich NUR die Startseite gezeigt — nicht die App.  AI-Chat,
   * Credits-Kauf, API-Key und Sprachwahl werden ausgeblendet, alle Links in
   * den Arbeitsbereich (#/app) entfernt und Hash-Wechsel dorthin zurückgesetzt.
   * Die Seite folgt der Gerätesprache. Gleiche Origin, darf direkt in das
   * iframe-DOM greifen. */
  function frameFreistellen() {
    const f = document.querySelector("#view-compression iframe");
    if (!f) return;
    const rein = () => {
      try {
        const d = f.contentDocument;
        if (!d) return;
        if (!d.getElementById("momoOpenOSHide")) {
          const st = d.createElement("style");
          st.id = "momoOpenOSHide";
          st.textContent = [
            ".ws-chat", ".ws-kaufen", ".ws-kaufen-pakete", ".ws-paket",
            ".ws-key", ".ws-langsel", ".ws-lang",
          ].map((s) => s + "{display:none!important}").join("") +
          'a[href="#/app"]{display:none!important}';
          d.head.appendChild(st);
        }
        // Links in den Arbeitsbereich entfernen (Nav + Footer + Hero-CTA)
        d.querySelectorAll('a[href="#/app"]').forEach((a) => a.remove());
        // Hash-Wächter: nur die Startseite, nie die App
        if (!f.dataset.hashWache) {
          f.dataset.hashWache = "1";
          setInterval(() => {
            try {
              const w = f.contentWindow;
              if (w && String(w.location.hash || "").startsWith("#/app")) w.location.hash = "";
            } catch {}
          }, 600);
        }
      } catch {}
    };
    f.addEventListener("load", rein);
    rein();
    setTimeout(rein, 1200);
    setTimeout(rein, 3000);
  }
  /* Ein Klick auf „Los geht's" der Startseite führt in die App; mehr tut
     init nicht — die eigentliche Arbeit passiert oben, beim Komprimieren. */
  function init() {
    document.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("#view-compression [data-goto-view]");
      if (!btn) return;
      try { ns.app?.openView?.(btn.dataset.gotoView); } catch {}
    });
    frameFreistellen();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})(window.MomoApp = window.MomoApp || {});
