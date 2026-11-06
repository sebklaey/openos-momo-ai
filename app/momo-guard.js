"use strict";
/* Guard — one login, one balance, enforced everywhere.
 *
 * Rules (02.11.):
 *  - Every feature needs an account.  If nobody is signed in and a feature is
 *    used, the app goes to the account page (login).
 *  - Every feature needs credits. If the balance is too low, the app goes to
 *    the pricing page (purchase).
 *  - Accounting runs ONLY through the OpenOS credit ledger (momoCredits) —
 *    never through local balances the client could edit.  The server
 *    reconciles; trust is not required.
 *
 * Prices (1 credit = USD 0.009):
 *  chat         1 credit per answer
 *  kompression 1 credit per GB (minimum 1)
 *  projekte    1 credit per GB
 *  geplant      1 credit per entry
 *  dateien     1 credit per GB
 *  artifacts   1 credit per GB
 *  sync        1 credit per GB
 *  store        1 credit per entry
 */
(function (ns) {
  const PREISE = {
    chat:        { label: "Momo Chat",     credits: 1,  einheit: "Antwort" },
    kompression: { label: "Kompression",   credits: 1, einheit: "GB" },
    projekte:    { label: "Projekte",      credits: 1, einheit: "GB" },
    geplant:     { label: "Geplant",       credits: 1,  einheit: "Eintrag" },
    dateien:     { label: "Eigene Dateien",credits: 1, einheit: "GB" },
    artifacts:   { label: "Artifacts",     credits: 1, einheit: "GB" },
    sync:        { label: "Cloud-Sync",    credits: 1, einheit: "GB" },
    store:       { label: "App Store",     credits: 1,  einheit: "Eintrag" },
  };

  // Seiten, die Funktionen sind — ohne Login wird auf die Account-Seite gelenkt.
  // Die Kompressions-SEITE ist bewusst offen: ansehen darf jeder. Die Aktionen
  // darin (komprimieren etc.) bleiben über nutzung/buchen kredit- und login-gated.
  // Social ist ein geschlossener Raum: Start, Presence, Social, News, Rooms und
  // Suggests+ sehen nur angemeldete Menschen. (Kommentar in dm.js bucht serverseitig.)
  const GESCHUETZTE_VIEWS = new Set(["chat", "projects", "library", "planned", "store", "apps", "plugins",
    "network-start", "network-presence", "network-social", "network-news", "network-room", "network-suggests-plus"]);

  /* Der Login-Status steht erst, wenn auth.init fertig ist (netzabhängig).
     Solange würde currentUser() fälschlich null liefern und angemeldete
     Menschen auf den Login schicken — deshalb: bis dahin nicht abweisen,
     danach hart prüfen. */
  let authBereit = false;
  document.addEventListener("momo:authchange", () => { authBereit = true; }, { once: true });
  document.addEventListener("momo:module-ready", (e) => { if (e.detail?.name === "auth") authBereit = true; });
  setTimeout(() => { authBereit = true; }, 8000); // Notbremse: nie ewig offen
  function warteAuth(ms = 4000) {
    if (authBereit) return Promise.resolve();
    return new Promise((res) => {
      const t0 = Date.now();
      const pruefen = () => {
        if (authBereit || Date.now() - t0 >= ms) res();
        else setTimeout(pruefen, 120);
      };
      pruefen();
    });
  }

  async function guthaben() {
    try { await ns.momoCredits?.laden?.(true); return Math.max(0, Math.round(ns.momoCredits?.guthaben?.() || 0)); }
    catch { return 0; }
  }

  function zumLogin() {
    ns.ui?.toast?.("Bitte melde dich an, um diese Funktion zu nutzen.");
    try { ns.app?.openView?.("account"); } catch { /* ignore */ }
  }
  function zumPricing(grund) {
    ns.ui?.toast?.(grund || "Dafür brauchst du mehr Credits.");
    try { ns.app?.openView?.("pricing"); } catch { /* ignore */ }
  }

  function kosten(feature, bytes = 0) {
    const p = PREISE[feature];
    if (!p) return 0;
    if (p.einheit === "GB" && bytes > 0) return Math.max(1, Math.ceil((bytes / 1e9) * p.credits));
    return p.credits;
  }

  /* Prueft Login + Guthaben. Gibt true zurück, wenn die Funktion bedient werden darf. */
  async function nutzung(feature, { bytes = 0 } = {}) {
    const p = PREISE[feature];
    if (!p) return true;
    await warteAuth();          // Erstbesuch: Auth lädt noch — nicht fälschlich abweisen
    if (!ns.auth?.currentUser?.()) { zumLogin(); return false; }
    const preis = kosten(feature, bytes);
    let stand = await guthaben();
    let bekannt = Boolean(ns.momoCredits?.stand?.());
    if (!bekannt) {
      // Einmal mit frischer Session wiederholen — ein haengengebliebener
      // Abruf ist kein leeres Konto.
      try { await ns.auth?.requireSession?.({ minValiditySeconds: 60 }); } catch { /* egal */ }
      stand = await guthaben();
      bekannt = Boolean(ns.momoCredits?.stand?.());
    }
    /* Nur einen BEKANNTEN zu niedrigen Stand auf die Pricing-Seite schicken.
       Bei "unbekannt" weitergehen: das eigentliche Buchen prueft serverseitig
       erneut — das Ledger entscheidet, nicht der Cache. */
    if (bekannt && stand < preis) {
      zumPricing(`${p.label} kostet ${preis} Credit${preis === 1 ? "" : "s"} — dein Guthaben: ${stand}. Kauf Credits, um weiterzumachen.`);
      return false;
    }
    return true;
  }

  /* Bucht eine Nutzung ueber das OpenOS-Credit-System. */
  async function buchen(feature, { bytes = 0, reason = null } = {}) {
    const p = PREISE[feature];
    if (!p) return true;
    await warteAuth();
    if (!ns.auth?.currentUser?.()) { zumLogin(); return false; }
    const preis = kosten(feature, bytes);
    try {
      await ns.momoCredits?.verbrauchen?.(preis, reason || ("momo_" + feature), "g_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8));
      document.dispatchEvent(new CustomEvent("momo:guthabenstand", { detail: { grund: feature, credits: preis } }));
      return true;
    } catch (error) {
      ns.ui?.toast?.("Abrechnung fehlgeschlagen: " + (error?.message || error));
      return false;
    }
  }

  /* View-Schutz: Funktionsseiten nur mit Login (Account-Seite sonst).
     Solange der Auth-Status noch lädt, nicht abweisen — sonst landet ein
     angemeldeter Mensch auf dem Erstbesuch im Login, obwohl die Session
     eine Sekunde später steht. */
  function viewErlaubt(name) {
    const n = String(name || "");
    if (!GESCHUETZTE_VIEWS.has(n)) return true;
    if (!authBereit) return true;
    if (ns.auth?.currentUser?.()) return true;
    zumLogin();
    return false;
  }

  ns.guard = { PREISE, GESCHUETZTE_VIEWS, guthaben, kosten, nutzung, buchen, viewErlaubt };
})(window.MomoApp = window.MomoApp || {});