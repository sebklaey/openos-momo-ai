# BenzResolver — die eigene, niemandem gehörende Domain-Auflösung für `.benz`

BenzResolver ist die Browser-Erweiterung, die **`https://openos.benz`** in
jedem Browser öffnet — ohne ICANN, ohne Registrar, ohne Cloudflare, ohne
einen einzigen Dritten, der die Domain hätte oder abschalten könnte.

## Warum das nötig ist

`.benz` ist keine ICANN-TLD und gehört niemandem — darauf basiert ihre
Unabnehmbarkeit. Browser lösen aber nur auf, was (a) im öffentlichen
ICANN-DNS steht, (b) in einer Hersteller-Web3-Liste gelistet ist oder (c)
von einer Erweiterung aufgelöst wird. Weil niemand `.benz` verkaufen oder
verpachten kann, bleibt (c): **unsere eigene Auflösung, quelloffen, mit
einem Signierschlüssel, den nur Sebastian Kläy besitzt.**

## Wie es funktioniert

1. Du tippst `https://openos.benz/…` in die Adressleiste.
2. Die Erweiterung fängt die Anfrage ab (deklarativeNetRequest) und liest
   die **signierte Registry** (`benz-registry.json`, im Repository und auf
   jedem Spiegel).
3. Die Signatur wird gegen den eingebetteten Ed25519-Public-Key geprüft
   (`ZPS4pqVS2dan2AvuJICqhN4iESGpFKBraEoHou01Wd8`).
   Ungültige Registries werden verworfen — niemand kann Einträge ändern.
4. Der Browser wird auf den IPFS-Gateway-Pfad weitergeleitet:
   `https://openos.benz/ipfs/<CID>/…` — ausgeliefert vom eigenen Knoten.

Einträge ändern nur mit dem privaten Registry-Schlüssel
(`tools/benz-registry-sign.mjs`, geheim, niemals im Repository).

## Installation

### Chrome / Brave / Edge / Chromium

1. Repository klonen oder diesen Ordner (`benz-resolver/`) herunterladen.
2. Browser öffnen: `chrome://extensions` (Brave: `brave://extensions`).
3. Oben rechts **Entwicklermodus** aktivieren.
4. **„Entpackte Erweiterung laden"** → den Ordner `benz-resolver/` wählen.
5. Fertig. `https://openos.benz` öffnen — die App lädt.

Erweiterungs-Icon anklicken zeigt den Registry-Status („Registry gültig ·
openos.benz → CID …"). In den Optionen lässt sich der Gateway-Host und der
Registry-URL ändern (Standard: `https://openos.benz`).

### Firefox

1. `about:debugging` öffnen → **Dieser Firefox** → **Temporäres Add-on laden**.
2. `benz-resolver/manifest.json` wählen. Für dauerhafte Installation:
   `about:config` → `xpinstall.signatures.required` auf den eigenen
   Verpackungsprozess ausweiten oder über `web-ext build` signieren.

## Verifikation

- Registry-Signatur: `node tools/benz-registry-sign.mjs --show`
  (zeigt Public Key, Einträge und ob die Signatur gültig ist).
- Public-Key-Fingerprint steht in `background.js` und oben.
- Der komplette IPFS-Stand ist byte-identisch auf den öffentlichen
  Spiegeln — die App hängt nicht von dieser Erweiterung ab; sie macht
  nur `openos.benz` zum erreichbaren Namen dafür.

## Sicherheitsmodell

- Registry ist **Ed25519-signiert**; der Private Key liegt nirgends im
  Repository. Ein Angreifer mit Schreibzugriff auf den Spiegel kann
  Einträge nicht unbemerkt ändern — die Signaturprüfung schlägt fehl und
  die Erweiterung lehnt die Registry ab.
- Die Weiterleitung geht ausschliesslich an den in der Registry stehenden
  CID — der ist durch IPFS-Inhaltsadressierung selbst geprüft.
- Kein Telemetrie, kein Netzaufruf ausser Registry-Lesen und der
  Weiterleitung selbst.

---

Privacy by Architecture — May the Force be Dezentralised. 🐇
