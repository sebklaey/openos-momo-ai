#!/usr/bin/env node
/* BenzNIC — der eigene Domain-Anbieter fuer .benz.
 *
 * Alles, was ein Domain-Provider tut, nur selbst gehostet und ohne
 * einen einzigen Dritten im eigenen Namensraum:
 *
 *   1. AUTORITATIV fuer die Zone "benz." — SOA, NS inkl. Glue,
 *      A, CNAME, TXT (auch _dnslink fuer IPFS). Fremde Namen in
 *      .benz beantwortet er ehrlich mit NXDOMAIN (AA-Bit gesetzt):
 *      DIESE Registry kennt nur, was in ihrer Zonendatei steht.
 *   2. REKURSIV fuer den Rest des Internets — alles, was nicht
 *      auf .benz endet, wird 1:1 an einen konfigurierbaren
 *      Upstream weitergeleitet (Standard: 9.9.9.9). Wer diesen
 *      Resolver als System-DNS eintraegt, surfet ganz normal
 *      weiter — und openos.benz loest auf das eigene Geraet auf.
 *   3. DNS-OVER-HTTPS auf 127.0.0.1:5053 (/dns-query, RFC 8484).
 *
 * Zonendatei: JSON (zone.benz.json), hot-reload via SIGHUP oder
 * wenn sich die Datei aendert (MTime-Poll alle 5 s). Kein npm,
 * keine Abhaengigkeit — bewusst, damit der Dienst auf jedem
 * Node laeuft, der bereits da ist.
 *
 * Aufloesung ist immer nur die halbe Wahrheit: Damit ein fremder
 * Browser .benz ueberhaupt anfragt, muss er DIESEN Resolver
 * einmalig eingetragen haben (oder die BenzResolver-Extension
 * installiert sein). Das ist kein BenzNIC-Defekt, sondern die
 * Architektur des Internets — die Root-Server gehoeren ICANN.
 * Wer seine eigene TLD will, ohne zu fragen, baut sich eben
 * seinen eigenen Eingang. Genau das ist dieser Dienst.
 */
"use strict";
const dgram = require("dgram");
const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const ZONE_DATEI = process.env.BENZ_ZONE || path.join(process.env.HOME, "openos-ipfs/benz-nic/zone.benz.json");
const UDP_PORT = Number(process.env.BENZ_DNS_PORT || 5353);
const DOH_HOST = process.env.BENZ_DOH_HOST || "127.0.0.1";
const DOH_PORT = Number(process.env.BENZ_DOH_PORT || 5053);
const UPSTREAM = (process.env.BENZ_UPSTREAM || "9.9.9.9:53").split(":");
const TTL = 60;

/* ── Zone laden / hot reload ───────────────────────────────── */
let zone = null;
let zoneMtime = 0;
function ladeZone() {
  try {
    const st = fs.statSync(ZONE_DATEI);
    if (zone && st.mtimeMs === zoneMtime) return;
    zone = JSON.parse(fs.readFileSync(ZONE_DATEI, "utf8"));
    zoneMtime = st.mtimeMs;
    console.log("[benznic] Zone geladen: " + zone.origin + " serial " + zone.soa.serial);
  } catch (e) {
    if (!zone) throw e;
    console.log("[benznic] Zone-Nachlade fehlgeschlagen, alte Zone aktiv: " + e.message);
  }
}
ladeZone();
process.on("SIGHUP", () => { zoneMtime = 0; ladeZone(); });
setInterval(() => ladeZone(), 5000).unref();

const inZone = (name) => name === zone.origin || name.endsWith(zone.origin);
const eintraege = (name) => zone.records[name] || null;

/* ── Wire-Format (RFC 1035) — bewusst abhaengigkeitsfrei ───── */
function frageLesen(pkt) {
  if (pkt.length < 12) return null;
  const id = pkt.readUInt16BE(0);
  const flags = pkt.readUInt16BE(2);
  const qd = pkt.readUInt16BE(4);
  if (qd !== 1) return { id, flags, name: null };
  let off = 12;
  const labels = [];
  while (off < pkt.length) {
    const len = pkt[off];
    if (len === 0) { off++; break; }
    if ((len & 0xC0) !== 0) return { id, flags, name: null }; // Compression in Frage: nicht noetig
    labels.push(pkt.slice(off + 1, off + 1 + len).toString("latin1"));
    off += 1 + len;
  }
  if (off + 4 > pkt.length) return { id, flags, name: null };
  return { id, flags, name: labels.join(".").toLowerCase() + ".", qtype: pkt.readUInt16BE(off), qclass: pkt.readUInt16BE(off + 2) };
}

function nameEncodieren(name) {
  const teile = String(name).split(".").filter(Boolean)
    .map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "latin1")]));
  return Buffer.concat([...teile, Buffer.from([0])]);
}

const T = { A: 1, NS: 2, CNAME: 5, SOA: 6, TXT: 16, AAAA: 28, ANY: 255 };

function antwortAbschnitt(type, ttl, rdata) {
  const kopf = Buffer.alloc(12);
  kopf.writeUInt16BE(0xC00C, 0);       // Zeiger auf den Namen in der Frage
  kopf.writeUInt16BE(type, 2);
  kopf.writeUInt16BE(1, 4);            // IN
  kopf.writeUInt32BE(ttl, 6);
  kopf.writeUInt16BE(rdata.length, 10);
  return Buffer.concat([kopf, rdata]);
}

function nameAbschnitt(name, type, ttl, rdata) {
  const kopf = Buffer.alloc(10);
  kopf.writeUInt16BE(type, 0);
  kopf.writeUInt16BE(1, 2);
  kopf.writeUInt32BE(ttl, 4);
  kopf.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([nameEncodieren(name), kopf, rdata]);
}

function rdataA(ip) {
  const b = Buffer.alloc(4);
  ip.split(".").forEach((o, i) => b[i] = Number(o));
  return b;
}
function rdataTXT(txt) {
  const s = Buffer.from(String(txt), "utf8");
  const teile = [];
  for (let i = 0; i < s.length; i += 255) teile.push(Buffer.concat([Buffer.from([Math.min(255, s.length - i)]), s.subarray(i, i + 255)]));
  return Buffer.concat(teile);
}
function rdataSOA() {
  const z = zone.soa;
  const zahlen = Buffer.alloc(20);
  zahlen.writeUInt32BE(z.serial, 0); zahlen.writeUInt32BE(z.refresh, 4);
  zahlen.writeUInt32BE(z.retry, 8); zahlen.writeUInt32BE(z.expire, 12);
  zahlen.writeUInt32BE(z.minimum, 16);
  return Buffer.concat([nameEncodieren(z.mname), nameEncodieren(z.rname), zahlen]);
}

function antwortFuer(name, qtype, zeigerAntworten) {
  /* Baut die Answer-Sections fuer einen (nach CNAME-Aufloesung)
     finalen Namen. zeigerAntworten=true → Name als 0xC00C-Zeiger
     (nur fuer den urspruenglich gefragten Namen korrekt). */
  const e = eintraege(name);
  const ra = [];
  if (!e) return ra;
  const push = (type, rdata) => ra.push(zeigerAntworten ? antwortAbschnitt(type, TTL, rdata) : nameAbschnitt(name, type, TTL, rdata));

  if (qtype === T.A || qtype === T.ANY) (e.a || []).forEach(ip => push(T.A, rdataA(ip)));
  if (qtype === T.TXT || qtype === T.ANY) (e.txt || []).forEach(t => push(T.TXT, rdataTXT(t)));
  if ((qtype === T.CNAME || qtype === T.ANY) && e.cname) push(T.CNAME, nameEncodieren(e.cname));
  return ra;
}

function zoneAntwort(frage) {
  const name = frage.name;
  const qtype = frage.qtype;
  const antworten = [];
  let status = 0; // 0 = OK, 3 = NXDOMAIN

  if (name === zone.origin) {
    if (qtype === T.SOA || qtype === T.ANY) antworten.push(nameAbschnitt(zone.origin, T.SOA, TTL, rdataSOA()));
    if (qtype === T.NS || qtype === T.ANY) zone.ns.forEach(ns => antworten.push(nameAbschnitt(zone.origin, T.NS, TTL, nameEncodieren(ns))));
    if (!antworten.length && qtype !== T.A && qtype !== T.TXT) {
      // Apex hat keine A/TXT-Eintraege → NXDOMAIN-Info weglassen, leere Antwort
    }
  }

  const e = eintraege(name);
  if (!e && !antworten.length) {
    // Ehrliche Registry: unbekannt = unbekannt.
    return { pkt: bauPaket(frage, [], [], true), nx: true };
  }

  if (e && e.cname && (qtype === T.A || qtype === T.AAAA || qtype === T.TXT)) {
    antworten.push(nameAbschnitt(name, T.CNAME, TTL, nameEncodieren(e.cname)));
    antworten.push(...antwortFuer(e.cname, qtype, false));
  } else {
    antworten.push(...antwortFuer(name, qtype, true));
  }

  return { pkt: bauPaket(frage, antworten, glueAbschnitt()), nx: false };
}

function glueAbschnitt() {
  /* Glue-A-Records fuer NS-Namen, die in dieser Zone liegen. */
  const extra = [];
  for (const ns of zone.ns) {
    const ips = (zone.glue || {})[ns];
    if (ips) ips.forEach(ip => extra.push(nameAbschnitt(ns, T.A, TTL, rdataA(ip))));
  }
  return extra;
}

function bauPaket(frage, antworten, zusaetzlich, nxdomain) {
  const kopf = Buffer.alloc(12);
  kopf.writeUInt16BE(frage.id, 0);
  kopf.writeUInt16BE(0x8580 | (nxdomain ? 0x3 : 0), 2); // QR+AA+RD+RA (+NXDOMAIN)
  kopf.writeUInt16BE(1, 4);
  kopf.writeUInt16BE(antworten.length, 6);
  kopf.writeUInt16BE(0, 8);                       // NSCOUNT (SOA-Authority weglassen, simpel)
  kopf.writeUInt16BE((zusaetzlich || []).length, 10);
  const frageteil = Buffer.concat([nameEncodieren(frage.name), Buffer.from([frage.qtype >> 8, frage.qtype & 255, 0, 1])]);
  return Buffer.concat([kopf, frageteil, ...antworten, ...(zusaetzlich || [])]);
}

/* ── Dispatcher: .benz selbst beantworten, Rest weiterleiten ─ */
function beantworten(pkt) {
  const frage = frageLesen(pkt);
  if (!frage || !frage.name) return null;
  if (inZone(frage.name)) return zoneAntwort(frage).pkt;
  return null; // → Forwarding
}

/* ── UDP: Zone + Forwarding ────────────────────────────────── */
const udp = dgram.createSocket("udp4");
udp.on("message", (msg, rinfo) => {
  const eigen = beantworten(msg);
  if (eigen) { udp.send(eigen, rinfo.port, rinfo.address, () => {}); return; }
  const ziel = dgram.createSocket("udp4");
  const timer = setTimeout(() => { try { ziel.close(); } catch {} }, 6000);
  ziel.on("message", (antwort) => {
    clearTimeout(timer);
    udp.send(antwort, rinfo.port, rinfo.address, () => {});
    try { ziel.close(); } catch {}
  });
  ziel.on("error", () => { clearTimeout(timer); try { ziel.close(); } catch {} });
  ziel.send(msg, Number(UPSTREAM[1] || 53), UPSTREAM[0], () => {});
});
udp.bind(UDP_PORT, "0.0.0.0", () => console.log("[benznic] UDP-Resolver auf Port " + UDP_PORT + " (Zone .benz autoritativ, Rest → " + UPSTREAM.join(":") + ")"));

/* ── TCP (Length-Prefixed, RFC 1035 4.2.2) ─────────────────── */
const tcp = net.createServer((sock) => {
  let puffer = Buffer.alloc(0);
  sock.on("data", (daten) => {
    puffer = Buffer.concat([puffer, daten]);
    while (puffer.length >= 2) {
      const laenge = puffer.readUInt16BE(0);
      if (puffer.length < 2 + laenge) return;
      const pkt = puffer.subarray(2, 2 + laenge);
      puffer = puffer.subarray(2 + laenge);
      const eigen = beantworten(pkt);
      if (eigen) { sock.write(Buffer.concat([Buffer.from([eigen.length >> 8, eigen.length & 255]), eigen])); continue; }
      const ziel = net.connect(Number(UPSTREAM[1] || 53), UPSTREAM[0], () => {
        ziel.write(Buffer.concat([Buffer.from([pkt.length >> 8, pkt.length & 255]), pkt]));
      });
      const zPuffer = { rest: Buffer.alloc(0) };
      ziel.on("data", (d) => {
        zPuffer.rest = Buffer.concat([zPuffer.rest, d]);
        while (zPuffer.rest.length >= 2) {
          const l = zPuffer.rest.readUInt16BE(0);
          if (zPuffer.rest.length < 2 + l) return;
          const a = zPuffer.rest.subarray(0, 2 + l);
          zPuffer.rest = zPuffer.rest.subarray(2 + l);
          sock.write(a);
        }
      });
      ziel.on("error", () => {});
    }
  });
  sock.on("error", () => {});
});
tcp.listen(UDP_PORT, "0.0.0.0", () => console.log("[benznic] TCP-Resolver auf Port " + UDP_PORT));

/* ── DNS-over-HTTPS (RFC 8484: GET ?dns= + POST) ───────────── */
http.createServer((req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/dns-query") { res.writeHead(404); return res.end(); }
    let pkt = null;
    if (req.method === "GET") {
      const b64 = url.searchParams.get("dns");
      if (!b64) { res.writeHead(400); return res.end(); }
      pkt = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    } else if (req.method === "POST") {
      const teile = [];
      req.on("data", (t) => teile.push(t));
      req.on("end", () => {
        pkt = Buffer.concat(teile);
        fertig(pkt, res);
      });
      return;
    } else { res.writeHead(405); return res.end(); }
    fertig(pkt, res);
  } catch { res.writeHead(400); res.end(); }
  function fertig(pkt, res) {
    const eigen = beantworten(pkt);
    if (eigen) {
      res.writeHead(200, { "content-type": "application/dns-message", "cache-control": "max-age=" + TTL });
      return res.end(eigen);
    }
    // Nicht .benz → Upstream per UDP, dann als DoH-Antwort zurueck
    const ziel = dgram.createSocket("udp4");
    const timer = setTimeout(() => { res.writeHead(504); res.end(); try { ziel.close(); } catch {} }, 6000);
    ziel.on("message", (antwort) => {
      clearTimeout(timer);
      res.writeHead(200, { "content-type": "application/dns-message", "cache-control": "max-age=" + TTL });
      res.end(antwort);
      try { ziel.close(); } catch {}
    });
    ziel.on("error", () => { clearTimeout(timer); res.writeHead(502); res.end(); });
    ziel.send(pkt, Number(UPSTREAM[1] || 53), UPSTREAM[0], () => {});
  }
}).listen(DOH_PORT, DOH_HOST, () => console.log("[benznic] DoH auf http://" + DOH_HOST + ":" + DOH_PORT + "/dns-query"));

console.log("[benznic] Bereit. Zone: " + ZONE_DATEI);
