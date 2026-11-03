// Momo AI · Saiten-148M Modell-Selbsttest — unabhängig nachprüfbar.
//
// Was dieser Skript beweist:
//   1. Auf app.openos.space liegt ein echtes, trainiertes Sprachmodell
//      (momo-llm.bin, 142 MB, ~148M Parameter) — kein Platzhalter.
//   2. Die Gewichte sind integritätsgesichert: sha256 wird hier lokal
//      berechnet und mit dem publizierten Referenz-Hash verglichen.
//   3. Die Parameterzahl wird NICHT behauptet, sondern aus den tatsächlich
//      geladenen Tensorformen des Manifests nachgerechnet.
//   4. Das Modell erzeugt lokal, deterministisch (Greedy/Argmax) Text:
//      Zwei unabhängige Läufe müssen identische token_ids liefern, und
//      die token_ids müssen den publizierten Golden-Referenzwerten
//      entsprechen (harter Test — bei Abweichung exit code 1).
//
// Ausführen (Node 18+, kein npm, keine Abhängigkeiten):
//
//   Variante A — eigenständiges Bundle (empfohlen, GitHub):
//     git clone https://github.com/sebklaey/openos-momo-ai.git
//     cd openos-momo-ai/verification
//     sha256sum -c CHECKSUMS.txt          # Bundle-Integrität lokal prüfen
//     node modell-selftest.mjs            # Modellnachweis, lädt Gewichte live
//
//   Variante B — einzelne Dateien von app.openos.space:
//     curl -O https://app.openos.space/verifikation/modell-selftest.mjs
//     mkdir -p saiten-engine
//     curl -o saiten-engine/saiten-llm.js https://app.openos.space/verifikation/saiten-engine/saiten-llm.js
//     curl -o saiten-engine/tokenizer.js  https://app.openos.space/verifikation/saiten-engine/tokenizer.js
//     node modell-selftest.mjs
//
//   Die Imports erwarten ./saiten-engine/ UNTERHALB des Skripts —
//   die Varianten oben legen die Dateien genau dorthin.
//
// Optionen:
//   node modell-selftest.mjs --prompt "DU: Was bist du?\nMOMO:" --tokens 16 --basis https://app.openos.space/
//
// Die Engine-Dateien unter ./saiten-engine/ sind Byte-Kopien von
// /momo/saiten-engine/ — vergleiche sie: sha256 muss übereinstimmen.

import { createHash } from "node:crypto";
import { SaitenLLM, gewichteEntpacken } from "./saiten-engine/saiten-llm.js";
import { vokabularLaden, encodiere, decodiere } from "./saiten-engine/tokenizer.js";

const args = process.argv.slice(2);
const argWert = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASIS = argWert("basis", "https://app.openos.space/").replace(/\/?$/, "/");
const PROMPT = argWert("prompt", "DU: Was bist du?\nMOMO:");
// Eingaben hart validieren: Bei ungültiger Zahl darf nicht still auf einen
// leeren Lauf geschwenkt werden — das würde den Golden-Test unterschlagen.
const tokensRoh = Number(argWert("tokens", "16"));
const MAX_TOKENS = Number.isInteger(tokensRoh) && tokensRoh >= 1 && tokensRoh <= 64
  ? tokensRoh
  : (() => { console.error("Ungültiger --tokens Wert (Ganzzahl 1..64 erwartet)."); process.exit(1); })();
const ERWARTETE_GEWICHTE_SHA256 =
  argWert("erwartet", "1fc3116779243dc4d056c750500772457b25e9c3374e6b87e31140f0eae7e45c");

// Golden-Referenzen für den Standard-Prompt. Diese Werte wurden einmalig
// aus einem lokalen Referenzlauf mit den referenzierten Gewichten erzeugt.
// Sie sind die Verbindung zwischen "Code läuft" und "Modell ist das Modell".
//   node modell-selftest.mjs   ->  muss exakt diese token_ids liefern,
//                                  sonst ist das Modell nicht das referenzierte.
const GOLDEN_PROMPT = "DU: Was bist du?\nMOMO:";
const ERWARTETE_TOKEN_IDS = [887, 786, 6714, 7952, 427, 282, 3088, 293, 7983, 7974, 7980, 7934, 232, 134, 154, 280];
const ERWARTETE_TEXT_PREFIX = "Ich bin Momo, eine Saiten-KI";
// Parameterzahl aus den Manifest-Tensorformen (Stand: Gewichte sha256 oben).
// Wird zur Laufzeit nachgerechnet — dieser Wert ist die harte Erwartung.
const ERWARTETE_PARAMETER_N = 148355569;

const URLS = {
  manifest: BASIS + "models/saiten-148m/momo-llm.json?v=saiten148m-s4",
  vocab: BASIS + "models/saiten-148m/momo-vocab.json?v=saiten148m-s4",
  bin: BASIS + "models/saiten-148m/momo-llm.bin?v=saiten148m-s4",
};

async function lade(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Laden fehlgeschlagen: ${url} (${r.status})`);
  return r.arrayBuffer();
}

const t0 = Date.now();
const [manifestRoh, vocabRoh, bin] = await Promise.all([
  lade(URLS.manifest).then((b) => JSON.parse(Buffer.from(b).toString("utf-8"))),
  lade(URLS.vocab).then((b) => JSON.parse(Buffer.from(b).toString("utf-8"))),
  lade(URLS.bin),
]);

// 1) Integrität der Gewichte: lokal hashen, gegen Referenz prüfen.
const gewichteSha256 = createHash("sha256").update(Buffer.from(bin)).digest("hex");
const integritaet = gewichteSha256 === ERWARTETE_GEWICHTE_SHA256;

// 2) Modell aufbauen — identisch zum Browser-Worker.
const gewichte = gewichteEntpacken(bin, manifestRoh);
const llm = new SaitenLLM(manifestRoh.konfig, gewichte);
const vok = vokabularLaden(vocabRoh);

// 3) Deterministische Greedy-Generierung (kein Sampling — Argmax).
//    Zwei unabhängige Läufe, danach Identitäts- und Golden-Prüfung.
const ctx = llm.cfg.CTX - 1;
const standardPrompt = PROMPT === GOLDEN_PROMPT;

function generiere() {
  let promptIds = encodiere(vok, PROMPT);
  if (promptIds.length > ctx) promptIds = promptIds.slice(-ctx);
  llm.reset();
  const tokenIds = [];
  let text = "";
  let naechste = -1;
  for (let n = 0; n < promptIds.length + MAX_TOKENS; n++) {
    const pid = n < promptIds.length ? promptIds[n] : naechste;
    const p = llm.schritt(pid);
    if (n < promptIds.length - 1) continue;
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i; // Greedy
    const stueck = decodiere(vok, [best], false);
    if (best === vok.ende) break;
    if (stueck.includes("\n")) break;
    if (/^\s*DU\s*:/.test(stueck)) break;
    if (tokenIds.length >= MAX_TOKENS) break;
    tokenIds.push(best);
    text += stueck;
    naechste = best;
  }
  return { tokenIds, text };
}

const tGen = Date.now();
const lauf1 = generiere();
const lauf2 = generiere();
const genMs = Date.now() - tGen;
const tokenIds = lauf1.tokenIds;
const text = lauf1.text;

// 4) Harte Prüfungen — jede einzelne muss bestanden werden.
const fehler = [];

// a) Gewichts-Integrität
if (!integritaet) fehler.push("gewichte_sha256");

// b) Parameterzahl aus den tatsächlich geladenen Tensorformen nachrechnen.
//    Nichts wird behauptet — alles wird gezählt und jeder Einzelne geprüft.
let parametern = 0;
const tensorEintraege = Object.entries(manifestRoh.tensoren || {});
if (tensorEintraege.length !== 187) fehler.push("tensor_anzahl");
for (const [name, t] of tensorEintraege) {
  if (!t || !Array.isArray(t.shape) || t.shape.length === 0 ||
      !t.shape.every((d) => Number.isSafeInteger(d) && d > 0)) {
    fehler.push("tensor_shape:" + name);
    continue;
  }
  const produkt = t.shape.reduce((a, b) => a * b, 1);
  if (!Number.isSafeInteger(produkt)) { fehler.push("tensor_ueberlauf:" + name); continue; }
  parametern += produkt;
}
if (parametern !== ERWARTETE_PARAMETER_N) fehler.push("parameterzahl");

// c) Determinismus: zwei unabhängige Läufe müssen identisch sein.
if (JSON.stringify(lauf1.tokenIds) !== JSON.stringify(lauf2.tokenIds)) fehler.push("determinismus");

// d) Golden-Test (nur beim Standard-Prompt): VOLLSTÄNDIGER Array-Vergleich —
//    weder weniger noch mehr Token dürfen akzeptiert werden. Nur sinnvoll,
//    wenn die Laufweite mindestens die Referenzlänge erreicht.
if (standardPrompt && MAX_TOKENS >= ERWARTETE_TOKEN_IDS.length) {
  if (JSON.stringify(tokenIds) !== JSON.stringify(ERWARTETE_TOKEN_IDS)) fehler.push("golden_token_ids");
  if (!text.trimStart().startsWith(ERWARTETE_TEXT_PREFIX)) fehler.push("golden_text");
}

const bericht = {
  dienst: "Momo AI — Saiten-148M Modell-Selbsttest",
  bestanden: fehler.length === 0,
  pruefungen: {
    gewichte_sha256: integritaet,
    binaerdeckung: true, // gewichteEntpacken haette bei Offset-, Ueberlappungs-, Luecken- oder Skalenverstoss hart abgebrochen (exit 1)
    parameterzahl_nachgerechnet: parametern,
    parameterzahl_erwartet: ERWARTETE_PARAMETER_N,
    determinismus_zwei_laeufe: fehler.indexOf("determinismus") < 0,
    golden_token_ids: (standardPrompt && MAX_TOKENS >= ERWARTETE_TOKEN_IDS.length) ? fehler.indexOf("golden_token_ids") < 0 : "uebersprungen (eigener Prompt oder tokens < 16)",
    golden_text: (standardPrompt && MAX_TOKENS >= ERWARTETE_TOKEN_IDS.length) ? fehler.indexOf("golden_text") < 0 : "uebersprungen (eigener Prompt oder tokens < 16)",
  },
  gewichte: {
    url: URLS.bin,
    bytes: bin.byteLength,
    sha256_lokal: gewichteSha256,
    sha256_referenz: ERWARTETE_GEWICHTE_SHA256,
    integritaet_bestanden: integritaet,
  },
  binaerdeckung: {
    geprueft: "offsets innerhalb der datei, keine ueberlappung, lueckenlose deckung von byte 0 bis dateiende, skalen vollstaendig und ungleich null",
    tensoren: Object.keys(manifestRoh.tensoren).length,
    bytes: bin.byteLength,
    bestanden: true,
  },
  modell: {
    name: "Momo Saiten-LLM",
    parametern_nachgerechnet_aus_manifest: parametern,
    konfig: manifestRoh.konfig,
    quantisierung: manifestRoh.bits,
    sprachen: ["de", "en"],
    laeuft: "vollständig lokal (Browser-Worker oder dieser Node-Prozess)",
  },
  generierung: {
    prompt: PROMPT,
    decoding: "greedy-argmax (determinisch)",
    lauf_2_token_ids_identisch: fehler.indexOf("determinismus") < 0,
    token_ids: tokenIds,
    text: text.trim(),
    tokens: tokenIds.length,
    dauer_ms: genMs,
    ms_pro_token: tokenIds.length ? Math.round(genMs / tokenIds.length) : null,
  },
  gesamt_dauer_ms: Date.now() - t0,
  zeitpunkt: new Date().toISOString(),
};

console.log(JSON.stringify(bericht, null, 2));
if (fehler.length) {
  console.error("\nSELBSTTEST FEHLGESCHLAGEN: " + fehler.join(", "));
  process.exit(1);
}
console.log("\nALLE PRÜFUNGEN BESTANDEN.");
