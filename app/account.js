"use strict";
/* OpenOS Account — OPTIONAL, NUR FÜR SICHERUNG & SYNC.
 *
 * Die App braucht keinen Account und kein Login: alles läuft lokal und
 * anonym auf dem Gerät. Diese Seite ist ausschließlich die freiwillige
 * Sicherungs-Schicht: Wer ein Handle + PIN erstellt, kann seinen Stand
 * jederzeit verschlüsselt (AES-256-GCM, Schlüssel abgeleitet aus dem
 * PIN-gebundenen Session-Secret — CNSA-2.0-Kette) auf dem dezentralen
 * IPFS-Sync speichern und auf einem neuen Gerät mit Handle + PIN (bzw.
 * Handle + 16-Wort-Phrase) wiederherstellen. Der Server sieht nur
 * Ciphertext. Es gibt keine Abrechnung, keine Credits, kein Guthaben.
 */
(function (ns) {
  const DEVICE_KEY_STORAGE = "momo-device-key-v1";

  const esc = (v) => String(v ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  function deviceKey() {
    let key = "";
    try { key = localStorage.getItem(DEVICE_KEY_STORAGE) || ""; } catch {}
    if (key.length >= 16) return key;
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    key = "momo_" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem(DEVICE_KEY_STORAGE, key); } catch {}
    return key;
  }

  function detectedLocale() {
    const candidates = [...(navigator.languages || []), navigator.language].filter(Boolean);
    for (const value of candidates) {
      try {
        const canonical = Intl.getCanonicalLocales(String(value))[0];
        if (canonical) return canonical.slice(0, 24);
      } catch {}
    }
    return "en";
  }

  function hasLocalData() {
    return Boolean(
      ns.store?.state?.sessions?.length ||
      ns.store?.state?.projects?.length ||
      ns.store?.state?.learnedMemory?.facts?.length
    );
  }

  /* ── Sicherungs-Logik ─────────────────────────────────────────── */
  let busy = false;
  let phraseKarte = null; // frisch erzeugte 16-Wort-Phrase nach Registrierung
  let meldung = "";

  const KA = () => ns.keyAuth;

  async function sichern() {
    if (!ns.sync?.push) { ns.ui?.toast?.("Sync-Schicht nicht verfügbar."); return; }
    busy = true; meldung = "Verschlüssle und lade hoch …"; render();
    try {
      const r = await ns.sync.push();
      meldung = `Gesichert: ${(r.groesse / 1024).toFixed(1)} KB Ciphertext auf dem dezentralen IPFS-Sync.`;
    } catch (e) {
      meldung = "Sicherung fehlgeschlagen: " + (e?.message || e);
    }
    busy = false; render();
  }

  async function wiederherstellenVomSync() {
    if (!ns.sync?.pull) { ns.ui?.toast?.("Sync-Schicht nicht verfügbar."); return; }
    if (!confirm("Der Sicherungs-Stand vom IPFS-Sync ersetzt die lokalen Sync-Daten dieses Geräts. Fortfahren?")) return;
    busy = true; meldung = "Lade Sicherung und entschlüssle …"; render();
    try {
      const payload = await ns.sync.pull();
      if (!payload) { meldung = "Kein Sync-Stand gefunden."; }
      else {
        let n = 0;
        const data = payload.data || {};
        for (const k of (ns.sync.SYNC_KEYS || [])) {
          if (typeof data[k] === "string") { localStorage.setItem(k, data[k]); n++; }
        }
        meldung = `Sicherung übernommen (${n} Speicherbereiche). Bitte App neu laden, um alles zu aktivieren.`;
      }
    } catch (e) {
      meldung = "Wiederherstellung fehlgeschlagen: " + (e?.message || e);
    }
    busy = false; render();
  }

  async function registrieren(handle, pin) {
    busy = true; meldung = "Geräte-Schlüssel wird erzeugt …"; render();
    try {
      const r = await KA().registriere({ handle, pin });
      phraseKarte = r.phrase;
      meldung = r.publiziert
        ? "Handle im dezentralen Verzeichnis publiziert."
        : "Handle lokal erstellt (Verzeichnis aktuell nicht erreichbar — Karte wird nachgereicht).";
      await KA().signIn({ handle: r.handle, pin });
    } catch (e) {
      meldung = e?.message || String(e);
    }
    busy = false; render();
  }

  async function anmelden(handle, pin) {
    busy = true; meldung = "Entsperre …"; render();
    try {
      await KA().signIn({ handle, pin });
      meldung = "Entsperrt. Du kannst jetzt sichern und wiederherstellen.";
    } catch (e) {
      meldung = e?.message || String(e);
    }
    busy = false; render();
  }

  async function geraeteWechsel(handle, phrase, neuerPin) {
    busy = true; meldung = "Stelle Identität aus der Phrase wieder her …"; render();
    try {
      const r = await KA().wiederherstellen({ handle, phrase, neuerPin });
      phraseKarte = null;
      meldung = "Identität wiederhergestellt" + (r.publiziert ? " und Rotation publiziert." : ".");
      await KA().signIn({ handle: r.handle, pin: neuerPin });
    } catch (e) {
      meldung = e?.message || String(e);
    }
    busy = false; render();
  }

  /* ── Darstellung ──────────────────────────────────────────────── */
  function phraseKarteHTML() {
    if (!phraseKarte) return "";
    return `
      <section class="account-card account-warning">
        <div class="eyebrow">16-WORT-PHRASE — EINMALIG, JETZT NOTIEREN</div>
        <h3>Diese Wörter sind dein einziger Wiederherstellungs-Schlüssel.</h3>
        <p>Mit Handle + dieser Phrase holst du deine Daten auf jedem neuen Gerät zurück. OpenOS speichert sie nirgends im Klartext — wer sie verliert, verliert den Gerätewechsel.</p>
        <div class="api-key-value-row">
          <input id="phraseAnzeige" readonly value="${esc(phraseKarte.join(" "))}">
          <button class="action-btn white" id="copyPhraseBtn">Kopieren</button>
        </div>
        <div class="account-actions">
          <button class="action-btn white" id="phraseGespeichertBtn">Ich habe sie notiert</button>
        </div>
      </section>`;
  }

  function anonymHTML() {
    const mitSchluessel = KA()?.hatGeraeteSchluessel?.();
    return `
      <section class="account-card">
        <div class="eyebrow">LOKAL & ANONYM</div>
        <h3>Kein Account nötig — alles läuft auf diesem Gerät.</h3>
        <p>Momo Chat, Kompression, Projekte, Bibliothek, Presence, Social, Cinema: alles ohne Anmeldung, alles ohne Abrechnung. Ein Handle + PIN ist <strong>optional</strong> und dient nur einer einzigen Sache: deinen Stand verschlüsselt auf dem dezentralen IPFS-Sync zu sichern und auf einem neuen Gerät wiederherzustellen, falls dieses Gerät mal verloren geht.</p>
      </section>

      ${phraseKarteHTML()}

      <div class="account-columns">
        <section class="account-card">
          <div class="eyebrow">SICHERUNG NEU ERSTELLEN</div>
          <div class="profile-form">
            <label>Handle (wird weltweit deins)
              <input id="kaHandleNeu" maxlength="30" placeholder="z. B. satoshi" autocomplete="off">
            </label>
            <label>PIN (6 Ziffern)
              <input id="kaPinNeu" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off">
            </label>
          </div>
          <button class="action-btn white" id="kaRegistrierenBtn" ${busy ? "disabled" : ""}>Handle erstellen & entsperren</button>
          <p class="runtime-source-detail">Der Geräte-Schlüssel (P-384, CNSA 2.0) entsteht unlöschbar in diesem Gerät und kann nie exportiert werden. Die PIN verlässt dein Gerät nie.</p>
        </section>

        <section class="account-card">
          ${mitSchluessel ? `
          <div class="eyebrow">AUF DIESEM GERÄT ENTSPERREN</div>
          <div class="profile-form">
            <label>Handle
              <input id="kaHandleEin" maxlength="30" value="${esc(KA()?.handle?.() || "")}" autocomplete="off">
            </label>
            <label>PIN (6 Ziffern)
              <input id="kaPinEin" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off">
            </label>
          </div>
          <button class="action-btn white" id="kaAnmeldenBtn" ${busy ? "disabled" : ""}>Entsperren</button>
          ` : `
          <div class="eyebrow">GERÄTEWECHSEL</div>
          <p class="runtime-source-detail">Auf diesem Gerät ist noch kein Schlüssel hinterlegt. Neue Geräte holen die Identität mit Handle + 16-Wort-Phrase zurück:</p>
          `}
          <div class="profile-form" style="margin-top:14px">
            <label>Handle (Wiederherstellung)
              <input id="kaHandleRec" maxlength="30" placeholder="dein-handle" autocomplete="off">
            </label>
            <label>16-Wort-Phrase
              <input id="kaPhraseRec" placeholder="wort1 wort2 … wort16" autocomplete="off">
            </label>
            <label>Neue PIN (6 Ziffern)
              <input id="kaPinRec" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off">
            </label>
          </div>
          <button class="action-btn" id="kaRecoverBtn" ${busy ? "disabled" : ""}>Auf diesem Gerät wiederherstellen</button>
        </section>
      </div>`;
  }

  function sessionHTML(user) {
    return `
      ${phraseKarteHTML()}

      <div class="account-columns">
        <section class="account-card">
          <div class="eyebrow">SICHERUNGS-ACCOUNT</div>
          <h3>@${esc(user.handle)}</h3>
          <p class="runtime-source-detail">Identität lokal entsperrt. Sync-Schlüssel abgeleitet aus deinem PIN-gebundenen Sitzungs-Secret — der Server sieht nur Ciphertext.</p>
          <div class="account-actions">
            <button class="action-btn" id="kaAbmeldenBtn">Sitzung schließen</button>
          </div>
        </section>

        <section class="account-card">
          <div class="eyebrow">DEZENTRALER IPFS-SYNC</div>
          <h3>Dein verschlüsselter Stand</h3>
          <p>Ein Klick sichert deine Sync-Daten als AES-256-GCM-Ciphertext auf dem dezentralen IPFS. Auf einem neuen Gerät: Handle + PIN entsperren, „Sicherung laden" wählen — oder bei verlorenem Gerät Handle + 16-Wort-Phrase.</p>
          <div class="account-actions">
            <button class="action-btn white" id="syncPushBtn" ${busy ? "disabled" : ""}>Jetzt sichern</button>
            <button class="action-btn" id="syncPullBtn" ${busy ? "disabled" : ""}>Sicherung laden</button>
          </div>
          <p class="runtime-source-detail" id="syncStatus">Sync-Status wird geprüft …</p>
        </section>
      </div>

      <section class="account-card compact-account-card">
        <div>
          <div class="eyebrow">GERÄTEWECHSEL</div>
          <h3>Neues Gerät? Handle + 16-Wort-Phrase genügt.</h3>
          <p>Auf dem neuen Gerät unter „Account" die Wiederherstellung wählen — dieselbe Identität, derselbe Sync-Stand. Die Phrase findest du in deiner Notiz vom Erstellen des Handles.</p>
        </div>
      </section>`;
  }

  function bind() {
    const on = (id, fn) => document.getElementById(id)?.addEventListener("click", fn);
    on("kaRegistrierenBtn", () => registrieren(
      document.getElementById("kaHandleNeu")?.value,
      document.getElementById("kaPinNeu")?.value));
    on("kaAnmeldenBtn", () => anmelden(
      document.getElementById("kaHandleEin")?.value,
      document.getElementById("kaPinEin")?.value));
    on("kaRecoverBtn", () => geraeteWechsel(
      document.getElementById("kaHandleRec")?.value,
      document.getElementById("kaPhraseRec")?.value,
      document.getElementById("kaPinRec")?.value));
    on("copyPhraseBtn", async () => {
      try { await navigator.clipboard.writeText(phraseKarte.join(" ")); ns.ui?.toast?.("Phrase kopiert — bitte zusätzlich handschriftlich notieren."); } catch {}
    });
    on("phraseGespeichertBtn", () => { phraseKarte = null; render(); });
    on("kaAbmeldenBtn", async () => { await KA().signOut(); meldung = "Sitzung geschlossen — die App läuft anonym weiter."; render(); });
    on("syncPushBtn", sichern);
    on("syncPullBtn", wiederherstellenVomSync);
    document.getElementById("kaPinNeu")?.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("kaRegistrierenBtn")?.click(); });
    document.getElementById("kaPinEin")?.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("kaAnmeldenBtn")?.click(); });
  }

  async function paintSyncStatus() {
    const el = document.getElementById("syncStatus");
    if (!el || !ns.sync?.status) return;
    const s = await ns.sync.status().catch(() => null);
    el.textContent = s?.erreichbar
      ? "Sync erreichbar · Remote-Stand: " + (s.remoteGroesse ? (Number(s.remoteGroesse) / 1024).toFixed(1) + " KB Ciphertext" : "noch kein Stand")
      : "Sync aktuell nicht erreichbar — Sichern ist nur online möglich. Die App selbst läuft offline weiter.";
  }

  function render() {
    const host = document.getElementById("accountContent");
    if (!host) return;
    const user = ns.auth?.currentUser?.() || null;

    host.innerHTML = `
      <div class="account-shell">
        ${meldung ? `<section class="account-card compact-account-card"><div><p class="runtime-source-detail" style="margin:0">${esc(meldung)}</p></div></section>` : ""}
        ${user ? sessionHTML(user) : anonymHTML()}
        <section class="account-card compact-account-card">
          <div>
            <div class="eyebrow">PRIVATSPHÄRE</div>
            <p style="margin:0">Chats, Projekte, Bibliothek und Dateien bleiben auf diesem Gerät. Es gibt keine Abrechnung, kein Tracking, keinen zentralen Server. Die einzige bewusste Verbindung nach aussen ist deine eigene, verschlüsselte Sicherung.</p>
          </div>
        </section>
      </div>`;
    bind();
    paintSyncStatus();
  }

  async function load() { render(); }
  async function init() {
    document.addEventListener("momo:authchange", () => render());
    render();
  }

  ns.account = {
    init, load, render,
    profile: () => null,
    devices: () => [],
    deviceKey, hasLocalData, detectedLocale,
    refreshApiKeys: () => {},
  };
})(window.MomoApp = window.MomoApp || {});
