#!/usr/bin/env node
/* BenzNIC — Registry-Signierwerkzeug.
 *
 * Verwaltet und signiert die .benz-Registry: name -> Inhaber, Records,
 * Preis. Dieselbe Ed25519-Identitaet wie die BenzResolver-Registry
 * (~/openos-ipfs/benz-registry-key.json) — ein Schluessel, eine Wahrheit.
 *
 * Aufruf:
 *   node benznic-sign.mjs --list
 *   node benznic-sign.mjs --name openos.benz --registrant "SEBKLAEY© Agency" --price-chf 0
 *   node benznic-sign.mjs --name wiki.benz --registrant "Jemand" --a 203.0.113.10
 *   node benznic-sign.mjs --name wiki.benz --remove
 *   node benznic-sign.mjs --show
 */
import { generateKeyPairSync, sign as edSign, verify as edVerify, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HIER = dirname(fileURLToPath(import.meta.url));
const KEY_DATEI = process.env.BENZ_KEY || `${process.env.HOME}/openos-ipfs/benz-registry-key.json`;
const REG_DATEI = join(HIER, "../../bitseed-chat/nic/registry.json");

function ladeSchluessel() {
  if (!existsSync(KEY_DATEI)) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ format: "jwk" });
    const priv = privateKey.export({ format: "jwk" });
    writeFileSync(KEY_DATEI, JSON.stringify({ publicKey: pub, privateKey: priv }, null, 2));
    chmodSync(KEY_DATEI, 0o600);
    console.log(`Neuer Benz-Registry-Schluessel: ${KEY_DATEI}`);
  }
  const k = JSON.parse(readFileSync(KEY_DATEI, "utf8"));
  return { pub: k.publicKey, priv: k.privateKey };
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function signiere(payloadObj) {
  const { pub, priv } = ladeSchluessel();
  const payload = JSON.stringify(payloadObj);
  const sig = edSign(null, Buffer.from(payload, "utf8"), createPrivateKey({ key: priv, format: "jwk" }));
  return { payload, signature: b64u(sig), signer: "benznic-registry-v1", publicKey: pub.x };
}
function verifiziere(reg) {
  const pubObj = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: reg.publicKey }, format: "jwk" });
  return edVerify(null, Buffer.from(reg.payload, "utf8"), pubObj, Buffer.from(reg.signature, "base64url"));
}

function lade() {
  try {
    const reg = JSON.parse(readFileSync(REG_DATEI, "utf8"));
    return { payloadObj: JSON.parse(reg.payload) };
  }
  catch { return { payloadObj: { version: 1, tld: "benz", updated: null, names: {} } }; }
}
function speichere(payloadObj) {
  payloadObj.updated = new Date().toISOString();
  const reg = signiere(payloadObj);
  writeFileSync(REG_DATEI, JSON.stringify(reg, null, 2));
  console.log(`Registry signiert (${Object.keys(payloadObj.names).length} Name(n)), Signatur gültig: ${verifiziere(reg)}`);
}

const a = process.argv.slice(2);
const wert = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };

if (a.includes("--list") || a.includes("--show")) {
  const reg = lade();
  console.log(`signer: benznic-registry-v1\npublicKey: ${reg.publicKey || "(keine)"}`);
  if (reg.payload) console.log(`signatur gültig: ${verifiziere(reg)}`);
  for (const [name, eintrag] of Object.entries((JSON.parse(reg.payload || "{}").names) || {}))
    console.log(`  ${name} → ${eintrag.registrant} (${eintrag.status}, ${eintrag.priceChf} CHF)`);
  process.exit(0);
}

const name = wert("--name");
if (!name || !name.endsWith(".benz")) { console.error("Bitte --name <name.benz> angeben."); process.exit(1); }

const daten = lade();
daten.payloadObj.names = daten.payloadObj.names || {};

if (a.includes("--remove")) {
  delete daten.payloadObj.names[name];
  speichere(daten.payloadObj);
  console.log(`${name} entfernt.`);
  process.exit(0);
}

const neu = daten.payloadObj.names[name] || { registered: new Date().toISOString() };
neu.registrant = wert("--registrant") || neu.registrant || null;
neu.registrar = "BenzNIC (self-hosted)";
neu.priceChf = wert("--price-chf") !== null ? Number(wert("--price-chf")) : (neu.priceChf ?? 0);
neu.currency = "CHF";
neu.renews = "nie";
neu.status = "aktiv";
if (wert("--a")) neu.a = wert("--a").split(",");
if (wert("--txt")) neu.txt = wert("--txt").split(";;");
if (wert("--cname")) neu.cname = wert("--cname");
daten.payloadObj.names[name] = neu;
speichere(daten.payloadObj);
console.log(`${name} → ${neu.registrant} (${neu.priceChf} CHF, erneuert: nie)`);
