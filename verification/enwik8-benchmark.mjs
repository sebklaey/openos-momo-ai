// Bitseed Engine — enwik8-Referenzbenchmark (reproduzierbar, kein Abo nötig).
//
// Was das Skript misst:
//   1. enwik8 (100.000.000 B Wikipedia-XML, Standard-Korpus der
//      Kompressionsforschung) einmal encodieren und decodieren.
//   2. SHA-256 vorher/nachher — die Wiederherstellung muss BIT-EXAKT sein.
//   3. Ausgabe als eine JSON-Zeile: Restgrösse, Prozent, Tempo, Belege.
//
// Reproduktion (Node 18+, keine Abhängigkeiten):
//   curl -fS -o enwik8.zip https://mattmahoney.net/dc/enwik8.zip
//   unzip -o -j enwik8.zip enwik8
//   shasum -a 256 enwik8
//   # erwartet: 2b49720ec4d78c3c9fabaee6e4179a5e997302b3a70029f30f2d582218c024a8
//   node enwik8-benchmark.mjs /pfad/zu/enwik8
//
// Hinweis zur Einordnung (ehrlich): Auf natürlichen Langtexten mit weit
// verteilter Redundanz (enwik8) liegt gzip -9 vorn — der Bitseed-Engine geht
// es um lokale, private Verarbeitung mit nachweisbarer Bit-Exaktheit; auf
// strukturierten/repetitiven Daten (Logs, Code, Tabellen) erreicht sie
// gzip-Parität bis Vorsprung. Beides ist unten und in llms.txt dokumentiert.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const pfad = process.argv[2];
if (!pfad) {
  console.error("Aufruf: node enwik8-benchmark.mjs /pfad/zu/enwik8");
  process.exit(1);
}

const require = createRequire(new URL("../kompression/assets/", import.meta.url));
require("./bitseed-engine.js");
const E = globalThis.BitseedEngine;

const data = readFileSync(pfad);
const shaEingabe = createHash("sha256").update(data).digest("hex");

const t0 = Date.now();
const hyb = Buffer.from(E.encode(new Uint8Array(data)));
const encMs = Date.now() - t0;

const t1 = Date.now();
const dec = Buffer.from(E.decode(new Uint8Array(hyb)));
const decMs = Date.now() - t1;

const shaAusgabe = createHash("sha256").update(dec).digest("hex");
const gz = gzipSync(data, { level: 9 });

console.log(JSON.stringify({
  korpus: "enwik8 (100.000.000 B Wikipedia-XML)",
  korpus_sha256_erwartet: "2b49720ec4d78c3c9fabaee6e4179a5e997302b3a70029f30f2d582218c024a8",
  korpus_sha256_gemessen: shaEingabe,
  eingabe_bytes: data.length,
  bitseed_bytes: hyb.length,
  bitseed_pct: +(100 * hyb.length / data.length).toFixed(4),
  gzip9_bytes: gz.length,
  gzip9_pct: +(100 * gz.length / data.length).toFixed(4),
  encode_ms: encMs,
  decode_ms: decMs,
  encode_mb_s: +(data.length / encMs / 1000).toFixed(2),
  decode_mb_s: +(data.length / decMs / 1000).toFixed(2),
  sha256_eingabe: shaEingabe,
  sha256_ausgabe: shaAusgabe,
  bit_exakt: shaEingabe === shaAusgabe,
}, null, 2));
process.exit(shaEingabe === shaAusgabe ? 0 : 1);
