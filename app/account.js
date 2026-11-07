"use strict";
/* OpenOS Account — OPTIONAL, NUR FÜR SICHERUNG & SYNC.
 *
 * Die App braucht keinen Account und kein Login: alles läuft lokal und
 * anonym auf dem Gerät. Diese Seite ist ausschließlich die freiwillige
 * Sicherungs-Schicht: Wer sich per E-Mail-Magic-Link anmeldet, kann seinen
 * Stand jederzeit verschlüsselt (AES-256-GCM, lokaler Sync-Schlüssel —
 * CNSA-2.0-Kette) auf dem dezentralen IPFS-Sync speichern und auf einem
 * neuen Gerät über denselben Magic Link wiederherstellen. Der Server sieht
 * nur Ciphertext. Es gibt keine Abrechnung, keine Credits, kein Guthaben.
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
  let meldung = "";

  async function magicLinkSenden() {
    const email = (document.getElementById("mlKontoEmail")?.value || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      meldung = "Bitte eine gültige E-Mail-Adresse eingeben."; render(); return;
    }
    busy = true; meldung = "Magic Link wird gesendet …"; render();
    try {
      await ns.auth.signInEmail(email);
      meldung = "Link ist unterwegs an " + email + " — Postfach öffnen, Link anklicken, fertig. Diese Seite danach neu laden.";
    } catch (e) {
      meldung = "Senden fehlgeschlagen: " + (e?.message || e);
    }
    busy = false; render();
  }

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

  /* ── Darstellung ──────────────────────────────────────────────── */
  function anonymHTML() {
    return `
      <section class="account-card">
        <div class="eyebrow">LOKAL & ANONYM</div>
        <h3>Kein Account nötig — alles läuft auf diesem Gerät.</h3>
        <p>Momo Chat, Kompression, Projekte, Bibliothek, Presence, Social: alles ohne Anmeldung, alles ohne Abrechnung. Eine E-Mail-Adresse ist <strong>optional</strong> und dient nur einer einzigen Sache: deinen Stand verschlüsselt auf dem dezentralen IPFS-Sync zu sichern und auf einem neuen Gerät wiederherzustellen, falls dieses Gerät mal verloren geht.</p>
      </section>

      <div class="account-columns">
        <section class="account-card">
          <div class="eyebrow">SICHERUNG EINRICHTEN</div>
          <div class="profile-form">
            <label>E-Mail-Adresse
              <input id="mlKontoEmail" type="email" placeholder="deine@email.ch" autocomplete="email">
            </label>
          </div>
          <button class="action-btn white" id="mlKontoSend" ${busy ? "disabled" : ""}>Magic Link senden</button>
          <p class="runtime-source-detail">Kein Passwort: du erhältst eine E-Mail mit einem Anmelde-Link. Die Sitzung bleibt auf diesem Gerät erhalten; auf einem neuen Gerät einfach denselben Link-Flow mit derselben Adresse wiederholen.</p>
        </section>

        <section class="account-card">
          <div class="eyebrow">GERÄTEWECHSEL</div>
          <h3>Neues Gerät? E-Mail genügt.</h3>
          <p class="runtime-source-detail">Auf dem neuen Gerät unter „Account" dieselbe E-Mail-Adresse eintragen und den Magic Link anklicken — danach „Sicherung laden" wählen. Dasselbe Konto, derselbe Sync-Stand.</p>
        </section>
      </div>`;
  }

  function sessionHTML(user) {
    return `
      <div class="account-columns">
        <section class="account-card">
          <div class="eyebrow">SICHERUNGS-ACCOUNT</div>
          <h3>${esc(user.email || user.id)}</h3>
          <p class="runtime-source-detail">Angemeldet per Magic Link. Sync-Schlüssel lokal abgeleitet — der Server sieht nur Ciphertext.</p>
          <div class="account-actions">
            <button class="action-btn" id="kaAbmeldenBtn">Sitzung schließen</button>
          </div>
        </section>

        <section class="account-card">
          <div class="eyebrow">DEZENTRALER IPFS-SYNC</div>
          <h3>Dein verschlüsselter Stand</h3>
          <p>Ein Klick sichert deine Sync-Daten als AES-256-GCM-Ciphertext auf dem dezentralen IPFS. Auf einem neuen Gerät: mit derselben E-Mail anmelden, „Sicherung laden" wählen.</p>
          <div class="account-actions">
            <button class="action-btn white" id="syncPushBtn" ${busy ? "disabled" : ""}>Jetzt sichern</button>
            <button class="action-btn" id="syncPullBtn" ${busy ? "disabled" : ""}>Sicherung laden</button>
          </div>
          <p class="runtime-source-detail" id="syncStatus">Sync-Status wird geprüft …</p>
        </section>
      </div>`;
  }

  function bind() {
    const on = (id, fn) => document.getElementById(id)?.addEventListener("click", fn);
    on("mlKontoSend", magicLinkSenden);
    on("kaAbmeldenBtn", async () => { await ns.auth.signOut(); meldung = "Sitzung geschlossen — die App läuft anonym weiter."; render(); });
    on("syncPushBtn", sichern);
    on("syncPullBtn", wiederherstellenVomSync);
    document.getElementById("mlKontoEmail")?.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("mlKontoSend")?.click(); });
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
