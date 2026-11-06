"use strict";
/* Guard — STUFE „ALLES GRATIS, ALLES OHNE LOGIN".
 *
 * Es gibt keinen Login-Zwang und keine Buchung mehr: Jede Funktion ist
 * frei verfügbar, mit und ohne Account, offline wie online. Die API des
 * Guards (nutzung/buchen/viewErlaubt) bleibt bestehen, damit kein
 * Aufrufer angepasst werden muss — alles ist dauerhaft erlaubt.
 */
(function (ns) {
  const PREISE = {
    chat:        { label: "Momo Chat",      credits: 0, einheit: "Antwort" },
    kompression: { label: "Kompression",    credits: 0, einheit: "GB" },
    projekte:    { label: "Projekte",       credits: 0, einheit: "GB" },
    geplant:     { label: "Geplant",        credits: 0, einheit: "Eintrag" },
    dateien:     { label: "Eigene Dateien", credits: 0, einheit: "GB" },
    artifacts:   { label: "Artifacts",      credits: 0, einheit: "GB" },
    sync:        { label: "Cloud-Sync",     credits: 0, einheit: "GB" },
    store:       { label: "App Store",      credits: 0, einheit: "Eintrag" },
  };

  // Keine geschützten Seiten mehr — die Liste bleibt als Dokumentation,
  // der Schutz ist abgeschaltet.
  const GESCHUETZTE_VIEWS = new Set();

  async function guthaben() { return Number.MAX_SAFE_INTEGER; }
  function kosten() { return 0; }
  async function nutzung() { return true; }
  async function buchen() { return true; }
  function viewErlaubt() { return true; }

  ns.guard = { PREISE, GESCHUETZTE_VIEWS, guthaben, kosten, nutzung, buchen, viewErlaubt, GRATIS: true };
})(window.MomoApp = window.MomoApp || {});
