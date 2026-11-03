# VERIFICATION.md — Unabhängige Prüfung von OpenOS Momo AI

Dieses Dokument ist die vollständige Prüfanleitung. Jeder Schritt ist live,
kopierbar und ohne Account ausführbar. Wer ein Ergebnis meldet, soll das
Protokoll mitschicken — wir antworten auf jede fundierte Prüfung.

*English readers: every step below is a plain `curl` against public
endpoints. Run them, keep the transcripts, and open an issue with your
results.*

---

## 0) Fingerabdrücke / Fingerprints

| Artefakt | URL | SHA-256 |
|---|---|---|
| Bitseed-Engine | `https://app.openos.space/kompression/assets/bitseed-engine.js` | `57b79b24aa291b935a5b5c470456ec40d4f3d5d5e22b66fd393c35f80766a4da` |
| Verifikations-Endpunkt (Quell) | `verifikation/openos-verify.source.mjs` (im Audit-Paket) | `2064c1a761def0d9d16948d6e0c7f7abf04d26f79bee1d0b7fc7762beac2f835` |
| Saiten-LLM (beide Kopien) | `momo/saiten-engine/saiten-llm.js`, `verifikation/saiten-engine/saiten-llm.js` | `4a88601d89add469f85469cd27ca36ff49c3927732666430336cc255801a0115` |

Die beiden `saiten-llm.js`-Kopien müssen **byte-identisch** sein.
Beide Engine-Fingerabdrücke werden bei jedem Deployment live geprüft —
ein stiller Wechsel würde auffallen.

## 1) Verlustfreiheit / Losslessness

```bash
curl -s https://app.openos.space/.netlify/functions/openos-verify
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

## 4) MCP + OAuth

```bash
curl -s https://app.openos.space/.well-known/oauth-authorization-server
curl -s https://app.openos.space/.well-known/oauth-protected-resource
curl -s https://app.openos.space/mcp -X POST -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Erwartung: RFC-8414-Metadaten, und `tools/list` liefert die Werkzeugliste.
Login im MCP erfolgt per OAuth gegen das OpenOS-Nutzerkonto — dokumentiert
in Abschnitt 4 von `https://app.openos.space/llms.txt`.

## 5) Offline-PWA

App installieren (Browser: „Zum Startbildschirm hinzufügen"), Flugmodus an,
App öffnen. Erwartung: Chat, Kompression, Bibliothek, Credits-Abrechnung
laufen lokal; nur der Credit-**kauf** braucht Netz.

## 6) Datenschutz-Behauptung / Privacy claim

Die prüfbare Behauptung ist architektonisch: **der Antwortpfad enthält kein
Netzwerk** — Chat, Kompression und Analyse laufen in Workern auf dem Gerät
(`momo-saite-worker.js`, `kompression/assets/bitseed-engine.js`,
`compression-local.js`). Wer das Gegenteil beweist, hat einen
Sicherheitsfund: bitte sofort melden (Issue oder responsible disclosure an
den Account in der App).

## 7) Ergebnis melden / Report results

Issue im Repository öffnen mit: Befehle, Zeitstempel, vollständige Ausgabe,
dein Fazit. Funde werden öffentlich beantwortet.
