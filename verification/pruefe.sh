#!/bin/sh
# OpenOS Momo AI — Bundle-Selbstprüfung in einem Lauf.
# Reihenfolge: Integritaet -> Signatur -> Modellnachweis (live).
set -e
cd "$(dirname "$0")"

echo "== 1/3 Bundle-Integritaet (sha256sum -c)"
sha256sum -c CHECKSUMS.txt

echo "== 2/3 Signatur (Ed25519, Base64 in CHECKSUMS.sig)"
node -e '
  const crypto=require("crypto"),fs=require("fs");
  const sig=Buffer.from(fs.readFileSync("CHECKSUMS.sig","utf8").trim(),"base64");
  const ok=crypto.verify(null,fs.readFileSync("CHECKSUMS.txt"),
    crypto.createPublicKey(fs.readFileSync("RELEASE.pub")),sig);
  console.log("Signatur:",ok?"GUELTIG":"UNGUELTIG");
  process.exit(ok?0:1);'
#openssl pkeyutl -verify -pubin -inkey RELEASE.pub -rawin -in CHECKSUMS.txt -sigfile <(base64 -d CHECKSUMS.sig)  # OpenSSL 3.x

echo "== 3/3 Modellnachweis (live, laedt Gewichte von app.openos.space)"
node modell-selftest.mjs

echo "ALLE PRUEFUNGEN BESTANDEN."
