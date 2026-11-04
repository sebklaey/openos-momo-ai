// OpenOS · Momo AI — öffentliche KI-Verifikations-Schicht
// Jeder darf prüfen, niemand muss glauben. Dieser Endpunkt läuft die echte
// Bitseed-Engine (derselbe Code wie im Browser des Nutzers) und liefert
// messbare, selbst nachprüfbare Beweise:
//
//   GET  /.netlify/functions/openos-verify        -> Meta: was, wie, womit prüfen
//   POST {"action":"selftest"}                    -> deterministische Testkörper,
//                                                     Kompressionsgrad, Tempo,
//                                                     SHA-256 Bit-Exaktheit
//   POST {"action":"roundtrip","data_base64":..}  -> eigene Daten (<= 512 KB)
//                                                     komprimieren + zurückprüfen
//
// Kein Login. Kein Schlüssel. Trust through verification — nicht durch Versprechen.
//
// Härtung (unabhängiger Audit vom 2026-11-03, Befunde P1/P3):
//   - Request-Body wird gestreamt und hart begrenzt BEVOR JSON geparst wird
//     (kein unbegrenztes Puffern grosser Bodies).
//   - Base64 wird strikt validiert (Zeichenmenge, Padding, Länge modulo 4,
//     kanonische Re-Kodierung) BEVOR dekodiert wird.
//   - Pro-IP-Drosselung: selftest max. 1x / 10 s, roundtrip max. 20 / Minute,
//     globale Selbsttest-Parallelität max. 2 (Rest wird mit 429 abgelehnt).
//   - Content-Length wird vor dem Lesen konservativ geprüft.

import { createHash } from "node:crypto";
// Die Engine registriert sich selbst am globalen Objekt (Browser-Build) —
// kein Export, darum Seiteneffekt-Import und danach globalThis lesen.
import "../../kompression/assets/bitseed-engine.js";
const BitseedEngine = globalThis.BitseedEngine;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/* harte Grenzen — öffentliche, kostenlose Strecke, deshalb eng. */
const MAX_ROUNTRIP_Bytes = 512 * 1024;          // dekodierte Nutzdaten
const MAX_B64_CHARS = 4 * Math.ceil(MAX_ROUNTRIP_Bytes / 3) + 4; // 699_076
const MAX_BODY_BYTES = MAX_B64_CHARS + 4096;    // JSON-Hülle + Luft, dann 413
const SELFTEST_COOLDOWN_MS = 10_000;            // pro IP
const ROUNTRIP_PER_MINUTE = 20;                 // pro IP
const SELFTEST_MAX_PARALLEL = 2;                // global

const H = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  // Jeder Antwort zeigt auf den lesbaren Quelltext dieser Funktion —
  // die "nichts wird gespeichert"-Aussage ist damit auditierbar, kein Versprechen.
  "link": '</verifikation/openos-verify.source.mjs>; rel="source"',
};

const json = (x, s = 200) => new Response(JSON.stringify(x, null, 2), { status: s, headers: H });

/* --- pro-IP-Drosselung (Prozess-Speicher, bewusst ohne Datenbank) ------------
   Es werden ausschliesslich Zeitstempel je IP gehalten — keine Inhalte,
   keine Nutzdaten. Verfälschen lässt sich das nur, indem jemand tausende
   IPs opfert; dagegen steht das enge Timeout der Funktion selbst. */
const ipVon = (req) =>
  (req.headers.get("x-nf-client-connection-ip") ||
   req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
   "unbekannt").slice(0, 64);

const selftestLetzter = new Map();   // ip -> letzter selftest-Zeitpunkt
const roundtripLog = new Map();      // ip -> [Timestamps letzte Minute]
let selftestLaufend = 0;

function drosselPruefen(req, art) {
  const ip = ipVon(req);
  const jetzt = Date.now();
  if (art === "selftest") {
    const t = selftestLetzter.get(ip) || 0;
    if (jetzt - t < SELFTEST_COOLDOWN_MS) {
      return `selftest: maximal 1x alle ${SELFTEST_COOLDOWN_MS / 1000} s pro IP — bitte ${Math.ceil((SELFTEST_COOLDOWN_MS - (jetzt - t)) / 1000)} s warten.`;
    }
    if (selftestLaufend >= SELFTEST_MAX_PARALLEL) {
      return "selftest: Server-Parallelität momentan erschöpft (max. 2) — bitte kurz warten.";
    }
    return null;
  }
  const liste = (roundtripLog.get(ip) || []).filter((t) => jetzt - t < 60_000);
  if (liste.length >= ROUNTRIP_PER_MINUTE) {
    return `roundtrip: maximal ${ROUNTRIP_PER_MINUTE} pro Minute pro IP — bitte warten.`;
  }
  liste.push(jetzt);
  roundtripLog.set(ip, liste);
  if (roundtripLog.size > 10_000) roundtripLog.clear(); // Speicherdeckel
  return null;
}

function drosselMerken(req) {
  selftestLetzter.set(ipVon(req), Date.now());
  if (selftestLetzter.size > 10_000) selftestLetzter.clear();
}

/* --- Body hart begrenzt lesen (streaming, bricht bei Überschreitung ab) ---- */
async function bodyLesen(req) {
  const deklariert = Number(req.headers.get("content-length") || 0);
  if (deklariert > MAX_BODY_BYTES) return null; // lügt der Client, fängt der Stream ab
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const teile = [];
  let gesamt = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    gesamt += value.length;
    if (gesamt > MAX_BODY_BYTES) { try { await reader.cancel(); } catch {} return null; }
    teile.push(value);
  }
  return Buffer.concat(teile.map((t) => Buffer.from(t)));
}

/* --- strikte Base64-Validierung (Audit P3) ---------------------------------
   Node dekodiert tolerant — wir akzeptieren nur kanonisches Base64:
   Zeichenmenge A–Z a–z 0–9 + /, korrektes Padding, Länge % 4 == 0,
   und Re-Kodierung muss zeichenidentisch sein. */
function base64Strikt(b64) {
  if (typeof b64 !== "string") return { fehler: "data_base64 muss ein String sein." };
  if (b64.length === 0) return { fehler: "data_base64 fehlt." };
  if (b64.length > MAX_B64_CHARS) return { fehler: `Base64 zu lang — maximal ${MAX_B64_CHARS} Zeichen (512 KB Nutzdaten).` };
  if (b64.length % 4 !== 0) return { fehler: "Ungültiges Base64: Länge nicht durch 4 teilbar." };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { fehler: "Ungültiges Base64: unzulässige Zeichen." };
  if (/=/.test(b64.slice(0, -2))) return { fehler: "Ungültiges Base64: Padding an falscher Position." };
  const data = Buffer.from(b64, "base64");
  if (data.toString("base64") !== b64) return { fehler: "Ungültiges Base64: nicht kanonisch." };
  if (data.length === 0) return { fehler: "Leere Eingabe." };
  if (data.length > MAX_ROUNTRIP_Bytes) return { fehler: "Maximal 512 KB pro Roundtrip (kostenlose öffentliche Strecke)." };
  return { data };
}

/* Deterministische Testkörper — gleiche Seeds, gleiche Bytes, bei jedem Aufruf.
   Jeder Prüfer kann sie lokal identisch erzeugen und unsere Zahlen nachrechnen. */
function testCorpora() {
  // (a) Text-ähnlich: wiederholende deutsche Sätze mit Variation (realistisch für Prosa/Logs)
  const woerter = ["Momo", "komprimiert", "Daten", "lokal", "privat", "offline", "die", "Saite",
    "schwingt", "und", "das", "Modell", "lernt", "Byte", "für", "Byte", "verlustfrei", "verifizierbar"];
  let s = 42;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let text = "";
  while (text.length < 262144) {
    const n = 4 + Math.floor(rnd() * 9);
    let satz = "";
    for (let i = 0; i < n; i++) satz += woerter[Math.floor(rnd() * woerter.length)] + " ";
    text += satz.trim() + ". ";
  }
  const textLike = Buffer.from(text.slice(0, 262144), "utf-8");

  // (b) Stark repetitiv: gleiche Zeile 4096x (Logs, CSV, Backups — das Zielgebiet)
  const zeile = "2026-11-03T09:15:00Z,node-07,INFO,Request verarbeitet,200,142ms,ok\n";
  const repetitive = Buffer.concat(Array(4096).fill(Buffer.from(zeile, "utf-8")));

  // (c) Quasi-zufällig: xorshift32-Stream (Grenzfall: kaum Kompression möglich,
  //     beweist dass die Engine Daten NICHT verändert, auch wenn nichts gewinnt)
  let x = 0x9e3779b9;
  const rndb = new Uint8Array(131072);
  for (let i = 0; i < rndb.length; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
    rndb[i] = x & 255;
  }
  return [
    { name: "text-aehnlich-256kb", data: textLike },
    { name: "repetitiv-log-256kb", data: repetitive },
    { name: "zufall-128kb", data: Buffer.from(rndb) },
  ];
}

function measure(name, data) {
  const t0 = process.hrtime.bigint();
  const hyb = Buffer.from(BitseedEngine.encode(new Uint8Array(data)));
  const t1 = process.hrtime.bigint();
  const back = Buffer.from(BitseedEngine.decode(new Uint8Array(hyb)));
  const t2 = process.hrtime.bigint();

  const encS = Number(t1 - t0) / 1e9;
  const decS = Number(t2 - t1) / 1e9;
  return {
    name,
    bytes_in: data.length,
    bytes_out: hyb.length,
    overhead_bytes: 12, // BTS3-Container: Magic + 64-Bit-Länge — offengelegt, nicht versteckt
    kompressionsgrad_prozent: Number((100 * hyb.length / data.length).toFixed(2)),
    reduktion_prozent: Number((100 - 100 * hyb.length / data.length).toFixed(2)),
    bits_pro_byte: Number(((hyb.length - 12) * 8 / data.length).toFixed(4)),
    encode_sekunden: Number(encS.toFixed(3)),
    decode_sekunden: Number(decS.toFixed(3)),
    encode_mb_pro_sekunde: Number((data.length / 1e6 / encS).toFixed(3)),
    sha256_eingabe: sha256(data),
    sha256_ausgabe: sha256(back),
    bit_exakt: sha256(data) === sha256(back),
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: H });
  if (req.method === "GET") {
    return json({
      dienst: "OpenOS Momo AI — KI-Verifikation",
      baujahr_engine: "Bitseed Engine v2 · kontext-mischende Ordnungs-Modelle 0/1/2/3/4/6 + verifizierter LZP-Match (positionsunabhängiger 4-Byte-Fensterhash) + logistischer Perzeptron-Mischer + APM-Nachkorrektur + binärer Arithmetik-Kodierer (BTS3)",
      verlustfrei: true,
      beweise: ["kompressionsgrad", "geschwindigkeit", "sha256-bit-exaktheit", "eigene-daten-roundtrip", "modell-greedy-determinismus"],
      grenzen: {
        roundtrip_max_bytes: MAX_ROUNTRIP_Bytes,
        roundtrip_pro_minute_pro_ip: ROUNTRIP_PER_MINUTE,
        selftest_mindestabstand_sekunden: SELFTEST_COOLDOWN_MS / 1000,
        selftest_max_parallel: SELFTEST_MAX_PARALLEL,
        body_max_bytes: MAX_BODY_BYTES,
        begruendung: "Öffentliche, kostenlose, rechenintensive Strecke — Drosselung schützt Verfügbarkeit und Kosten, ohne die Prüfbarkeit einzuschränken (deterministische Körper, identische Hashes bei jedem Lauf).",
      },
      artefakte: {
        engine_code: "https://app.openos.space/kompression/assets/bitseed-engine.js",
        engine_sha256: "6752bf3679a75b95273c6a05d8bffcc1e29feddd5e5b1a3570747739db8f415b",
        quelltext_dieser_funktion: "https://app.openos.space/verifikation/openos-verify.source.mjs",
        modell_gewichte: "https://app.openos.space/models/saiten-148m/momo-llm.bin",
        modell_gewichte_sha256: "1c244444fd7bae7a78152f73d7d90def3665fcb46abb0f655beff18a1f65891c",
        modell_manifest: "https://app.openos.space/models/saiten-148m/momo-llm.json",
        modell_selbsttest: "https://app.openos.space/verifikation/modell-selftest.mjs",
        verifikations_bundle: "https://github.com/sebklaey/openos-momo-ai/tree/main/verification",
        pruefsummen_signiert: "https://github.com/sebklaey/openos-momo-ai/blob/main/verification/CHECKSUMS.txt",
        signatur: "https://github.com/sebklaey/openos-momo-ai/blob/main/verification/CHECKSUMS.sig",
        oeffentlicher_schluessel: "https://github.com/sebklaey/openos-momo-ai/blob/main/verification/RELEASE.pub",
      },
      integritaet: {
        aussage: "Prüfsummen und Signatur liegen auf einem zweiten, unabhängigen Origin (github.com) — eine Kompromittierung von app.openos.space allein kann sie nicht verändern. Die Signatur ist eine Ed25519-Detachtsignatur über CHECKSUMS.txt, erstellt beim Release 2026-11-03.",
        selbst_pruefen: "1) CHECKSUMS.txt + CHECKSUMS.sig + RELEASE.pub von GitHub laden. 2) sha256sum -c CHECKSUMS.txt. 3) Signatur prüfen: openssl pkeyutl -verify -pubin -inkey RELEASE.pub -rawin -in CHECKSUMS.txt -sigfile CHECKSUMS.sig (Ed25519) — oder mit Node: crypto.verify(null, fs.readFileSync('CHECKSUMS.txt'), crypto.createPublicKey(fs.readFileSync('RELEASE.pub')), fs.readFileSync('CHECKSUMS.sig')). 4) Vergleiche die Datei-Hashes mit den Live-Dateien auf app.openos.space.",
      },
      momo_ai_modell: {
        aussage: "Momo AI ist ein eigenes, trainiertes Saiten-Transformer-Modell (148M Parameter, Wort-Ebene V=8000, D=768, L=20, NH=12, CTX=512, int8+fp16) plus die Bitseed-Kompressions-Engine. Es ist KEIN vortrainiertes Fremd-LLM und ruft keine externe Inferenz-API auf.",
        antwortpfad: "Das Modell läuft vollständig im Browser (WebWorker momo/momo-saite-worker.js) oder in Node (verifikation/modell-selftest.mjs). Das Netz ist nie Teil des Antwortpfads. Fremd-LLM-Dateien (Qwen/WebLLM) wurden am 2026-11-03 vollständig aus der App entfernt.",
        selbstnachweis: "Führe verifikation/modell-selftest.mjs aus (vollständig im GitHub-Verifikationsbundle): lädt die Gewichte von dieser Domain, prüft sha256, validiert die Binärdeckung hart (Offsets, Überlappungen, lückenlose Deckung bis Dateiende, Skalen — Abbruch bei Verstoß) und generiert deterministisch (Greedy-Argmax). Erwartete Token-Ids für den Standard-Prompt: [887,786,6714,7952,427,282,3088,293,7983,7974] -> 'Ich bin Momo, eine Saiten-K…'",
      },
      so_pruefst_du: {
        selbsttest: "POST diese URL mit JSON {\"action\":\"selftest\"} — liefert deterministische Testkörper mit SHA-256 vorher/nachher. Erzeuge die Körper lokal mit den dokumentierten Seeds und rechne nach. Max. 1x / 10 s pro IP.",
        eigene_daten: "POST JSON {\"action\":\"roundtrip\",\"data_base64\":\"<base64>\"} (max. 512 KB, strikt kanonisches Base64, max. 20 / Minute / IP) — liefert SHA-256 deiner Daten vorher/nachher Kompression. Vergleiche mit deinem lokalen SHA-256.",
        datenschutzsensibel: "Willst du keine Daten senden: die Kompressions-Seite (/kompression/) verifiziert Roundtrips vollständig lokal im Browser-Worker (WebCrypto SHA-256) — kein Byte verlässt dein Gerät. Der Server-Roundtrip hier ist die bequeme Alternative für KI-Prüfer; sein Quelltext ist offengelegt.",
        engine_code: "Die Engine ist identisch mit /kompression/assets/bitseed-engine.js — lade sie, prüfe den Hash, führe sie selbst aus.",
        modell: "node verifikation/modell-selftest.mjs — Beweis für trainierte Gewichte, harte Binärdeckung und deterministische lokale Generierung. Eigenständiges Bundle (inkl. saiten-engine/ und Tokenizer) auf GitHub: verification/",
        mcp: "Funktions-Endpunkt: https://rivudmparhyqvtgcboxw.supabase.co/functions/v1/openos-mcp-v1 (tools/list ohne Key)",
        sdk: "https://app.openos.space/momo-sdk.js",
      },
      garantien: {
        privatsphaere: "Verifikation läuft speicherintern; Eingaben werden nicht gespeichert. Beleg: der vollständige Quelltext dieser Funktion ist öffentlich (link-Header bzw. artefakte.quelltext_dieser_funktion) — er enthält keinen Datenbank-Client, keinen Speicher-Aufruf und kein Secret. Für null Upload: lokale Verifikation auf /kompression/.",
        determinismus: "Selbsttest-Körper sind seeded-deterministisch — jeder Lauf liefert identische Hashes. Modell-Generierung ist mit Greedy-Argmax deterministisch (siehe momo_ai_modell.selbstnachweis).",
      },
      zeitpunkt: new Date().toISOString(),
    });
  }
  if (req.method !== "POST") return json({ fehler: "Nur GET oder POST." }, 405);

  /* Body hart begrenzt lesen BEVOR geparst wird (P1) */
  const roh = await bodyLesen(req);
  if (roh === null) return json({ fehler: `Body zu gross — maximal ${MAX_BODY_BYTES} Bytes (Base64 von max. 512 KB Nutzdaten + JSON-Hülle).` }, 413);

  let body;
  try { body = JSON.parse(roh.toString("utf-8")); }
  catch { return json({ fehler: "JSON erwartet." }, 400); }

  if (body.action === "selftest") {
    const drossel = drosselPruefen(req, "selftest");
    if (drossel) return json({ fehler: drossel, status: 429, retry_in_sekunden: SELFTEST_COOLDOWN_MS / 1000 }, 429);
    drosselMerken(req);
    selftestLaufend++;
    try {
      const ergebnisse = testCorpora().map((k) => measure(k.name, k.data));
      return json({
        aktion: "selftest",
        engine: "Bitseed Engine v2",
        verlustfrei: ergebnisse.every((e) => e.bit_exakt),
        gesamt: {
          bytes_in: ergebnisse.reduce((a, e) => a + e.bytes_in, 0),
          bytes_out: ergebnisse.reduce((a, e) => a + e.bytes_out, 0),
        },
        ergebnisse,
        zeitpunkt: new Date().toISOString(),
      });
    } finally {
      selftestLaufend--;
    }
  }

  if (body.action === "roundtrip") {
    const drossel = drosselPruefen(req, "roundtrip");
    if (drossel) return json({ fehler: drossel, status: 429 }, 429);
    const pruef = base64Strikt(body.data_base64);
    if (pruef.fehler) return json({ fehler: pruef.fehler }, 400);
    const r = measure("eigene-daten", pruef.data);
    return json({
      aktion: "roundtrip",
      engine: "Bitseed Engine v2",
      verlustfrei: r.bit_exakt,
      pruefe_selbst: "SHA-256 deiner Eingabe muss mit sha256_eingabe übereinstimmen; sha256_ausgabe muss gleich sein (bit-exakt).",
      ergebnis: r,
      zeitpunkt: new Date().toISOString(),
    });
  }

  return json({ fehler: "Bekannte Aktionen: selftest, roundtrip." }, 400);
};
