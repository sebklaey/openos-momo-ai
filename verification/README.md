# OpenOS Momo AI — Verifikations-Bundle

Eigenständig ausführbarer Nachweis für Momo AI (Saiten-148M) und die
öffentliche Verify-Schicht. Ein Ordner, ein Befehl — kein Vertrauen nötig.

## Was ist hier drin

| Datei | Zweck |
|---|---|
| `modell-selftest.mjs` | Lädt die Gewichte live von `app.openos.space`, prüft SHA-256, rechnet die Parameterzahl aus den Tensorformen nach, validiert die Binärdeckung hart und generiert deterministisch Text (Golden-Test). |
| `openos-verify.source.mjs` | Byte-identische Kopie des öffentlichen Verify-Endpunkts (`.netlify/functions/openos-verify`) — vergleiche den Hash mit der Live-Datei. |
| `saiten-engine/saiten-llm.js` | Inferenz-Engine des Saiten-Modells (Byte-Kopie von `/momo/saiten-engine/`). |
| `saiten-engine/tokenizer.js` | Wort-Vokabular-Tokenizer (DE/EN). |
| `CHECKSUMS.txt` | SHA-256 aller Bundle-Dateien — `sha256sum -c CHECKSUMS.txt` prüft alles. |
| `CHECKSUMS.sig` | Ed25519-Detachtsignatur über `CHECKSUMS.txt`, Base64-codiert (Schlüssel: `RELEASE.pub`). |
| `RELEASE.pub` | Öffentlicher Ed25519-Release-Schlüssel. |
| `pruefe.sh` | Führt alle lokalen Prüfungen in einem Lauf aus. |

## Schnellstart

```bash
# 1) Bundle-Integritaet (offline moeglich)
sha256sum -c CHECKSUMS.txt

# 2) Signatur verifizieren (offline; openssl auf macOS kann kein Ed25519 —
#    darum primaer Node, einzeiliger Fallback in pruefe.sh)
node -e 'const c=require("crypto"),f=require("fs");const sig=Buffer.from(f.readFileSync("CHECKSUMS.sig","utf8").trim(),"base64");const ok=c.verify(null,f.readFileSync("CHECKSUMS.txt"),c.createPublicKey(f.readFileSync("RELEASE.pub")),sig);console.log("Signatur:",ok?"GUELTIG":"UNGUELTIG");process.exit(ok?0:1)'

# 3) Modellnachweis (laedt ~142 MB Gewichte von app.openos.space, Node 18+)
node modell-selftest.mjs

# Alles in einem:
./pruefe.sh
```

Schritt 3 beweist: Die Gewichte auf dem Server sind bit-exakt die
referenzierten (SHA-256), das Manifest beschreibt 187 Tensoren ohne Lücken
oder Überlappungen, das Modell erzeugt lokal deterministisch Text und
liefert für den Standard-Prompt exakt die publizierten Golden-Token-Ids.

## Unabhängiger Anker

Dieses Bundle liegt auf **github.com** — einem zweiten, unabhängigen Origin.
Eine Kompromittierung von `app.openos.space` allein kann weder die
Prüfsummen noch die Signatur ändern. Vergleiche die Bundle-Dateien
jederzeit mit den Live-Dateien auf `app.openos.space/verifikation/`:
Die Hashes in `CHECKSUMS.txt` müssen übereinstimmen.

Engine-Fingerprint (unverändert, öffentlich referenziert):
`57b79b24aa291b935a5b5c470456ec40d4f3d5d5e22b66fd393c35f80766a4da`
(`/kompression/assets/bitseed-engine.js`)

Release: 2026-11-03 · Bundle-Version: v1
