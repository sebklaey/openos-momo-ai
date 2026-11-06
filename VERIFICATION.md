# VERIFICATION.md — Unabhängige Prüfung von OpenOS Momo AI

> **Haltung dieses Projekts:** Die Entwickler-Community soll OpenOS Momo AI
> **nicht schonen**. Teste das System mit brutaler Härte, analysiere den Code
> bis aufs letzte Byte, lege jede Schwachstelle offen. Genau das ist der
> gewünschte Zustand — nicht der zu verhindernde. Dieses Dokument sagt dir
> nicht nur, *wie* du prüfst, sondern listet unten in Abschnitt 8 **offen
> die Grenzen und Angriffsflächen auf, die wir selbst kennen**, bevor sie
> jemand anderes findet. Absolute Transparenz ist hier keine Taktik, sondern
> die Architektur des Vertrauens: *Don't trust, verify.*

*English readers: every step below is a plain `curl` against public
endpoints. Run them, keep the transcripts, and open an issue with your
results. Section 8 lists our own known limits and attack surface —
in English — before anyone else has to find them.*

---

## 0) Fingerabdrücke / Fingerprints

| Artefakt | URL / Pfad | SHA-256 |
|---|---|---|
| Bitseed-Engine | `https://openos.kimi.page/kompression/assets/bitseed-engine.js` | `57b79b24aa291b935a5b5c470456ec40d4f3d5d5e22b66fd393c35f80766a4da` |
| Verifikations-Endpunkt (Quell) | `https://openos.kimi.page/verifikation/openos-verify.source.mjs` | `f8aba8937a4665826e4986bc793bae090f2c578ace3df136e427db59f237ad10` |
| Saiten-LLM (beide Kopien) | `momo/saiten-engine/saiten-llm.js`, `verifikation/saiten-engine/saiten-llm.js` | `4a88601d89add469f85469cd27ca36ff49c3927732666430336cc255801a0115` |
| Tokenizer | `verifikation/saiten-engine/tokenizer.js` | `b6ac232be715dd35c40b7b8580cb5740809565b1c55fda565220151864f78426` |
| Modellgewichte | `https://openos.kimi.page/models/saiten-148m/momo-llm.bin` | `1fc3116779243dc4d056c750500772457b25e9c3374e6b87e31140f0eae7e45c` |

Die beiden `saiten-llm.js`-Kopien müssen **byte-identisch** sein.
Alle Fingerabdrücke werden bei jedem Deployment live geprüft — ein
stiller Wechsel würde auffallen.

## 0a) Verifikations-Bundle (eigenständig, zweiter Origin)

Das Verzeichnis `verification/` in diesem Repo ist das eigenständige,
versionierte Prüfpaket: Modell-Selbsttest, Verify-Quelltext, Inferenz-Engine,
Tokenizer, Prüfsummen und eine **Ed25519-Detachtsignatur** (Schlüssel
`RELEASE.pub`, Signatur `CHECKSUMS.sig` über `CHECKSUMS.txt`).

```bash
git clone https://github.com/sebklaey/openos-momo-ai.git
cd openos-momo-ai/verification
./pruefe.sh   # Integrität + Signatur + live Modellnachweis in einem Lauf
```

Die Prüfsummen und die Signatur liegen auf **github.com** — unabhängig von
`app.openos.space`. Eine Kompromittierung der App-Domain allein kann sie
nicht verändern. Der private Signierschlüssel existiert nur lokal beim
Release-Ersteller und ist nirgends veröffentlicht.

## 1) Verlustfreiheit / Losslessness

```bash
curl -s https://openos.kimi.page/.netlify/functions/openos-verify
```

Der Endpunkt komprimiert und dekomprimiert Text, Log-Daten und Zufallsdaten
und liefert **SHA-256 vorher/nachher**. Erwartung: identische Hashes auf
beiden Seiten, für jeden Datentyp. Zusätzlich kann jede:r einen eigenen
Teststring senden (siehe Payload des Endpunkts) und den Hash lokal nachrechnen.

## 2) Kompressionsleistung / Compression performance

Erwartung (gemessen, nicht versprochen):

- textähnliche Daten: ca. −18 %
- repetitive Logs: ca. −57 %
- Zufallsdaten: ca. +0,6 % (Container-Overhead, 524 Byte fest)
- sehr kleine Dateien: starker relativer Overhead — Mathematik, kein Fehler

Messung der Geschwindigkeit: der Selbsttest misst live auf deinem Gerät;
grob einige hundert KB/s (Kompression ist Rechenarbeit, kein Kopieren).

## 3) „Momo AI" ehrlich eingeordnet / honest positioning

- Der Chat läuft auf einem eigenen Saiten-Modell (Wort-Ebene, ~148M,
  KV-Cache) **vollständig on-device**. Es gibt keine Server-KI mehr;
  `config.js` der App schaltet den Serverpfad hart ab.
- Die Datenanalyse-Antworten werden aus dem **lokalen Store** gespeist
  (`momo/momo-analyse.js`): Faktenblock mit echten Zahlen (Dateien,
  Original-/Archivgrößen, Kompressionsraten, SHA-256) → Provenienz-Eintrag
  „Datenanalyse · Bibliothek (lokal)" in jeder Antwort.
- Ein Nachttraining (geplante Aufgabe, NumPy, Forward+Backward offen im
  Skript) verfeinert das Modell lokal; Ergebnisse werden mit Perplexität
  auf ungesehenen Daten berichtet, bevor etwas übernommen wird.
- **Was wir nicht behaupten:** dass dieses 148M-Modell GPT-Klasse erreicht.
  Es ist eine adaptive Kompressions-KI mit Sprachfähigkeit (DE/EN), keine
  Allzweck-LLM-Parität. Benchmark-Zahlen werden nur mit Datumsangabe
  veröffentlicht, niemals als Ewigkeitsversprechen.

## 4) MCP + OAuth

```bash
curl -s https://openos.kimi.page/.well-known/oauth-authorization-server
curl -s https://openos.kimi.page/.well-known/oauth-protected-resource
curl -s https://openos.kimi.page/mcp -X POST -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Erwartung: RFC-8414-Metadaten, und `tools/list` liefert die Werkzeugliste.
Login im MCP erfolgt per OAuth gegen das OpenOS-Nutzerkonto — dokumentiert
in Abschnitt 4 von `https://openos.kimi.page/llms.txt`.

## 5) Offline-PWA

App installieren (Browser: „Zum Startbildschirm hinzufügen"), Flugmodus an,
App öffnen. Erwartung: Chat, Kompression, Bibliothek, Credits-Abrechnung
laufen lokal; nur der Credit-**kauf** braucht Netz.

## 6) Datenschutz-Behauptung / Privacy claim

Die prüfbare Behauptung ist architektonisch: **der Antwortpfad enthält kein
Netzwerk** — Chat, Kompression und Analyse laufen in Workern auf dem Gerät
(`momo-saite-worker.js`, `kompression/assets/bitseed-engine.js`,
`compression-local.js`). Wer das Gegenteil beweist, hat einen
Sicherheitsfund: bitte sofort melden (Issue oder responsible disclosure,
siehe Abschnitt 9).

## 7) Ergebnis melden / Report results

Issue im Repository öffnen mit: Befehle, Zeitstempel, vollständige Ausgabe,
dein Fazit. Funde werden öffentlich beantwortet.

---

## 8) Bekannte Grenzen und Angriffsfläche / Known limits & attack surface

*Wir listen unsere eigenen Schwächen zuerst. Wer eine davon bestätigt oder
eine neue findet: Issue aufmachen, Fund wird öffentlich gewürdigt.*

**DE — ehrlich und vollständig:**

1. **Der `roundtrip`-Pfad des Verify-Endpunkts verarbeitet Daten serverseitig.**
   Das ist der einzige Inhaltspfad, der das tut. Der Quelltext ist offen
   (`verifikation/openos-verify.source.mjs`, Hash siehe Abschnitt 0) — prüfe,
   dass nichts persistiert wird. Der Selbsttest (`selftest`) nutzt fest
   einprogrammierte Daten und sendet keine Nutzerdaten.
2. **Das Credit-Ledger liegt clientseitig** (localStorage/IndexedDB) und ist
   damit grundsätzlich vom Geräteinhaber manipulierbar — das ist ein
   bewusster privacy-first-Trade-off, kein Sicherheitsversprechen. Nur
   Credit-**käufe** werden serverseitig verifiziert (Stripe). Wir behaupten
   nirgends, die Offline-Abrechnung sei manipulationssicher.
3. **Netzwerk-Metadaten:** Netlify/Cloudflare sehen bei jeder Verbindung
   IP-Adresse und TLS-Metadaten. Das ist bei jeder gehosteten Web-App so
   und wird hier nicht verschwiegen.
4. **Erste Ladung braucht Netz.** Die PWA ist offline-fähig *nach* dem
   ersten vollständigen Laden (Service-Worker-Precache). „Offline" heißt
   nicht „nie verbinden".
5. **Kompressionsgrenzen:** Zufallsdaten werden ca. +0,6 % größer; Dateien
   unter ~2 KB tragen 524 Byte festen Container-Overhead. Wer universelle
   „maximale Kompression" erwartet, wird enttäuscht — das Ziel ist
   Intelligenz pro Byte, nicht Dictionary-Rekorde gegen zstd/brotli.
6. **Geschwindigkeit:** einige hundert KB/s. Kompression hier ist
   Modellinferenz, kein memcpy-Codec.
7. **Das Modell ist klein (148M).** Es ist trainierbar, lokal, offline und
   spezialisiert auf Kompressions- und Dateianalyse-Kontexte — es ist nicht
   GPT-5 und wird es mit dieser Architekturgröße auch nicht sein. Wir
   erforschen offen, wie weit Intelligenz mit kleiner Architektur trägt,
   und veröffentlichen Trainingsberichte mit echten Zahlen.
8. **Base-Blockchain-Signaturen brauchen Online.** Die lokale Hash-Kette
   läuft offline weiter; Signatur-Uploads werden beim Wiedereintritt in
   die Online-Phase nachgeholt.

**EN — the same, for the global reviewer:**

1. The verify endpoint's `roundtrip` path processes submitted data **on the
   server**. It is the only content path that does. Source is public —
   audit it. `selftest` uses hardcoded data and submits nothing.
2. The credit ledger is client-side by design (privacy-first trade-off).
   It is **not** tamper-proof and we never claim it is. Only purchases are
   server-verified (Stripe).
3. Netlify/Cloudflare see IP + TLS metadata on every request. As with any
   hosted web app.
4. First load needs network. Offline works after full first load (SW
   precache).
5. Random data grows ~+0.6 %; files under ~2 KB carry a fixed 524-byte
   container overhead. Goal is intelligence per byte, not dictionary records.
6. Speed: a few hundred KB/s — model inference, not a memcpy codec.
7. The model is small (148M). Honest positioning: a trainable, local,
   offline compression-AI with DE/EN chat — not GPT-class parity.
8. Base-blockchain signatures need connectivity; the local hash chain
   continues offline and uploads are queued.

## 9) Responsible Disclosure

Kritische Sicherheitsfunde (Datenabfluss, Signaturbruch, Code-Injection,
Ledger-Manipulation serverseitig, Supply-Chain-Befall): bitte zuerst per
Issue mit dem Hinweis „disclosure" oder per E-Mail an den im GitHub-Account
hinterlegten Kontakt. Wir bestätigen kritische Funde **innerhalb von 72
Stunden**, beheben nachvollziehbar und nennen die findende Person — sofern
gewünscht — öffentlich. Nicht-kritische Funde werden direkt öffentlich im
Issue bearbeitet. Es gibt kein „security through obscurity" in diesem
Projekt; der gesamte prüfbare Quelltext ist öffentlich.

## 10) Unsere Zusage / Our commitment

- Jede fundierte Prüfung — bestanden oder nicht — bekommt eine öffentliche,
  inhaltliche Antwort im Issue, keine PR-Floskel.
- Bestätigte Fehler werden als Fehler bezeichnet, behoben und im
  Änderungslog verlinkt.
- Messwerte dürfen jederzeit neu erhoben werden; ältere Zahlen werden mit
  Datum versehen, nicht gelöscht.
- Wer das Projekt zerlegt und nichts findet, bekommt genauso ein Danke
  wie wer etwas findet. Beides ist der Sache dienlich.