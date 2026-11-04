/*! Bitseed Engine v2 — lokaler Kontext-Misch-Codec (Browser-Build).
 * Architektur: adaptive Ordnungs-Modelle (0/1/2/3/4/6) + LZP-Match,
 * logistischer Mischer (stretch/squash), APM-Korrekturstufe,
 * binaerer Arithmetik-Kodierer. Verlustfrei, bit-exakt.
 * Laeuft komplett im Worker — nichts verlaesst das Geraet.
 *
 * Neu in v2 (unabhaengiger Audit 2026-11-04):
 *   - logistisches Mischen statt Wahrscheinlichkeits-Linearkombination
 *   - 12-Bit-Zaehler mit Hash-Tags gegen Kollisionen
 *   - Match-Konfidenz adaptiv bis 99,7 % (war fest 95 %)
 *   - APM-Nachkorrektur der gemischten Wahrscheinlichkeit
 *   - Header von 524 auf ~50 Byte; alte BTS1-Archive bleiben lesbar
 *
 * Protokoll (kompatibel zum Workspace):
 *   init:   {cmd:"init"}                        -> {type:"ready"}
 *   encode: {cmd:"encode", data:ArrayBuffer}    -> {type:"progress",frac} ... {type:"encoded", hyb}
 *   decode: {cmd:"decode", hyb:ArrayBuffer}     -> {type:"progress",frac} ... {type:"decoded", data}
 */
(function (global) {
  "use strict";

  /* ---------------- Arithmetik-Kodierer (E1/E2/E3, bitweise, carry-sicher) ---------------- */
  const HALF = 0x80000000, QUARTER = 0x40000000, THREE_QUARTER = 0xc0000000;

  function createBitWriter(out) {
    let acc = 0, nbits = 0;
    return {
      write(b) {
        acc = (acc << 1) | (b & 1);
        if (++nbits === 8) { out.push(acc); acc = 0; nbits = 0; }
      },
      flush() {
        if (nbits > 0) { acc <<= 8 - nbits; out.push(acc); acc = 0; nbits = 0; }
      },
    };
  }

  function createBitReader(buf) {
    let pos = 0;
    return {
      read() {
        const i = pos >> 3;
        const byte = i < buf.length ? buf[i] : 0;   // am Ende: Nullen
        const bit = (byte >> (7 - (pos & 7))) & 1;
        pos++;
        return bit;
      },
    };
  }

  function createEncoder(writer) {
    let low = 0, high = 0xffffffff, pending = 0;
    function emit(b) {
      writer.write(b);
      while (pending > 0) { writer.write(1 - b); pending--; }
    }
    function renorm() {
      for (;;) {
        if (high < HALF) { emit(0); }
        else if (low >= HALF) { emit(1); low -= HALF; high -= HALF; }
        else if (low >= QUARTER && high < THREE_QUARTER) { pending++; low -= QUARTER; high -= QUARTER; }
        else break;
        low = (low * 2) >>> 0;
        high = ((high * 2) + 1) >>> 0;
      }
    }
    return {
      encode(p, bit) {          // p = P(1), Skala 0..65536; bit=1 -> unteres Intervall
        const range = high - low + 1;               // 1..2^32 (Float, exakt)
        const split = Math.floor((range * p) / 0x10000);
        if (bit) high = low + split - 1;
        else low = low + split;
        renorm();
      },
      flush() {
        pending++;
        if (low < QUARTER) emit(0); else emit(1);
        writer.flush();
      },
    };
  }

  function createDecoder(buf) {
    let low = 0, high = 0xffffffff, code = 0;
    const reader = createBitReader(buf);
    for (let i = 0; i < 32; i++) code = (code * 2 + reader.read()) >>> 0;
    function renorm() {
      for (;;) {
        if (high < HALF) { /* beide MSB 0 */ }
        else if (low >= HALF) { low -= HALF; high -= HALF; code -= HALF; }
        else if (low >= QUARTER && high < THREE_QUARTER) { low -= QUARTER; high -= QUARTER; code -= QUARTER; }
        else break;
        low = (low * 2) >>> 0;
        high = ((high * 2) + 1) >>> 0;
        code = ((code * 2) + reader.read()) >>> 0;
      }
    }
    return {
      decode(p) {               // p = P(1), Skala 0..65536 -> Bit
        const range = high - low + 1;
        const split = Math.floor((range * p) / 0x10000);
        let bit;
        if (code < low + split) { high = low + split - 1; bit = 1; }
        else { low = low + split; bit = 0; }
        renorm();
        return bit;
      },
    };
  }

  /* ---------------- Modell (v2) ---------------- */
  const NMOD = 7; // o0 o1 o2 o3 o4 o6 match

  /* stretch: P(1) -> logit, Skala 256 (int16, ~±2840) */
  const ST = new Int16Array(65536);
  for (let p = 1; p < 65536; p++) {
    const v = Math.round(256 * Math.log(p / (65536 - p)));
    ST[p] = v < -32767 ? -32767 : (v > 32767 ? 32767 : v);
  }
  ST[0] = -32767;

  /* squash: Summe der gewichteten Logits -> P(1), 6144 Eintraege (~±3072) */
  const SQ_N = 6144, SQ_BIAS = 3072;
  const SQ = new Uint16Array(SQ_N);
  for (let t = 0; t < SQ_N; t++) {
    const x = t - SQ_BIAS;
    const v = Math.round(65536 / (1 + Math.exp(-x / 256)));
    SQ[t] = v < 1 ? 1 : (v > 65535 ? 65535 : v);
  }
  function squash(s) {
    if (s <= -SQ_BIAS) return 1;
    if (s >= SQ_BIAS - 1) return 65535;
    return SQ[s + SQ_BIAS];
  }

  /* Zaehler: 32-Bit gepackt n0:12 | n1:12 | tag:8.  Halbierung bei 2048/2048 —
     langsame Adaption, stabile Endwerte.  Tag = 8 Kontext-Bits gegen
     Hash-Kollisionen: passt der Tag nicht, gilt der Eintrag als unbenutzt. */
  function counterP(e) {
    const n0 = e & 4095, n1 = (e >>> 12) & 4095;
    let p = Math.round(65536 * (n1 + 0.5) / (n0 + n1 + 1));
    if (p < 1) p = 1; else if (p > 65535) p = 65535;
    return p;
  }
  function counterUp(e, bit, tag) {
    if (((e >>> 24) & 255) !== tag) e = tag << 24;
    let n0 = e & 4095, n1 = (e >>> 12) & 4095;
    if (bit) n1++; else n0++;
    if (n0 >= 2048 && n1 >= 2048) { n0 >>= 1; n1 >>= 1; }
    return (n0 & 4095) | ((n1 & 4095) << 12) | (tag << 24);
  }

  /* Tabellen groesser als v1 (weniger Kollisionen): T2/T3 256K, T4/T6 512K. */
  const B1 = 16, B2 = 18, B3 = 18, B4 = 19, B6 = 19;
  const M1 = (1 << B1) - 1, M2 = (1 << B2) - 1, M3 = (1 << B3) - 1, M4 = (1 << B4) - 1, M6 = (1 << B6) - 1;

  /* APM: Nachkorrektur der gemischten Wahrscheinlichkeit, Kontext =
     voriges Byte x 32 Quantisierungsstufen.  Schnell adaptierend. */
  const APM_BINS = 32;
  function counterP16(v) {
    const n0 = v & 255, n1 = (v >> 8) & 255;
    let p = Math.round(65536 * (n1 + 0.5) / (n0 + n1 + 1));
    if (p < 1) p = 1; else if (p > 65535) p = 65535;
    return p;
  }
  function counterUp16(v, bit) {
    let n0 = v & 255, n1 = (v >> 8) & 255;
    if (bit) { if (n1 < 255) n1++; } else { if (n0 < 255) n0++; }
    if (n0 >= 128 && n1 >= 128) { n0 >>= 1; n1 >>= 1; }
    return n0 | (n1 << 8);
  }

  function createModel() {
    return {
      T1: new Uint32Array(1 << B1),
      T2: new Uint32Array(1 << B2),
      T3: new Uint32Array(1 << B3),
      T4: new Uint32Array(1 << B4),
      T6: new Uint32Array(1 << B6),
      APM: new Uint16Array(256 * APM_BINS),
      MTAB: new Int32Array(1 << 17).fill(-1),
      w: new Float64Array(NMOD).fill(1 / NMOD),
      c1: 0, c2: 0, c3: 0, c4: 0, c6: 0,
      n0c: 0, n1c: 0,
      mActive: false, mSrc: 0, mOff: 0, mByte: 0,
    };
  }

  /* Ein Bit vorhersagen/mischen.  Rueckgabe: final korrigierte P(1).
     Liefert gleichzeitig das Bit-Update fuer Zaehler/ Gewichte — deshalb
     bekommt sie das ggf. dekodierte/echte Bit im Anschluss via bitOut. */
  function predictBit(m, prefix) {
    const marker = (prefix << 1) | 1;
    const f2 = (m.c2 ^ (marker * 0x9e37)) >>> 0;
    const f3 = (m.c3 + marker * 257) >>> 0;
    const f4 = (m.c4 ^ (marker * 0x85eb)) >>> 0;
    const f6 = (m.c6 + marker * 131) >>> 0;
    const i1 = (m.c1 + marker) & M1;
    const i2 = f2 & M2, i3 = f3 & M3, i4 = f4 & M4, i6 = f6 & M6;
    m.i1 = i1; m.i2 = i2; m.i3 = i3; m.i4 = i4; m.i6 = i6;
    m.t1 = (f2 >>> B2) & 255; m.t3 = (f3 >>> B3) & 255;
    m.t4 = (f4 >>> B4) & 255; m.t6 = (f6 >>> B6) & 255;

    let p0 = counterP16(m.n0c | (m.n1c << 8));
    m.ps0 = p0;
    m.p1 = counterP(m.T1[i1]);
    m.p2 = counterP(m.T2[i2]);
    m.p3 = counterP(m.T3[i3]);
    m.p4 = counterP(m.T4[i4]);
    m.p6 = counterP(m.T6[i6]);
    /* Adaptive Match-Konfidenz: lange Matches (grosses mOff) bekommen
       hoehere Sicherheit — beidseitig deterministisch vom Match-Abstand. */
    m.matchConf = Math.min(65472, 61000 + Math.min(m.mOff, 300) * 15);
    m.pm = (m.mActive && (((m.mByte >> m.mBitPos) & 1) ? m.matchConf : 65535 - m.matchConf)) || 32768;

    const w = m.w;
    const s = w[0] * ST[p0] + w[1] * ST[m.p1] + w[2] * ST[m.p2] +
              w[3] * ST[m.p3] + w[4] * ST[m.p4] + w[5] * ST[m.p6] + w[6] * ST[m.pm];
    let mixed = squash(Math.round(s));
    m.mixed = mixed;

    /* APM-Nachkorrektur: voriges Byte + Quantisierte Mischung. */
    const bin = mixed >> 11;
    const ai = (m.prevByte * APM_BINS + bin) & 8191;
    m.ai = ai;
    const p2 = counterP16(m.APM[ai]);
    const fin = (mixed + p2) >> 1;
    m.pFinal = fin < 1 ? 1 : (fin > 65535 ? 65535 : fin);
    return m.pFinal;
  }

  function updateBit(m, bit, rate) {
    if (rate === undefined) rate = 0.1;
    /* Gewichte im Logit-Raum (PAQ-Stil): Fehler gegen die GEMISCHTE
       Wahrscheinlichkeit, mal der gestretchten Modellantwort.  Danach
       NORMALISIEREN (Summe = 1): nur so bleibt |S| <= max|ST| ~ 2840,
       der squash nie im Clip — und err geht gegen 0, sobald der Mischer
       richtig liegt.  Ohne Norm kippt ein Modell die Summe ins Saturieren
       und der Fehler bricht auf volle Amplitude auf. */
    const err = (bit ? 65536 : 0) - m.mixed;
    const w = m.w;
    let sw = 0;
    for (let k = 0; k < NMOD; k++) {
      const st = k === 0 ? ST[m.ps0] : k === 1 ? ST[m.p1] : k === 2 ? ST[m.p2]
        : k === 3 ? ST[m.p3] : k === 4 ? ST[m.p4] : k === 5 ? ST[m.p6] : ST[m.pm];
      let nw = w[k] + rate * (err / 65536) * (st / 2840);
      if (nw < 0.0005) nw = 0.0005;
      w[k] = nw;
      sw += nw;
    }
    if (sw > 0) for (let k = 0; k < NMOD; k++) w[k] /= sw;

    /* lokaler Ordnung-0-Zaehler (schnell) */
    if (bit) { if (m.n1c < 255) m.n1c++; } else { if (m.n0c < 255) m.n0c++; }
    if (m.n0c >= 128 && m.n1c >= 128) { m.n0c >>= 1; m.n1c >>= 1; }

    m.T1[m.i1] = counterUp(m.T1[m.i1], bit, 0);
    m.T2[m.i2] = counterUp(m.T2[m.i2], bit, m.t1);
    m.T3[m.i3] = counterUp(m.T3[m.i3], bit, m.t3);
    m.T4[m.i4] = counterUp(m.T4[m.i4], bit, m.t4);
    m.T6[m.i6] = counterUp(m.T6[m.i6], bit, m.t6);
    m.APM[m.ai] = counterUp16(m.APM[m.ai], bit);
  }

  /* Kernschleife. data: Uint8Array (Encoder: Eingabe, Decoder: wird gefuellt).
     out: Encoder: number[], Decoder: Uint8Array (Stream). */
  function run(data, decodeMode, out, onProgress) {
    const n = data.length;
    const m = createModel();
    m.prevByte = 0;
    const rcEnc = decodeMode ? null : createEncoder(createBitWriter(out));
    const rcDec = decodeMode ? createDecoder(out) : null;

    for (let pos = 0; pos < n; pos++) {
      /* LZP-Hash: NUR ein Fenster der letzten 4 Bytes — positionsunabhaengig.
         So bekommt gleicher Inhalt an anderer Stelle denselben Slot (Match!),
         unabhaengig von der weit zurueckliegenden Historie.  Kollisionen
         faengt die 4-Byte-Verifizierung beim Aktivieren ab. */
      let hm = -1;
      if (pos >= 4) {
        const h = (data[pos - 1] * 0x1e35a5bd ^ data[pos - 2] * 0x9e3779b1 ^
                   data[pos - 3] * 0x85ebca6b ^ data[pos - 4] * 0xc2b2ae35) >>> 0;
        hm = (h ^ (h >>> 15)) & 0x1ffff;
      }
      if (!m.mActive && hm >= 0) {
        const cand = m.MTAB[hm];
        /* Verifizierte Aktivierung (LZP-Standard): vor dem Aktivieren pruefen,
           ob die 4 Bytes VOR der Kandidatenposition mit den 4 Bytes vor pos
           uebereinstimmen.  Nur Bytes < pos — der Decoder kennt dieselben
           Bytes, also beidseitig identisch.  Falsch-Positive fallen auf ~2^-32. */
        if (cand >= 4 && pos >= 4 &&
            data[cand - 4] === data[pos - 4] && data[cand - 3] === data[pos - 3] &&
            data[cand - 2] === data[pos - 2] && data[cand - 1] === data[pos - 1]) {
          m.mActive = true; m.mSrc = cand; m.mOff = 0;
        }
      }
      if (m.mActive) {
        if (m.mSrc + m.mOff >= pos) m.mActive = false; // kein Blick auf unbekannte Bytes
        else m.mByte = data[m.mSrc + m.mOff];
      }

      let prefix = 0; // Bits des aktuellen Bytes, bereits verarbeitet
      let byteVal = 0;

      for (let i = 7; i >= 0; i--) {
        m.mBitPos = i;
        const pInt = predictBit(m, prefix);
        let bit;
        if (decodeMode) {
          bit = rcDec.decode(pInt);
          byteVal = (byteVal << 1) | bit;
        } else {
          bit = (data[pos] >> i) & 1;
          rcEnc.encode(pInt, bit);
        }
        updateBit(m, bit);
        prefix = ((prefix << 1) | bit) & 255;
      }

      const byteOut = decodeMode ? byteVal : data[pos];
      if (decodeMode) data[pos] = byteOut;
      m.prevByte = byteOut;

      // Match pruefen/fortschreiben
      if (m.mActive) {
        if (byteOut !== m.mByte) m.mActive = false;
        else m.mOff++;
      }
      if (hm >= 0) m.MTAB[hm] = pos;

      // Kontexte rollen
      m.c1 = byteOut;
      m.c2 = ((m.c2 * 257) ^ byteOut) & 0x1ffff;
      m.c3 = ((m.c3 * 131) ^ (byteOut * 7)) & 0x1ffff;
      m.c4 = ((m.c4 * 65) ^ (byteOut * 3)) & 0x3ffff;
      m.c6 = ((m.c6 * 33) ^ (byteOut * 5)) & 0x3ffff;

      if (onProgress && (pos & 0xffff) === 0) onProgress(pos / n);
    }
    if (rcEnc) rcEnc.flush();
    if (onProgress) onProgress(1);
  }

  /* ---------------- Container ---------------- */
  /* BTS3: 12 Byte (Magic + 64-Bit-Laenge), kein Konfig-Block — der Overhead
     frisst sonst kleine Dateien.  BTS2 (14+cfg) und BTS1 (512) bleiben lesbar. */
  const MAGIC_V1 = 0x31535442; // "BTS1"
  const MAGIC_V2 = 0x32535442; // "BTS2"
  const MAGIC = 0x33535442;    // "BTS3"

  function encode(data, onProgress) {
    const stream = [];
    run(data, false, stream, onProgress);
    const hyb = new Uint8Array(12 + stream.length);
    const dv = new DataView(hyb.buffer);
    dv.setUint32(0, MAGIC, true);
    dv.setUint32(4, data.length >>> 0, true);
    dv.setUint32(8, Math.floor(data.length / 0x100000000), true);
    hyb.set(stream, 12);
    return hyb;
  }

  function decode(hyb, onProgress) {
    const dv = new DataView(hyb.buffer, hyb.byteOffset);
    const magic = dv.getUint32(0, true);
    if (magic !== MAGIC && magic !== MAGIC_V2 && magic !== MAGIC_V1) throw new Error("Kein Bitseed-Archiv (Magic mismatch).");
    const n = dv.getUint32(4, true) + dv.getUint32(8, true) * 0x100000000;
    const stream = magic === MAGIC ? hyb.subarray(12)
      : magic === MAGIC_V2 ? hyb.subarray(14 + dv.getUint16(12, true))
      : hyb.subarray(12 + 512);
    const data = new Uint8Array(n);
    run(data, true, stream, onProgress);
    return data;
  }

  function headerSize(hyb) {
    const dv = new DataView(hyb.buffer, hyb.byteOffset);
    const magic = dv.getUint32(0, true);
    if (magic === MAGIC) return 12;
    if (magic === MAGIC_V2) return 14 + dv.getUint16(12, true);
    if (magic === MAGIC_V1) return 12 + 512;
    return 0;
  }

  /* ---------------- Generierung (Kompressions-AI) ----------------
   * Dasselbe Modell wie der Codec, aber ohne Arithmetik-Kodierer: Zuerst
   * lernt es den Prompt, dann wird Byte fuer Byte die wahrscheinlichste
   * Fortsetzung gesampelt und als Kontext zurueckgefuehrt.  Ein lokales
   * adaptives Modell — kein vortrainiertes Asset noetig.  Ehrlich gesagt:
   * das ist Kontextlernen auf Byte-Ebene, mehr nicht. */
  function generate(prompt, { maxBytes = 320, temperature = 0.85, seed = 1, stopMarks = null, minBytes = 2 } = {}) {
    const enc = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
    const bytes = enc ? enc.encode(String(prompt)) : Uint8Array.from(String(prompt), (c) => c.charCodeAt(0) & 255);
    const n = bytes.length;

    let rngState = (seed >>> 0) || 1;
    const rnd = () => {
      rngState ^= rngState << 13; rngState >>>= 0;
      rngState ^= rngState >> 17;
      rngState ^= rngState << 5; rngState >>>= 0;
      return rngState / 4294967296;
    };

    const m = createModel();
    m.prevByte = 0;

    const feedBit = (bit, prefix, i, learnRate) => {
      m.mBitPos = i;
      const pInt = predictBit(m, prefix);
      if (bit === null) {
        let p = pInt / 65536;
        if (temperature !== 1) {
          const eps = 1 / 65536;
          p = Math.min(1 - eps, Math.max(eps, p));
          const logit = Math.log(p / (1 - p)) / Math.max(0.05, temperature);
          p = 1 / (1 + Math.exp(-logit));
        }
        const pSamp = Math.min(65535, Math.max(1, Math.round(p * 65536)));
        bit = rnd() * 65536 < pSamp ? 1 : 0;
      }
      updateBit(m, bit, learnRate);
      return bit;
    };

    const feedByte = (byteVal, pos, learnRate) => {
      /* Derselbe positionsunabhaengige 4-Byte-Fenster-Hash wie im Codec. */
      let hm = -1;
      if (pos >= 4) {
        const h = (bytes[pos - 1] * 0x1e35a5bd ^ bytes[pos - 2] * 0x9e3779b1 ^
                   bytes[pos - 3] * 0x85ebca6b ^ bytes[pos - 4] * 0xc2b2ae35) >>> 0;
        hm = (h ^ (h >>> 15)) & 0x1ffff;
      }
      if (!m.mActive && hm >= 0) {
        const cand = m.MTAB[hm];
        /* Verifizierte Aktivierung (LZP-Standard): vor dem Aktivieren pruefen,
           ob die 4 Bytes VOR der Kandidatenposition mit den 4 Bytes vor pos
           uebereinstimmen.  Nur Bytes < pos — der Decoder kennt dieselben
           Bytes, also beidseitig identisch.  Falsch-Positive fallen auf ~2^-32. */
        if (cand >= 4 && pos >= 4 &&
            bytes[cand - 4] === bytes[pos - 4] && bytes[cand - 3] === bytes[pos - 3] &&
            bytes[cand - 2] === bytes[pos - 2] && bytes[cand - 1] === bytes[pos - 1]) {
          m.mActive = true; m.mSrc = cand; m.mOff = 0;
        }
      }
      if (m.mActive) {
        if (m.mSrc + m.mOff >= pos) m.mActive = false; // kein Blick auf unbekannte Bytes
        else m.mByte = bytes[m.mSrc + m.mOff];
      }
      let prefix = 0;
      for (let i = 7; i >= 0; i--) {
        const bit = (byteVal >> i) & 1;
        feedBit(bit, prefix, i, learnRate);
        prefix = ((prefix << 1) | bit) & 255;
      }
      if (m.mActive) {
        if (byteVal !== m.mByte) m.mActive = false;
        else m.mOff++;
      }
      if (hm >= 0) m.MTAB[hm] = pos;
      m.prevByte = byteVal;
      m.c1 = byteVal;
      m.c2 = ((m.c2 * 257) ^ byteVal) & 0x1ffff;
      m.c3 = ((m.c3 * 131) ^ (byteVal * 7)) & 0x1ffff;
      m.c4 = ((m.c4 * 65) ^ (byteVal * 3)) & 0x3ffff;
      m.c6 = ((m.c6 * 33) ^ (byteVal * 5)) & 0x3ffff;
    };

    // Phase 1: Prompt lernen
    for (let pos = 0; pos < n; pos++) feedByte(bytes[pos], pos, 0.004);

    // Phase 2: Fortsetzung sampeln (Match-Modell aus — es kennt nur den Prompt)
    const out = [];
    const stops = Array.isArray(stopMarks) && stopMarks.length ? stopMarks : ["\n\n", "\nNutzer:", "\nDu:", "\nUser:", "\nHuman:"];
    for (let g = 0; g < maxBytes; g++) {
      let prefix = 0, byteVal = 0;
      for (let i = 7; i >= 0; i--) {
        const bit = feedBit(null, prefix, i, 0);
        byteVal = (byteVal << 1) | bit;
        prefix = ((prefix << 1) | bit) & 255;
      }
      if (byteVal === 0) break;
      out.push(byteVal);
      m.prevByte = byteVal;
      m.c1 = byteVal;
      m.c2 = ((m.c2 * 257) ^ byteVal) & 0x1ffff;
      m.c3 = ((m.c3 * 131) ^ (byteVal * 7)) & 0x1ffff;
      m.c4 = ((m.c4 * 65) ^ (byteVal * 3)) & 0x3ffff;
      m.c6 = ((m.c6 * 33) ^ (byteVal * 5)) & 0x3ffff;
      if (out.length >= minBytes) {
        const tail = String.fromCharCode(...out.slice(-24));
        if (stops.some((s) => tail.includes(s))) break;
      }
    }
    const dec = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: false }) : null;
    const text = dec ? dec.decode(Uint8Array.from(out)) : String.fromCharCode(...out);
    return { text, bytes: out.length };
  }

  /** Bits pro Byte — wie gut das Modell einen Text vorhersagt. */
  function entropyBits(data) {
    const hyb = encode(data);
    const hs = headerSize(hyb);
    return data.length ? (hyb.length - hs) * 8 / data.length : 0;
  }

  /* ---------------- Worker-Anbindung ---------------- */
  function handle(msg, post) {
    if (msg.cmd === "init") { post({ type: "ready" }); return; }
    if (msg.cmd === "encode") {
      const data = new Uint8Array(msg.data);
      const hyb = encode(data, (frac) => post({ type: "progress", frac }));
      post({ type: "encoded", hyb: hyb.buffer }, [hyb.buffer]);
      return;
    }
    if (msg.cmd === "decode") {
      const hyb = new Uint8Array(msg.hyb);
      const data = decode(hyb, (frac) => post({ type: "progress", frac }));
      post({ type: "decoded", data: data.buffer }, [data.buffer]);
      return;
    }
    if (msg.cmd === "generate") {
      const r = generate(String(msg.prompt || ""), {
        maxBytes: Math.min(2000, Math.max(16, Number(msg.maxBytes) || 320)),
        temperature: Math.min(2, Math.max(0.05, Number(msg.temperature) || 0.85)),
        seed: (Number(msg.seed) >>> 0) || 1,
        stopMarks: Array.isArray(msg.stopMarks) ? msg.stopMarks : null,
      });
      post({ type: "generated", text: r.text, bytes: r.bytes });
      return;
    }
    if (msg.cmd === "entropy") {
      const data = new Uint8Array(msg.data || []);
      post({ type: "entropy", bpb: entropyBits(data) });
      return;
    }
    post({ type: "error", message: "Unbekannter Befehl: " + msg.cmd });
  }

  if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof window === "undefined") {
    self.onmessage = (e) => {
      try { handle(e.data, (...a) => self.postMessage(...a)); }
      catch (err) { self.postMessage({ type: "error", message: String((err && err.message) || err) }); }
    };
  }

  global.BitseedEngine = { encode, decode, generate, entropyBits };
})(typeof self !== "undefined" ? self : globalThis);
