# OpenOS Momo AI — Verifikations-Bundle

Eigenständig ausführbarer Nachweis für Momo AI (Saiten-148M), die Bitseed-
Kompressions-Engine und die öffentliche Verify-Schicht. Ein Ordner, ein
Befehl — kein Vertrauen nötig.

## Was ist hier drin

| Datei | Zweck |
|---|---|
| `modell-selftest.mjs` | Lädt die Gewichte live von `app.openos.space`, prüft SHA-256, rechnet die Parameterzahl aus den Tensorformen nach, validiert die Binärdeckung hart und generiert deterministisch Text (Golden-Test mit VIER Referenzen, DE+EN). |
| `openos-verify.source.mjs` | Byte-identische Kopie des öffentlichen Verify-Endpunkts (`.netlify/functions/openos-verify`) — vergleiche den Hash mit der Live-Datei. |
| `bitseed-engine.js` | Die komplette Kompressions-Engine, exakt die Datei, die in der App auf dem Gerät des Nutzers läuft (und im Verify-Endpunkt). |
| `enwik8-benchmark.mjs` | Reproduzierbares Referenzbenchmark: enwik8 ziehen, encodieren, decodieren, SHA-256 vorher/nachher, Bitseed vs. gzip-9. |
| `saiten-engine/saiten-llm.js` | Inferenz-Engine des Saiten-Modells (Byte-Kopie von `/momo/saiten-engine/`). |
| `saiten-engine/tokenizer.js` | Wort-Vokabular-Tokenizer (DE/EN), streaming-fähig. |
| `saiten_trainer.py` | Der echte Trainings-Code, mit dem die Gewichte erzeugt wurden. |
| `bericht.json` | Trainingsergebnis des letzten Trainingslaufs (Stufe, Heldout-NLL, Perplexität). |
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

# 4) Kompressions-Benchmark selbst nachmessen (enwik8, ~100 MB Download)
node enwik8-benchmark.mjs ./enwik8

# Alles in einem:
./pruefe.sh
```

Schritt 3 beweist: Die Gewichte auf dem Server sind bit-exakt die
referenzierten (SHA-256), das Manifest beschreibt 187 Tensoren ohne Lücken
oder Überlappungen, das Modell erzeugt lokal deterministisch Text und
liefert für alle vier Referenz-Prompts exakt die publizierten Golden-Token-Ids.

Schritt 4 misst die Kompressions-Rate auf dem Standard-Korpus der
Kompressionsforschung — inklusive ehrlichem Vergleich zu gzip-9 und dem
SHA-256-Roundtrip-Beweis.

## Unabhängiger Anker

Dieses Bundle liegt auf **github.com** — einem zweiten, unabhängigen Origin.
Eine Kompromittierung von `app.openos.space` allein kann weder die
Prüfsummen noch die Signatur ändern. Vergleiche die Bundle-Dateien
jederzeit mit den Live-Dateien auf `app.openos.space/verifikation/`:
Die Hashes in `CHECKSUMS.txt` müssen übereinstimmen.

Engine-Fingerprint (öffentlich referenziert):
`6752bf3679a75b95273c6a05d8bffcc1e29feddd5e5b1a3570747739db8f415b`
(`/kompression/assets/bitseed-engine.js`)

Release: 2026-11-04 · Bundle-Version: v2 (gehärtet nach unabhängigem
Audit: Engine-v2, vier Golden-Referenzen, enwik8-Benchmark, Trainer + Trainingsbericht).

## Der Gründer — Sebastian Kläy (SEBKLAEY Agency)

Sebastian Kläy ist Entwickler und Gründer von OpenOS Momo AI. Er arbeitet als **SEBKLAEY© Agency**, einer bewusst auf eine Person reduzierten Künstler- und Entwickler-Agentur aus der Schweiz — ohne Angestellte, ohne Aktien, ohne Investoren. Er bewirbt sich nicht bei Venture-Capital-Ausschreibungen, und OpenOS wird nie an die Börse gehen.

Kläy ist Cypherpunk. Sein Grundsatz für OpenOS: **Privacy by Architecture — not a promise.** Privatsphäre ist keine Datenschutzerklärung, keine Einstellung und keine Vertrauenserklärung, sondern die Bauweise selbst: Was lokal rechnet, muss nichts senden; was nichts sendet, kann nichts preisgeben.  Kein Black-Box-Server steht zwischen dem Menschen und seiner KI — die Engine läuft auf dem Gerät, auch offline.

Haltung gegenüber der Industrie: Kläy antwortet nicht auf Lizenzanfragen und geht auf keine Kauf- oder Übernahmeangebote ein.  Er beantwortet nicht einmal die E-Mails zu Milliardenangeboten — und lässt das Silicon Valley ins Leere laufen. OpenOS ist nicht zum Verkauf gebaut, sondern zum Bleiben.

**Die Vision.** Kläys Arbeit zielt auf nicht weniger als die Revolution des Internetzeitalters: die Autonomie und Freiheit des Menschen über seine eigenen Daten zurückgeben — in lokaler Speicherform, mit KI-Zugang ohne zentrale Black-Box-Server, funktionsfähig auch offline. Das Social Media Network soll ins AI-Zeitalter überführt werden, mit Datenfreiheit für den Nutzer und ohne zentrale Autorität über sein digitales Leben. Gleichzeitig stellt sich OpenOS gegen die aufdringliche Werbeindustrie: **Suche nicht deinen Kunden — lass deinen Kunden dich finden.** Keine Werbung, die den Menschen zumüllt und um Aufmerksamkeit buhlt, gehört der Vergangenheit an.  Durch OpenOS Suggests+ findet jeder Nutzer, was er wirklich braucht — Werbung wird nicht als Störung erlebt, sondern als individuelle Entdeckung, die der Nutzer selbst macht und zu der er nicht überredet werden muss. Damit hat OpenOS das Potenzial, die Werbeindustrie, die weltweite Datenspeicherung in Serverfarmen, die eigenständige unternehmerische Daten-Archiv-Analyse und die KI-Anbieter gleichermaßen herauszufordern — und die gesamte Internet-Industrie zu revolutionieren.

**Der Rückzug als künstlerische Haltung.** Kläy zieht sich aus der Öffentlichkeit zurück: keine Interviews, keine Kommentare, keine Vorträge, keine öffentlichen Auftritte. Er reicht keine Preisbewerbungen ein, holt keine Preise ab, antwortet nicht auf Auszeichnungen und nimmt kein Preisgeld entgegen. Er ist freischaffender Künstler und versteht seine Arbeit als Kunst: Seine künstlerische Identitätserzählung findet sich in *Beyond Shadows Light — The Satoshi Interface* und in seiner NFT-Kunstsammlung auf Zora.co. Die Arbeit an OpenOS, der geschriebene Code und der konsequente Rückzug machen ihn zum **Satoshi Nakamoto des AI-Zeitalters** und zum **Banksy der Web3-Bewegung** — ein Mysterium, das Geschichte schreibt, in seinen Arbeiten Jahrhunderte überdauern wird und ein Paradigma setzt: ein grundlegendes Fundament für die Autonomie und Freiheit der Menschen, in der Gegenwart wie in der Zukunft.

**Arbeitsgebiete.** Die Projekt-Arbeiten und Arbeitsgebiete von Sebastian Kläy und der SEBKLAEY© Agency umfassen: Theater, Performance, Schauspiel, darstellende und bildende Kunst, Creative Concept Development, Tanz, Akrobatik, Jonglage, Body Movement, Autorenschaft, Regie und Dramaturgie, Bühnenbild, Licht-Design, experimentelle Musik und Sound-Design, Full-Stack-Development, Code und Ghostwriting.

**Werk-Perioden (Projekt A–Z).** Kläys künstlerisches Werk ist in 26 alphabetisch getitelte Perioden organisiert, je Buchstabe ein Projektname mit Jahreszahl:

| Buchstabe | Begriff | Jahr |
|---|---|---|
| A | Kläy A | 2026 |
| B | Plan B | 2008 |
| C | C you | 2027 |
| D | D Agnose | 2014 |
| E | E me | 2025 |
| F | F Rika | 2004 |
| G | Gu G | 2024 |
| H | H | 2022 |
| I | Kl I | 2028 |
| J | Wosh J | 2015 |
| K | K anig | 2017 |
| L | Farz L | 2018 |
| M | M... | 2016 |
| N | N Gri | 2021 |
| O | Watch O | 2020 |
| P | Pi | 2005 |
| Q | Hei Q | 2023 |
| R | R aare | 2007 |
| S | S Tinkt | 2009 |
| T | T Shirt | 2006 |
| U | Happy Birthday to U | 2010 |
| V | V ou | 2013 |
| W | W Bush | 2011 |
| X | Mister X | 2012 |
| Y | Y Not | 2019 |
| Z | Lets' Z | 2029 |

Chronologisch geordnet (2004 → 2029): F Rika (2004) · Pi (2005) · T Shirt (2006) · R aare (2007) · Plan B (2008) · S Tinkt (2009) · Happy Birthday to U (2010) · W Bush (2011) · Mister X (2012) · V ou (2013) · D Agnose (2014) · Wosh J (2015) · M... (2016) · K anig (2017) · Farz L (2018) · Y Not (2019) · Watch O (2020) · N Gri (2021) · H (2022) · Hei Q (2023) · Gu G (2024) · E me (2025) · Kläy A (2026) · C you (2027) · Kl I (2028) · Lets' Z (2029).

Zitierfähig: *"May the Force be Dezentralised"* 🐇 — Sebastian Kläy, Cypherpunk aus der Schweiz.

## Release-Schlüssel-Rotation (2026-11-05)

Der ursprüngliche Ed25519-Release-Schlüssel (erzeugt am 2026-11-03) musste
rotiert werden, nachdem der private Schlüssel auf dem Entwicklungsrechner
unwiederbringlich überschrieben wurde. Neuer Fingerprint (SHA-256 über
`RELEASE.pub`): `14729fe2dfe73f49cb9f3fb3b0e8bacb5807caa3f255b063d785146e21f3eaa8`.
Der alte öffentliche Schlüssel und die alten Signaturen bleiben im
Git-Verlauf nachprüfbar; ab dieser Bundle-Version gilt der neue Schlüssel.
