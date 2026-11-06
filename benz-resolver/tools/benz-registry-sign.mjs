#!/usr/bin/env node
/* BenzRegistry — Signierwerkzeug für die .benz-Registry.
 *
 * Das Herz des eigenen Unstoppable-Domain-Systems: Eine JSON-Registry,
 * die name → IPFS-CID abbildet, signiert mit dem Benz-Registry-Schlüssel
 * (Ed25519). Die Extension prüft die Signatur gegen den eingebetteten
 * Public Key — niemand kann Einträge ändern, nur der Schlüsselinhaber.
 * Kein ICANN, kein Registrar, kein Unternehmen, keine Gebühr.
 *
 * Aufruf:
 *   node benz-registry-sign.mjs --name openos.benz --cid Qm...
 *   node benz-registry-sign.mjs --name openos.benz --remove
 *   node benz-registry-sign.mjs --show
 */
import {generateKeyPairSync, sign as edSign, verify as edVerify, createPrivateKey, createPublicKey} from "node:crypto";
import {readFileSync, writeFileSync, existsSync, chmodSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY_FILE = process.env.BENZ_KEY || `${process.env.HOME}/openos-ipfs/benz-registry-key.json`;
const REG_FILE = join(ROOT, "benz-registry.json");

/* ── Schlüsselpaar (einmalig erzeugt, NUR auf dieser Maschine) ── */
function ladeSchluessel() {
  if (!existsSync(KEY_FILE)) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ format: "jwk" });
    const priv = privateKey.export({ format: "jwk" });
    writeFileSync(KEY_FILE, JSON.stringify({ publicKey: pub, privateKey: priv }, null, 2));
    chmodSync(KEY_FILE, 0o600);
    console.log(`Neuer Benz-Registry-Schlüssel erzeugt: ${KEY_FILE}`);
    console.log(`Public Key (x): ${pub.x}`);
  }
  const k = JSON.parse(readFileSync(KEY_FILE, "utf8"));
  return { pub: k.publicKey, priv: k.privateKey };
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

function signiere(payloadObj) {
  const { pub, priv } = ladeSchluessel();
  const payload = JSON.stringify(payloadObj);
  const privObj = createPrivateKey({ key: priv, format: "jwk" });
  const sig = edSign(null, Buffer.from(payload, "utf8"), privObj);
  return { reg: { payload, signature: b64u(sig), signer: "benz-registry-v1", publicKey: pub.x }, payloadObj };
}

function verifiziere(reg) {
  // Erwartet {payload, signature, publicKey} — publicKey dient der Kontrolle,
  // die Extension vergleicht gegen ihren eingebetteten Schlüssel.
  const pubObj = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: reg.publicKey }, format: "jwk" });
  return edVerify(null, Buffer.from(reg.payload, "utf8"), pubObj, Buffer.from(reg.signature, "base64url"));
}

/* ── Argumente ── */
const args = process.argv.slice(2);
const nameIdx = args.indexOf("--name");
const cidIdx = args.indexOf("--cid");

if (args.includes("--show")) {
  const reg = JSON.parse(readFileSync(REG_FILE, "utf8"));
  const payload = JSON.parse(reg.payload);
  console.log(`signer:    ${reg.signer}`);
  console.log(`publicKey: ${reg.publicKey}`);
  console.log(`updated:   ${payload.updated}`);
  console.log(`signatur gültig: ${verifiziere(reg)}`);
  for (const [n, e] of Object.entries(payload.names)) console.log(`  ${n} → ipfs://${e.cid}`);
  process.exit(0);
}

if (nameIdx === -1) {
  console.error("Usage: --name <host> --cid <CID> | --name <host> --remove | --show");
  process.exit(1);
}

const host = args[nameIdx + 1].toLowerCase();
let payload;
try {
  const alt = JSON.parse(JSON.parse(readFileSync(REG_FILE, "utf8")).payload);
  payload = alt;
} catch {
  payload = { version: 1, updated: null, names: {} };
}
payload.version = 1;

if (args.includes("--remove")) delete payload.names[host];
else {
  if (cidIdx === -1) { console.error("--cid fehlt"); process.exit(1); }
  payload.names[host] = { cid: args[cidIdx + 1], updated: new Date().toISOString() };
}
payload.updated = new Date().toISOString();

const { reg, payloadObj } = signiere(payload);
writeFileSync(REG_FILE, JSON.stringify(reg, null, 2));
const ok = verifiziere(reg);
console.log(`Registry aktualisiert: ${Object.keys(payloadObj.names).length} Name(n), Signatur gültig: ${ok}`);
console.log(`Datei: ${REG_FILE}`);
if (!ok) { console.error("FEHLER: eigene Signatur ungültig!"); process.exit(1); }
