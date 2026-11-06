"use strict";
/* OpenOS Berechtigungen — STUFE „ALLES GRATIS, ALLES OHNE ACCOUNT".
 *
 * Es gibt keine Gates mehr. Jede Funktion ist erlaubt: mit Account,
 * ohne Account, offline, online. showGate öffnet nie einen Dialog,
 * assert wirft nie, renderMatrix liefert nichts — die gesamte
 * Abrechnungs- und Sperrlogistik ist abgeschaltet. Das Modul bleibt
 * nur als kompatible API-Schicht, weil viele Module ns.entitlements.*
 * aufrufen.
 */
(function (ns) {
  const FEATURES = {
    "local-chat": { label: "Momo Chat" },
    "projects": { label: "Projekte" },
    "planned": { label: "Geplant" },
    "local-files": { label: "Eigene Dateien" },
    "presence": { label: "Eigene AI-lesbare Presence" },
    "social": { label: "Social" },
    "match": { label: "Match" },
    "news": { label: "News" },
    "room": { label: "Room" },
    "store": { label: "App Store" },
    "suggests": { label: "Suggests" },
    "project-memory": { label: "Project Memory" },
    "artifacts": { label: "Artifacts / Work Surface" },
    "web-research": { label: "Web & Research" },
    "cloud-sync": { label: "Cloud-Sync" },
    "advanced-projects": { label: "Erweiterte Projektfunktionen" },
    "suggests-plus": { label: "Suggests+" }
  };

  const ERLAUBT = { allowed: true, reason: "gratis", message: "Verfügbar" };
  const evaluate = (feature) => ({ ...ERLAUBT, feature, label: FEATURES[feature]?.label || feature });
  const can = () => true;
  const plan = () => "gratis";
  const planLabel = () => "Gratis";
  function assert() { return true; }
  function showGate() { return true; }
  const closeGate = () => {};
  function renderMatrix() { return ""; }
  function snapshot() {
    const features = {};
    Object.keys(FEATURES).forEach((k) => { features[k] = evaluate(k); });
    return { plan: plan(), planLabel: planLabel(), signedIn: Boolean(ns.auth?.currentUser?.()), guthaben: null, hatGuthaben: true, features };
  }
  function refresh() {
    const s = snapshot();
    ns.core?.setCapability?.("entitlements", Object.fromEntries(Object.entries(s.features).map(([k, v]) => [k, v.allowed])));
    ns.core?.emit?.("entitlements-change", s);
    try { document.dispatchEvent(new CustomEvent("momo:entitlementschange", { detail: s })); } catch {}
    return s;
  }
  let initialized = false;
  function init() { if (!initialized) { initialized = true; } return refresh(); }

  ns.entitlements = { FEATURES, init, plan, planLabel, evaluate, can, assert, showGate, closeGate, renderMatrix, refresh, diagnostics: snapshot };
})(window.MomoApp = window.MomoApp || {});
