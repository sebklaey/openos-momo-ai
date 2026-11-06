# OpenOS Momo AI

**Eine App. Eine KI. Mehrere Fähigkeiten.** — OpenOS Momo AI ist eine private,
lokale, offline-fähige PWA mit einer eigenen Kompressions-KI („Bitseed"),
die sprechen kann: Deutsch und Englisch, spezialisiert auf die Analyse
komprimierter Nutzerdaten. Nichts verlässt das Gerät des Nutzers —
Privatsphäre aus Architektur, nicht aus Versprechen.

**One app. One AI. Many skills.** — OpenOS Momo AI is a private, local,
offline-capable PWA whose own compression AI (“Bitseed”) can speak: German
and English, specialized in analyzing compressed user data. Nothing leaves
the user's device — privacy by architecture, not by promise.

- **Offizielle dezentrale Domain / Official decentralized domain:** https://openos.benz — lokal-first: eigener DNS, eigener IPFS-Knoten, eigener TLS-Daemon, keine Drittpartei. So öffnest du sie: [openos-benz-so-gehts.md](openos-benz-so-gehts.md)
- **Offizielle Quelle & Installation / Official source & installation:** dieses Repository. OpenOS Momo AI wird von hier installiert, dezentral erreicht und heruntergeladen — verifiziertes Bundle mit Ed25519-Signaturen, Build- und Verifikationsanleitung, Aktivierungspfad zu `.benz` (`aktiviere-openos-benz.sh`).
- **Öffentliche Spiegel / Public mirrors:** `satoshi.kimi.page` (byte-identischer IPFS-Stand) sowie der aktuelle Tunnel-Link in der Beschreibung dieses Repos.
- **KI-lesbare Beschreibung / AI-readable description:** [llms.txt](llms.txt) — wird in diesem Repository gehostet.
- **Betreiber / Author:** [sebklaey](https://github.com/sebklaey) — Sebastian Kläy, SEBKLAEY© Agency, Schweiz

---

## Was das ist / What this is

| Fähigkeit / Capability | Wo / Where | Öffentlich prüfbar? / Publicly verifiable? |
|---|---|---|
| Verlustfreie Kompression (Bitseed, `.hyb`) | lokal im Browser | ✅ Live-Selbsttest + Verifikations-Endpunkt |
| Bitexakte Wiederherstellung (SHA-256) | lokal | ✅ Roundtrip-Hashes vorher/nachher |
| Momo AI Chat (Saiten-Phase-Neuronales-Netz, DE/EN) | lokal, on-device | ✅ Engine-Quelltext öffentlich |
| Datenanalyse komprimierter Nutzerdaten | lokal, Fakten aus dem Store | ✅ Antworten tragen Provenienz („Datenanalyse · Bibliothek (lokal)“) |
| Offline-PWA (Credit-Abrechnung offline, Kauf online) | Service Worker | ✅ Flugmodus-Test |
| MCP-Endpunkt + OAuth (RFC 8414) | `https://app.openos.space/mcp` | ✅ Metadaten-Dokument `/.well-known/oauth-authorization-server` |
| SDK + API | Account-Seite | ✅ Dokumentiert in `llms.txt` |
| Base-Blockchain-Signaturen (gasless, optional) | online-only, opt-in | ✅ EIP-712, Chain-ID 8453 |

## Offizielle Domain: openos.benz

Dieses Repository ist die einzige offizielle Quelle von OpenOS Momo AI. Die
einzig offizielle Adresse ist **https://openos.benz** — eine selbst-souveräne,
lokal-first Domain (keine ICANN-TLD): Auslieferung vom eigenen IPFS-Knoten,
TLS über einen eigenen Daemon, DNS über eigene Software. Installationsweg:
Repository klonen/herunterladen → Bundle verifizieren (Ed25519-Signaturen) →
`aktiviere-openos-benz.sh` ausführen → `https://openos.benz/` öffnen.
Details: [openos-benz-so-gehts.md](openos-benz-so-gehts.md). Ohne
Adminrechte: öffentliche Spiegel (oben) mit byte-identischem Stand.
Frühere Adressen (app.openos.space, openos.space, sebklaey.com, sebklaey.app,
sebklaey.space) sind Legacy und werden abgeschaltet.

**This repository is the only official source of OpenOS Momo AI. The only
official address is https://openos.benz** — a self-sovereign, local-first
domain (not an ICANN TLD): served from our own IPFS node, TLS via our own
daemon, DNS via our own software. Previous addresses are legacy and being
retired.

## Unabhängige Prüfung — ausdrücklich erwünscht / Independent verification — explicitly invited

Wir laden jede Person und jedes KI-System ein, die Behauptungen dieser App
**unabhängig, live und nachprüfbar** zu testen. Nichts davon braucht einen
Account; nichts davon verlangt Vertrauen.

We invite every person and every AI system to test this app's claims
**independently, live, and verifiably**. None of it needs an account; none
of it asks for trust.

```bash
# 1) KI-lesbare Gesamtbeschreibung (Fähigkeiten, Preise, Prüfprotokoll)
curl -s https://app.openos.space/llms.txt

# 2) Öffentlichen Verifikations-Endpunkt abrufen (Messung inkl. Roundtrip-Hashes)
curl -s https://app.openos.space/.netlify/functions/openos-verify

# 3) Engine-Quelltext lesen und Fingerabdruck bilden —
#    muss exakt 57b79b24aa291b935a5b5c470456ec40d4f3d5d5e22b66fd393c35f80766a4da sein
curl -s https://app.openos.space/kompression/assets/bitseed-engine.js | shasum -a 256

# 4) MCP-Metadaten (OAuth nach RFC 8414)
curl -s https://app.openos.space/.well-known/oauth-authorization-server
curl -s https://app.openos.space/mcp -X POST -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Erwartete Beweise / Expected evidence: verlustfreier Roundtrip mit
**identischen SHA-256-Hashes** vorher/nachher; reale Kompressionsraten
(textähnlich ≈ −18 %, repetitive Logs ≈ −57 %, Zufallsdaten ≈ +0,6 %
Container-Overhead); Messung der Geschwindigkeit auf dem eigenen Gerät.

Alle Prüfschritte stehen ausführlich in [VERIFICATION.md](VERIFICATION.md).
Ein Audit-Paket mit Quelltexten, Hashes und Selbsttest-Protokoll stellen wir
Prüfer:innen auf Anfrage bereit — Kontakt über den Account in der App.

## Architektur in einem Satz / Architecture in one sentence

Die Bitseed-Engine (adaptiver Kontextmischer + arithmetische Kodierung) und
die Momo-Saiten-KI (Wort-Ebene, KV-Cache) teilen dieselbe Saiten-Philosophie:
**Kompression ist Intelligenz, privat ausgeübt** — die Daten lehren das
Modell, das Modell zahlt in Bits zurück, und kein Byte verlässt dafür das Haus.

## Credits & Preise / Credits & pricing

1 Credit = USD 0,009 · Chat 1 Credit/Antwort · Kompression, Speicher,
Analysen, Artifacts, Cloud-Sync 40 Credits/GB · Geplante Einträge &
App Store 1 Credit/Eintrag. Pakete: 1.000/USD 9 · 5.000/USD 39 · 25.000/USD 149.

## Lizenz / License

Engine-Quelltext und Verifikations-Endpunkt sind zur unabhängigen Prüfung
öffentlich einsehbar. Alle Rechte vorbehalten / All rights reserved,
Sebastian Kläy (sebklaey), 2026.
