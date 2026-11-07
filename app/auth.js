"use strict";
/* OpenOS Auth — E-Mail-Magic-Link-Login (Supabase Auth).
 *
 * Der Account ist optional und dient nur der verschlüsselten Sicherung &
 * Synchronisation: E-Mail eingeben → Magic Link → Sitzung steht. Kein
 * Passwort, kein Handle, keine PIN. Supabase Auth verwaltet Sitzung und
 * Token-Erneuerung; der Client ist der offizielle supabase-js aus
 * /vendor/supabase.js (ES-Modul, dynamisch importiert).
 *
 * Oberfläche (ns.auth) bleibt wie gehabt: init, signInEmail, signOut,
 * currentSession, currentUser, requireSession, getClient, redirectURL,
 * detectedLocale, magicLinkVerification, mountKeyLogin.
 */
(function (ns) {
  const detectedLocale = () => {
    const candidates = [...(navigator.languages || []), navigator.language].filter(Boolean);
    for (const value of candidates) {
      try {
        const canonical = Intl.getCanonicalLocales(String(value))[0];
        if (canonical) return canonical.slice(0, 24);
      } catch {}
    }
    return "en";
  };
  const redirectURL = () => {
    const u = new URL(location.href);
    u.search = ""; u.hash = "";
    return u.toString();
  };
  /* supabase-js erkennt den Magic-Link-Hash selbstständig (detectSessionInUrl). */
  const magicLinkVerification = () => null;

  let clientPromise = null;
  async function client() {
    if (!clientPromise) clientPromise = (async () => {
      const cfg = window.MOMO_CONFIG || {};
      const mod = await import("/vendor/supabase.js");
      return mod.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: "openos-supabase-auth",
        },
      });
    })();
    return clientPromise;
  }

  function emit() { try { document.dispatchEvent(new CustomEvent("momo:authchange")); } catch {} }

  /* ── Login-Formular (ersetzt Handle+PIN wieder durch E-Mail) ────── */
  function emailFormularHTML() {
    return `
      <div class="email-login magic-login" style="flex-direction:column;align-items:stretch;gap:10px">
        <input id="magicEmail" type="email" autocomplete="email" placeholder="deine@email.ch" aria-label="E-Mail">
        <button class="action-btn white" id="magicSend" type="button">Magic Link senden</button>
        <p class="auth-note" id="magicNote">Kein Passwort nötig — du erhältst eine E-Mail mit einem Anmelde-Link. Die Sitzung bleibt auf diesem Gerät erhalten.</p>
      </div>`;
  }
  function bindeEmailForm() {
    document.getElementById("magicSend")?.addEventListener("click", async () => {
      const email = (document.getElementById("magicEmail")?.value || "").trim();
      const note = document.getElementById("magicNote");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        if (note) note.textContent = "Bitte eine gültige E-Mail-Adresse eingeben.";
        return;
      }
      const btn = document.getElementById("magicSend");
      if (btn) btn.disabled = true;
      try {
        await signInEmail(email);
        if (note) note.textContent = "Link ist unterwegs — Postfach öffnen und Link anklicken. Danach bist du hier angemeldet.";
      } catch (e) {
        if (note) note.textContent = "Fehler: " + (e?.message || e);
        if (btn) btn.disabled = false;
      }
    });
    document.getElementById("magicEmail")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("magicSend")?.click();
    });
  }
  function bindeLoginUI() {
    document.querySelectorAll(".email-login").forEach((feld) => {
      if (feld.dataset.magic === "1") return;
      feld.dataset.magic = "1";
      feld.outerHTML = emailFormularHTML();
    });
    bindeEmailForm();
  }
  /* Für dynamisch gerenderte Container (Billing-Shell etc.). */
  function mountKeyLogin(container) {
    if (!container) return;
    container.outerHTML = emailFormularHTML();
    bindeEmailForm();
  }

  /* ── Auth-API ───────────────────────────────────────────────────── */
  async function init() {
    const sb = await client();
    // Magic-Link-Rückkehr: Sitzung aus URL-Hash übernehmen (supabase-js macht
    // das beim createClient mit detectSessionInUrl — hier nur UI-Refresh).
    sb.auth.onAuthStateChange(() => emit());
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bindeLoginUI);
    } else bindeLoginUI();
    emit();
    return sb;
  }

  async function signInEmail(email) {
    const sb = await client();
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectURL() },
    });
    if (error) throw error;
    return { ok: true };
  }
  async function refresh() {
    const sb = await client();
    const { data } = await sb.auth.getSession();
    return data?.session || null;
  }
  async function requireSession() {
    const sb = await client();
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    if (!data?.session) throw new Error("Bitte zuerst per Magic Link anmelden.");
    return data.session;
  }
  function currentSession() {
    // Synchroner Best-Effort-Zugriff (volle Prüfung über requireSession).
    try {
      const raw = localStorage.getItem("openos-supabase-auth");
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const s = parsed?.currentSession;
      if (s && (s.expires_at || 0) * 1000 > Date.now()) return s;
    } catch {}
    return null;
  }
  function currentUser() { return currentSession()?.user || null; }
  async function signOut(scope = "local") {
    const sb = await client();
    await sb.auth.signOut({ scope: scope === "global" ? "global" : "local" });
    emit();
  }
  async function signOutOtherSessions() {
    const sb = await client();
    await sb.auth.signOut({ scope: "others" });
    return { error: null };
  }
  async function getClient() {
    const sb = await client();
    const session = await requireSession();
    void session;
    return sb;
  }

  ns.auth = { init, refresh, signInEmail, signOut, signOutOtherSessions, currentSession, currentUser,
    requireSession, getClient, redirectURL, detectedLocale, magicLinkVerification, mountKeyLogin };
})(window.MomoApp = window.MomoApp || {});
