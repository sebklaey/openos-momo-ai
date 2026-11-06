"use strict";
/* BenzResolver — Hintergrunddienst.
 *
 * Lädt die signierte BenzRegistry von mehreren unabhängigen Spiegeln,
 * prüft die Ed25519-Signatur gegen den eingebetteten Public Key und
 * aktualisiert die Weiterleitungsregeln (declarativeNetRequest):
 * https://openos.benz/* → https://<cid>.ipfs.<gateway>/*
 *
 * Sicherheitsmodell: Nur Einträge mit gültiger Signatur werden aktiv.
 * Fällt jeder Spiegel aus oder ist die Signatur ungültig, werden ALLE
 * Regeln entfernt — der Browser verhält sich dann wie ohne Extension.
 */
const PUBKEY = { kty: "OKP", crv: "Ed25519", x: "ZPS4pqVS2dan2AvuJICqhN4iESGpFKBraEoHou01Wd8" };
const SIGNER = "benz-registry-v1";
const REFRESH_MINUTES = 30;
const MIRRORS = [
  "https://raw.githubusercontent.com/sebklaey/openos-momo-ai/main/benz-registry.json",
  "https://satoshi.kimi.page/benz-registry.json",
  "https://openos.benz/benz-registry.json"
];
const GATEWAYS = {
  dweb:   { label: "dweb.link (öffentlich)",   url: "https://dweb.link" },
  ipfsio: { label: "ipfs.io (öffentlich)",      url: "https://ipfs.io" },
  local:  { label: "Eigener Knoten (127.0.0.1:8080)", url: "http://127.0.0.1:8080" }
};
const DEFAULT_GATEWAY_KEY = "dweb";

let verifyKey = null;
async function ladeVerifyKey() {
  if (verifyKey) return verifyKey;
  verifyKey = await crypto.subtle.importKey("jwk", PUBKEY, { name: "Ed25519" }, false, ["verify"]);
  return verifyKey;
}

function b64urlZuBytes(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(pad + "=".repeat((4 - pad.length % 4) % 4)), c => c.charCodeAt(0));
}

async function pruefeSignatur(text) {
  let reg;
  try { reg = JSON.parse(text); } catch { return null; }
  if (reg.signer !== SIGNER || typeof reg.payload !== "string" || typeof reg.signature !== "string") return null;
  const key = await ladeVerifyKey();
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    b64urlZuBytes(reg.signature),
    new TextEncoder().encode(reg.payload)
  ).catch(() => false);
  if (!ok) return null;
  try {
    const data = JSON.parse(reg.payload);
    if (!data || typeof data.names !== "object") return null;
    return data;
  } catch { return null; }
}

async function ladeVonSpiegel(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!r.ok) return null;
    return await pruefeSignatur(await r.text());
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function gatewayUrl() {
  const { gateway, customGateway } = await chrome.storage.local.get({ gateway: DEFAULT_GATEWAY_KEY, customGateway: "" });
  if (gateway === "custom" && customGateway) return customGateway.replace(/\/$/, "");
  return (GATEWAYS[gateway] || GATEWAYS[DEFAULT_GATEWAY_KEY]).url;
}

async function wendeRegelnAn(names, gateway) {
  const bestehend = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: bestehend.map(r => r.id), addRules: []
  });
  if (!names) return;
  const regeln = [];
  let id = 1;
  for (const [host, eintrag] of Object.entries(names)) {
    const cid = eintrag && eintrag.cid;
    if (!cid || !/^Qm[a-zA-Z0-9]{44}$|^bafy[a-zA-Z0-9]+$/.test(cid)) continue;
    const esc = host.replace(/\./g, "\\.");
    regeln.push({
      id: id++,
      priority: 1,
      condition: {
        regexFilter: `^https?://${esc}(?::\\d+)?(/.*)?$`,
        resourceTypes: ["main_frame", "sub_frame"]
      },
      action: {
        type: "redirect",
        redirect: { regexSubstitution: `${gateway}/ipfs/${cid}\\1` }
      }
    });
  }
  if (regeln.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [], addRules: regeln });
  }
}

async function refresh() {
  const gateway = await gatewayUrl();
  const stand = await chrome.storage.local.get(["names", "updated", "valid"]);
  let daten = null;
  for (const spiegel of MIRRORS) {
    daten = await ladeVonSpiegel(spiegel);
    if (daten) break;
  }
  if (!daten) {
    await chrome.storage.local.set({ valid: false, checkedAt: new Date().toISOString() });
    if (stand.valid) await wendeRegelnAn(null); // Regeln nur entfernen, wenn vorher aktiv
    return;
  }
  const unveraendert = stand.updated === daten.updated && JSON.stringify(stand.names) === JSON.stringify(daten.names);
  await chrome.storage.local.set({
    names: daten.names, updated: daten.updated, valid: true,
    checkedAt: new Date().toISOString(), gateway
  });
  if (!unveraendert) await wendeRegelnAn(daten.names, gateway);
}

chrome.runtime.onInstalled.addListener(() => {
  refresh();
  chrome.alarms.create("benz-refresh", { periodInMinutes: REFRESH_MINUTES });
});
chrome.runtime.onStartup.addListener(refresh);
chrome.alarms.onAlarm.addListener(a => { if (a.name === "benz-refresh") refresh(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.gateway || changes.customGateway)) refresh();
});
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "benz-refresh") { refresh().then(() => sendResponse({ ok: true })); return true; }
});
