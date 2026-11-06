#!/bin/bash
# BenzNIC — Glue/IP-Aktualisierung.
#
# Holt die aktuelle oeffentliche IPv4 und schreibt sie in die Zonen-
# Datei (Glue + openos.benz A-Record), bucht die Serial hoch und
# laesst den Dienst die Zone nachladen (MTime-Poll, max. 5 s).
#
# Aufruf:  bash ip-aktualisieren.sh          (prueft + aktualisiert)
#          bash ip-aktualisieren.sh --force   (schreibt immer)
set -e
ZONE="$HOME/openos-ipfs/benz-nic/zone.benz.json"
ALT_IP=$(python3 -c "import json;print(json.load(open('$ZONE'))['glue']['ns1.benz.'][0])" 2>/dev/null || echo "keine")
NEU_IP=$(curl -s --max-time 10 ifconfig.me || echo "")

if [ -z "$NEU_IP" ]; then
  echo "Öffentliche IP konnte nicht ermittelt werden — Zone bleibt wie sie ist ($ALT_IP)."
  exit 1
fi

if [ "$NEU_IP" = "$ALT_IP" ] && ! echo "$*" | grep -q -- "--force"; then
  echo "IP unverändert ($NEU_IP) — nichts zu tun."
  exit 0
fi

python3 - "$ZONE" "$NEU_IP" <<'PY'
import json, sys
zone_pfad, ip = sys.argv[1], sys.argv[2]
zone = json.load(open(zone_pfad))
zone["soa"]["serial"] += 1
for ns in zone.get("glue", {}):
    zone["glue"][ns] = [ip]
rec = zone["records"].get("openos.benz.", {})
rec["a"] = [ip]
zone["records"]["openos.benz."] = rec
json.dump(zone, open(zone_pfad, "w"), indent=2, ensure_ascii=False)
print(f"Zone aktualisiert: serial {zone['soa']['serial']}, A/Glue → {ip}")
PY
echo "BenzNIC laedt die Zone innerhalb von 5 s nach (MTime-Poll)."
