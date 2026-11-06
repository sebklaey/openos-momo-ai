"use strict";
async function anzeigen() {
  const d = await chrome.storage.local.get(["valid", "updated", "names", "checkedAt", "gateway"]);
  const names = d.names || {};
  const eintraege = Object.entries(names);
  document.getElementById("stValid").textContent = d.valid ? "gültig" : "keine gültige Registry";
  document.getElementById("stValid").className = d.valid ? "ok" : "bad";
  document.getElementById("stUpdated").textContent = d.updated ? d.updated.slice(0, 19).replace("T", " ") : "—";
  document.getElementById("stNames").textContent = eintraege.length
    ? eintraege.map(([h, e]) => `${h} → ${String(e.cid).slice(0, 12)}…`).join(" · ")
    : "—";
  document.getElementById("stGateway").textContent = d.gateway || "dweb";
  document.getElementById("stSig").textContent = d.valid ? "Ed25519 ✓" : "—";
  document.getElementById("stSig").className = d.valid ? "ok" : "dim";
}
document.getElementById("btnRefresh").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "benz-refresh" });
  await anzeigen();
});
document.getElementById("lnkOptions").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
anzeigen();
