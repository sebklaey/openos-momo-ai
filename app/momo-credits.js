"use strict";
/* OpenOS Credits — STUFE „ALLES GRATIS".
 *
 * Es gibt keine Credits mehr: kein Guthaben, kein Verbrauch, kein Kauf,
 * keine Abrechnung. Jede Funktion der App ist frei verfügbar, mit und
 * ohne Account. Dieses Modul bleibt als verhaltensneutraler Stummel im
 * Code, weil Dutzende Stellen ns.momoCredits.* aufrufen — alle Aufrufe
 * sind damit erfolgreiche No-Ops. Der Rest des Systems braucht keine
 * einzige Änderung mehr an der Buchungslogik, weil es schlicht keine
 * Buchung mehr gibt.
 */
(function (ns) {
  const FREI = Number.MAX_SAFE_INTEGER;

  async function init() { return { ok: true, gratis: true }; }
  async function laden() { return { ok: true }; }
  function guthaben() { return FREI; }
  function hatGuthaben() { return true; }
  function kurztext() { return ""; }
  function anzeigen() { /* keine Balken, nichts anzuzeigen */ }
  async function kaufen() { return { ok: true, gratis: true }; }
  async function rueckkehr() { return { ok: true }; }
  function verbrauchHtml() { return ""; }
  function startseiteHtml() { return ""; /* keine Kaufkarte auf der Startseite */ }
  function preiseUmrechnen() { /* Preise gibt es nicht mehr */ }
  function balkenAktualisieren() { /* Balken existieren nicht mehr */ }
  async function verbrauchen() { return { ok: true, gratis: true, guthaben: FREI }; }
  const stand = { balance: FREI, currency: "none", gratis: true, offline: true };

  ns.momoCredits = {
    init, laden, guthaben, hatGuthaben, kurztext, anzeigen, kaufen, rueckkehr,
    verbrauchHtml, startseiteHtml, preiseUmrechnen, balkenAktualisieren,
    verbrauchen, stand: () => stand, GRATIS: true,
  };
})(window.MomoApp = window.MomoApp || {});
