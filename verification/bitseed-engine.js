/*! Bitseed Engine v5 — GOP-Ankerstruktur (07.11.2026), MP4-Prinzip fuer Daten.
 * BTS5-Container: I-Blocks (unabhaengig komprimiert = Random Access + Resync)
 * und P-Blocks (XOR-Delta zum vorherigen Original-Block, dann CM auf dem
 * Residuum — gewinnt auf selbstaenlichen Daten: Logs, Sensordaten, Backups).
 * Pro Block wird der kleinste Kandidat gewaehlt (roh / CM / XOR+CM) — nie
 * schlechter als roh. BTS1–BTS4 bleiben lesbar; BTS5-Blöcke laufen auf der
 * JS-Kernschleife (frischer Modellzustand pro Block, garantiert unabhaengig).
 *
 * Protokoll (kompatibel zu v2–v4):
 *   init:   {cmd:"init"}                        -> {type:"ready"}
 *   encode: {cmd:"encode", data:ArrayBuffer}    -> progress ... {type:"encoded", hyb}
 *   decode: {cmd:"decode", hyb:ArrayBuffer}     -> progress ... {type:"decoded", data}
 *   generate/entropy wie v2.
 */
(function (global) {
  "use strict";

  /* ================= Byte-Range-Coder (Subbotin/LZMA-Stil, carry-sicher) =================
   * low als double (carry bis 2^33 darstellbar), range uint32.
   * p-Skala 1..4095 = P(1).  Ein Division/Multiplikation pro Bit statt
   * bitweiser E1/E2/E3-Schleife mit 8 Funktionsaufrufen pro Byte. */
  const RC_TOP = 1 << 24;

  function createEncoder(writeByte) {
    let low = 0, range = 0xffffffff;
    let cache = 0, cacheSize = 1;
    function shiftLow() {
      if (low < 0xff000000 || low >= 0x100000000) {
        let temp = cache;
        const carry = low >= 0x100000000 ? 256 : 0;
        do { writeByte((temp + (carry & 255)) & 255); temp = 255; carry0(); } while (--cacheSize > 0);
        cache = (low >>> 24) & 255;
        function carry0() {}
      }
      cacheSize++;
      low = (low * 256) % 0x100000000;
    }
    return {
      encode(p, bit) {          // p = P(1), 1..4095
        const bound = Math.floor(range / 4096) * (4096 - p);
        if (bit) { low += bound; range -= bound; }
        else range = bound;
        while (range < RC_TOP) { range = (range * 256) >>> 0; shiftLow(); }
      },
      flush() {
        for (let i = 0; i < 5; i++) shiftLow();
      },
    };
  }

  function createDecoder(readByte) {
    let low = 0, range = 0xffffffff, code = 0;
    for (let i = 0; i < 5; i++) code = ((code * 256) + readByte()) % 0x100000000;
    function shiftLow() {
      low = (low * 256) % 0x100000000;
      code = ((code * 256) + readByte()) % 0x100000000;
    }
    return {
      decode(p) {               // p = P(1), 1..4095
        const bound = Math.floor(range / 4096) * (4096 - p);
        let bit;
        if (code - low < bound) { bit = 0; range = bound; }
        else { bit = 1; low += bound; range -= bound; }
        while (range < RC_TOP) { range = (range * 256) >>> 0; shiftLow(); }
        return bit;
      },
    };
  }

  /* ================= stretch/squash (wie v2) ================= */
  const ST = new Int16Array(65536);
  for (let p = 1; p < 65536; p++) {
    const v = Math.round(256 * Math.log(p / (65536 - p)));
    ST[p] = v < -32767 ? -32767 : (v > 32767 ? 32767 : v);
  }
  ST[0] = -32767;
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

  /* ================= Zaehler (12-Bit gepackt + Tag), Division-frei ================= */
  const RECIP = new Float64Array(8194);   // 65536/s fuer s=1..8193
  for (let s = 1; s <= 8193; s++) RECIP[s] = 65536 / s;
  const RECIP16 = new Float64Array(513);  // 65536/s fuer s=1..511
  for (let s = 1; s <= 511; s++) RECIP16[s] = 65536 / s;
  /* PTAB: p = 65536*(n1+0.5)/(n0+n1+1) fuer 8b/8b-Zaehler, einmal vorberechnet.
   * Zaehler laufen bei 255 saettigen und halbieren sich bei (255,255) -- wie P16. */
  const PTAB = new Uint16Array(65536);
  for (let n0 = 0; n0 < 256; n0++) for (let n1 = 0; n1 < 256; n1++)
    PTAB[(n1 << 8) | n0] = Math.max(1, Math.min(65535, Math.round((n1 + 0.5) * 65536 / (n0 + n1 + 1))));
  function counterP(e) {
    return PTAB[e & 65535];
  }
  /* UPD: Zaehleruebergang tabelliert -- kein Branch im Bitloop */
  const UPD = new Uint16Array(131072);
  for (let v = 0; v < 65536; v++) {
    const n0 = v & 255, n1 = v >>> 8;
    let n0b = n0 < 255 ? n0 + 1 : n0, n1b = n1;
    if (n0b >= 255 && n1b >= 255) { n0b >>= 1; n1b >>= 1; }
    UPD[v] = n0b | (n1b << 8);
    n0b = n0; n1b = n1 < 255 ? n1 + 1 : n1;
    if (n0b >= 255 && n1b >= 255) { n0b >>= 1; n1b >>= 1; }
    UPD[v | 65536] = n0b | (n1b << 8);
  }
  function counterUp(e, bit, tag) {
    if (((e >>> 24) & 255) !== tag) e = tag << 24;
    return UPD[(e & 65535) | (bit << 16)] | (tag << 24);
  }
  function counterP16(v) {
    return PTAB[v & 65535];
  }
  function counterUp16(v, bit) {
    let n0 = v & 255, n1 = (v >> 8) & 255;
    if (bit) { if (n1 < 255) n1++; } else { if (n0 < 255) n0++; }
    if (n0 >= 128 && n1 >= 128) { n0 >>= 1; n1 >>= 1; }
    return n0 | (n1 << 8);
  }

  /* 12-Bit-Skala aus 16-Bit-P: (p * 4096 + 32768) >> 16 */
  function p12(p) { return (p * 4096 + 32768) >> 16; }

  /* ================= Modell v3 =================
   * Modelle: o0(local16) o1 o2 o3 o4 o6 o8 o12(sparse) WORT match
   * Stufen: Mixer(logistisch, Integer-Gewichte) -> SSE1(prevByte, 64 bins)
   *         -> SSE2(prevByte>>3, 64 bins). */
  const NMOD = 7;
  const B1 = 16, B2 = 18, B3 = 18, B4 = 19, B6 = 19, B8 = 18, B12 = 18, BW = 17;
  const M1 = (1 << B1) - 1, M2 = (1 << B2) - 1, M3 = (1 << B3) - 1,
        M4 = (1 << B4) - 1, M6 = (1 << B6) - 1, M8 = (1 << B8) - 1,
        M12 = (1 << B12) - 1, MW = (1 << BW) - 1;

  function createModel() {
    return {
      T2: new Uint32Array(1 << B2),
      T4: new Uint32Array(1 << B4),
      T8: new Uint32Array(1 << B8),
      T12: new Uint32Array(1 << B12),
      TW: new Uint32Array(1 << BW),
      SSE1: new Uint16Array(256 * 256),
      SSE2: new Uint16Array(32 * 64),
      MTAB: new Int32Array(1 << 17).fill(-1),
      w: new Int32Array(NMOD).fill(4096 / NMOD),
      c1: 0, c2: 0, c3: 0, c4: 0, c6: 0, c8: 0, c12: 0,
      wH: 0, wLen: 0,
      n0c: 0, n1c: 0,
      mActive: false, mSrc: 0, mOff: 0, mByte: 0,
    };
  }

  /* Byte-Loop-Helfer: sagt P(1) in 12-Bit-Skala voraus + merkt Indizes.
   * Alles auf dem Modell-Objekt m (Property-Zugriff hier ok — wird in
   * run() durch lokale Kopien ersetzt, siehe unten). */
  function predictBit(m, prefix) {
    const marker = ((prefix << 1) | 1) >>> 0;
    const i1 = (m.c1 + marker) & M1;
    const i2 = ((m.c2 ^ (marker * 0x9e37)) >>> 0) & M2;
    const i3 = ((m.c3 + marker * 257) >>> 0) & M3;
    const i4 = ((m.c4 ^ (marker * 0x85eb)) >>> 0) & M4;
    const i6 = ((m.c6 + marker * 131) >>> 0) & M6;
    const i8 = ((m.c8 ^ (marker * 0x27d4)) >>> 0) & M8;
    const i12 = ((m.c12 + marker * 0x9e3779) >>> 0) & M12;
    const iW = ((m.wH + marker * 0x85eb) >>> 0) & MW;
    m.i1 = i1; m.i2 = i2; m.i3 = i3; m.i4 = i4; m.i6 = i6; m.i8 = i8; m.i12 = i12; m.iW = iW;
    m.t1 = (m.c2 >>> B2) & 255; m.t3 = (m.c3 >>> B3) & 255;
    m.t4 = (m.c4 >>> B4) & 255; m.t6 = (m.c6 >>> B6) & 255;
    m.t8 = (m.c8 >>> B8) & 255; m.t12 = (m.c12 >>> B12) & 255;
    m.tW = (m.wH >>> BW) & 255;

    const p0 = counterP16(m.n0c | (m.n1c << 8)); m.ps0 = p0;
    const p1 = counterP(m.T1[i1]); m.p1 = p1;
    const p2 = counterP(m.T2[i2]); m.p2 = p2;
    const p3 = counterP(m.T3[i3]); m.p3 = p3;
    const p4 = counterP(m.T4[i4]); m.p4 = p4;
    const p6 = counterP(m.T6[i6]); m.p6 = p6;
    const p8 = counterP(m.T8[i8]); m.p8 = p8;
    const p12v = counterP(m.T12[i12]); m.p12v = p12v;
    const pW = counterP(m.TW[iW]); m.pW = pW;
    m.matchConf = Math.min(65472, 61000 + Math.min(m.mOff, 300) * 15);
    m.pm = (m.mActive && (((m.mByte >> m.mBitPos) & 1) ? m.matchConf : 65535 - m.matchConf)) || 32768;

    const w = m.w;
    const s = (w[0] * ST[p0] + w[1] * ST[p1] + w[2] * ST[p2] +
               w[3] * ST[p3] + w[4] * ST[p4] + w[5] * ST[p6] +
               w[6] * ST[p8] + w[7] * ST[p12v] + w[8] * ST[pW] + w[9] * ST[m.pm]) >> 12;
    let mixed = squash(s);
    m.mixed = mixed;

    /* SSE1: prevByte x 64 Bins der gemischten Wahrscheinlichkeit */
    const bin = mixed >> 8;
    const s1i = m.prevByte * 256 + bin;
    m.s1i = s1i;
    const q1 = counterP16(m.SSE1[s1i]);
    let m2 = (mixed + q1) >> 1;
    /* SSE2: prevByte>>3 x 64 Bins, Mischung staerker am Mixer festhalten */
    const s2i = (m.prevByte >> 3) * 64 + (m2 >> 10);
    m.s2i = s2i;
    const q2 = counterP16(m.SSE2[s2i]);
    const fin = (3 * m2 + q2) >> 2;
    m.pFinal = fin < 1 ? 1 : (fin > 65535 ? 65535 : fin);
    return m.pFinal;
  }

  function updateBit(m, bit) {
    /* Integer-Gewichte (Skala 4096): Fehler gegen gemischte Wahrscheinlichkeit */
    const err = bit ? 65536 - m.mixed : -m.mixed;
    const w = m.w;
    const st0 = ST[m.ps0], st1 = ST[m.p1], st2 = ST[m.p2], st3 = ST[m.p3],
          st4 = ST[m.p4], st5 = ST[m.p6], st6 = ST[m.p8],
          st7 = ST[m.p12v], st8 = ST[m.pW], st9 = ST[m.pm];
    const e = err >> 7;   // ~err/128
    let w0 = w[0] + ((e * st0) >> 17);
    let w1 = w[1] + ((e * st1) >> 17);
    let w2 = w[2] + ((e * st2) >> 17);
    let w3 = w[3] + ((e * st3) >> 17);
    let w4 = w[4] + ((e * st4) >> 17);
    let w5 = w[5] + ((e * st5) >> 17);
    let w6 = w[6] + ((e * st6) >> 17);
    let w7 = w[7] + ((e * st7) >> 17);
    let w8 = w[8] + ((e * st8) >> 17);
    let w9 = w[9] + ((e * st9) >> 17);
    if (w0 < 2) w0 = 2; if (w1 < 2) w1 = 2; if (w2 < 2) w2 = 2; if (w3 < 2) w3 = 2;
    if (w4 < 2) w4 = 2; if (w5 < 2) w5 = 2; if (w6 < 2) w6 = 2; if (w7 < 2) w7 = 2;
    if (w8 < 2) w8 = 2; if (w9 < 2) w9 = 2;
    const sw = w0 + w1 + w2 + w3 + w4 + w5 + w6 + w7 + w8 + w9;
    w[0] = (w0 * 4096) / sw | 0; w[1] = (w1 * 4096) / sw | 0;
    w[2] = (w2 * 4096) / sw | 0; w[3] = (w3 * 4096) / sw | 0;
    w[4] = (w4 * 4096) / sw | 0; w[5] = (w5 * 4096) / sw | 0;
    w[6] = (w6 * 4096) / sw | 0; w[7] = (w7 * 4096) / sw | 0;
    w[8] = (w8 * 4096) / sw | 0; w[9] = (w9 * 4096) / sw | 0;

    if (bit) { if (m.n1c < 255) m.n1c++; } else { if (m.n0c < 255) m.n0c++; }
    if (m.n0c >= 128 && m.n1c >= 128) { m.n0c >>= 1; m.n1c >>= 1; }

    m.T1[m.i1] = counterUp(m.T1[m.i1], bit, 0);
    m.T2[m.i2] = counterUp(m.T2[m.i2], bit, m.t1);
    m.T3[m.i3] = counterUp(m.T3[m.i3], bit, m.t3);
    m.T4[m.i4] = counterUp(m.T4[m.i4], bit, m.t4);
    m.T6[m.i6] = counterUp(m.T6[m.i6], bit, m.t6);
    m.T8[m.i8] = counterUp(m.T8[m.i8], bit, m.t8);
    m.T12[m.i12] = counterUp(m.T12[m.i12], bit, m.t12);
    m.TW[m.iW] = counterUp(m.TW[m.iW], bit, m.tW);
    m.SSE1[m.s1i] = counterUp16(m.SSE1[m.s1i], bit);
    m.SSE2[m.s2i] = counterUp16(m.SSE2[m.s2i], bit);
  }

  /* ================= Kernschleife v3 (alles lokal, kein Funktionsaufruf/Bit) ================= */
  function run(data, decodeMode, out, onProgress) {
    const n = data.length;
    const m = createModel();
    m.prevByte = 0;

    const T2 = m.T2, T4 = m.T4, T8 = m.T8, T12 = m.T12, TW = m.TW,
          SSE1 = m.SSE1, SSE2 = m.SSE2, MTAB = m.MTAB, w = m.w;

    let readByte = null;
    if (decodeMode) {
      let bp = 0;
      const buf = out;
      readByte = () => (bp < buf.length ? buf[bp++] : 0);
    }

    let encLow = 0, range = 0xffffffff;
    let cache = 0, cacheSize = 1, code = 0;
    if (decodeMode) { for (let i = 0; i < 5; i++) code = ((code * 256) + readByte()) % 0x100000000; }

    function shiftLowEnc() {
      if (encLow < 0xff000000 || encLow >= 0x100000000) {
        const carry = encLow >= 0x100000000 ? 1 : 0;
        let temp = cache;
        do { out.push((temp + carry) & 255); temp = 255; } while (--cacheSize > 0);
        cache = (encLow >>> 24) & 255;
      }
      cacheSize++;
      encLow = (encLow * 256) % 0x100000000;
    }
    function shiftLowDec() {
      range = (range * 256) >>> 0;
      code = ((code * 256) + readByte()) % 0x100000000;
    }

    /* Modellzustand lokal */
    let c2 = 0, c4 = 0, c8 = 0, c12 = 0;
    let wH = 0, wLen = 0;
    let n0c = 0, n1c = 0;
    let prevByte = 0;
    let mActive = false, mSrc = 0, mOff = 0, mByte = 0;

    let ps0 = 0, p2v = 0, p4v = 0, p8v = 0, p12m = 0, pWv = 0, pmv = 0, mixed = 0;
    let ii2 = 0, ii4 = 0, ii8 = 0, ii12 = 0, iiW = 0;
    let tg1 = 0, tg4 = 0, tg8 = 0, tg12 = 0, tgW = 0;
    let si1 = 0, si2 = 0;
    let bitCnt = 0;

    const NMODL = NMOD;

    for (let pos = 0; pos < n; pos++) {
      /* LZP-Hash (wie v2) */
      let hm = -1;
      if (pos >= 4) {
        const h = (data[pos - 1] * 0x1e35a5bd ^ data[pos - 2] * 0x9e3779b1 ^
                   data[pos - 3] * 0x85ebca6b ^ data[pos - 4] * 0xc2b2ae35) >>> 0;
        hm = (h ^ (h >>> 15)) & 0x1ffff;
      }
      if (!mActive && hm >= 0) {
        const cand = MTAB[hm];
        if (cand >= 4 && pos >= 4 &&
            data[cand - 4] === data[pos - 4] && data[cand - 3] === data[pos - 3] &&
            data[cand - 2] === data[pos - 2] && data[cand - 1] === data[pos - 1]) {
          mActive = true; mSrc = cand; mOff = 0;
        }
      }
      if (mActive) {
        if (mSrc + mOff >= pos) mActive = false;
        else mByte = data[mSrc + mOff];
      }

      /* Byte-invariante Teile einmal pro Byte (statt pro Bit) */
      tg1 = (c2 >>> B2) & 255;
      tg4 = (c4 >>> B4) & 255;
      tg8 = (c8 >>> B8) & 255; tg12 = (c12 >>> B12) & 255;
      tgW = (wH >>> BW) & 255;
      const mConf = mOff < 300 ? 61000 + mOff * 15 : 65472;
      const si1base = prevByte * 64, si2base = (prevByte >> 3) * 64;

      let prefix = 0;
      let byteVal = 0;
      const dataPos = data[pos];

      for (let i = 7; i >= 0; i--) {
        /* ---- predict (inlined) ---- */
        const marker = ((prefix << 1) | 1) >>> 0;
        ii2 = ((c2 ^ (marker * 0x9e37)) >>> 0) & M2;
        ii4 = ((c4 ^ (marker * 0x85eb)) >>> 0) & M4;
        ii8 = ((c8 ^ (marker * 0x27d4)) >>> 0) & M8;
        ii12 = ((c12 + marker * 0x9e3779) >>> 0) & M12;
        iiW = ((wH + marker * 0x85eb) >>> 0) & MW;

        ps0 = counterP16(n0c | (n1c << 8));
        p2v = counterP(T2[ii2]);
        p4v = counterP(T4[ii4]);
        p8v = counterP(T8[ii8]);
        p12m = counterP(T12[ii12]);
        pWv = counterP(TW[iiW]);
        pmv = mActive ? (((mByte >> i) & 1) ? mConf : 65535 - mConf) : 32768;

        const s = (w[0] * ST[ps0] + w[1] * ST[p2v] +
                   w[2] * ST[p4v] + w[3] * ST[p8v] + w[4] * ST[p12m] +
                   w[5] * ST[pWv] + w[6] * ST[pmv]) >> 12;
        mixed = squash(s);

        const bin = mixed >> 8;
        si1 = si1base + bin;
        const q1 = counterP16(SSE1[si1]);
        const m2 = (mixed + q1) >> 1;
        si2 = si2base + (m2 >> 10);
        const q2 = counterP16(SSE2[si2]);
        const fin = (3 * m2 + q2) >> 2;
        const pInt = p12(fin < 1 ? 1 : (fin > 65535 ? 65535 : fin));

        /* ---- range-coder Schritt ---- */
        let bit;
        if (decodeMode) {
          const bound = Math.floor(range / 4096) * (4096 - pInt);
          if (code < bound) { bit = 0; range = bound; }
          else { bit = 1; code -= bound; range -= bound; }
          while (range < RC_TOP) shiftLowDec();
          byteVal = (byteVal << 1) | bit;
        } else {
          bit = (dataPos >> i) & 1;
          const bound = Math.floor(range / 4096) * (4096 - pInt);
          if (bit) { encLow += bound; range -= bound; } else range = bound;
          while (range < RC_TOP) { range = (range * 256) >>> 0; shiftLowEnc(); }
        }

        /* ---- update (inlined) ---- */
        const err = bit ? 65536 - mixed : -mixed;
        const e = err >> 7;
        let w0 = w[0] + ((e * ST[ps0]) >> 17);
        let w1 = w[1] + ((e * ST[p2v]) >> 17);
        let w2 = w[2] + ((e * ST[p4v]) >> 17);
        let w3 = w[3] + ((e * ST[p8v]) >> 17);
        let w4 = w[4] + ((e * ST[p12m]) >> 17);
        let w5 = w[5] + ((e * ST[pWv]) >> 17);
        let w6 = w[6] + ((e * ST[pmv]) >> 17);
        if (w0 < 2) w0 = 2; if (w1 < 2) w1 = 2; if (w2 < 2) w2 = 2;
        if (w3 < 2) w3 = 2; if (w4 < 2) w4 = 2; if (w5 < 2) w5 = 2;
        if (w6 < 2) w6 = 2;
        w[0] = w0; w[1] = w1; w[2] = w2; w[3] = w3; w[4] = w4;
        w[5] = w5; w[6] = w6;
        /* Renorm nur alle 32 Bits (statt pro Bit): Divisionen /32 */
        if ((++bitCnt & 31) === 0) {
          const sw = w0 + w1 + w2 + w3 + w4 + w5 + w6;
          w[0] = ((w0 * 4096) / sw) | 0; w[1] = ((w1 * 4096) / sw) | 0;
          w[2] = ((w2 * 4096) / sw) | 0; w[3] = ((w3 * 4096) / sw) | 0;
          w[4] = ((w4 * 4096) / sw) | 0; w[5] = ((w5 * 4096) / sw) | 0;
          w[6] = ((w6 * 4096) / sw) | 0;
        }

        if (bit) { if (n1c < 255) n1c++; } else { if (n0c < 255) n0c++; }
        if (n0c >= 128 && n1c >= 128) { n0c >>= 1; n1c >>= 1; }

        T2[ii2] = counterUp(T2[ii2], bit, tg1);
        T4[ii4] = counterUp(T4[ii4], bit, tg4);
        T8[ii8] = counterUp(T8[ii8], bit, tg8);
        T12[ii12] = counterUp(T12[ii12], bit, tg12);
        TW[iiW] = counterUp(TW[iiW], bit, tgW);
        SSE1[si1] = counterUp16(SSE1[si1], bit);
        SSE2[si2] = counterUp16(SSE2[si2], bit);

        prefix = ((prefix << 1) | bit) & 255;
      }

      const byteOut = decodeMode ? byteVal : dataPos;
      if (decodeMode) data[pos] = byteOut;
      prevByte = byteOut;

      /* Wort-Kontext rollen (Buchstaben a-z, max 12 Zeichen Tiefe) */
      const bLo = byteOut | 32;
      if (bLo >= 97 && bLo <= 122) {
        wH = ((wH * 257) ^ byteOut) & 0x7ffff;
        if (wLen < 12) wLen++;
      } else { wH = 0; wLen = 0; }

      if (mActive) {
        if (byteOut !== mByte) mActive = false;
        else mOff++;
      }
      if (hm >= 0) MTAB[hm] = pos;

      c2 = ((c2 * 257) ^ byteOut) & 0x1ffff;
      c4 = ((c4 * 65) ^ (byteOut * 3)) & 0x3ffff;
      c8 = ((c8 * 17) ^ (byteOut * 11)) & 0xfffff;
      c12 = ((c12 * 13) ^ (byteOut * 7)) & 0xfffff;

      if (onProgress && (pos & 0xffff) === 0) onProgress(pos / n);
    }
    if (!decodeMode) { for (let i = 0; i < 5; i++) shiftLowEnc(); }
    if (onProgress) onProgress(1);
  }

  /* ================= Container ================= */
  const MAGIC_V1 = 0x31535442; // "BTS1"
  const MAGIC_V2 = 0x32535442; // "BTS2"
  const MAGIC_V3 = 0x33535442; // "BTS3"
  const MAGIC = 0x34535442;    // "BTS4"
  const MAGIC_V5 = 0x35535442; // "BTS5"

  /* ================= BTS5 — GOP-Ankerstruktur (MP4-Prinzip fuer Daten) =================
   *   u32 magic "BTS5" · u64 Original-Länge · u32 Blockgröße (GOP)
   *   u32 Blockzahl · u32 Flags(0) · Tabelle: pro Block u32 compLen + u32 Mode
   *   Mode 0 = roh · Mode 1 = CM (I-Block, frischer Zustand, unabhängig)
   *   Mode 2 = XOR-Delta zum vorigen Original-Block + CM (P-Block)
   * Jeder Block ist einzeln decodierbar — Random Access und Resync nach
   * Korruption, wie ein Keyframe im Video. Kosten: <0,01 % Tabellen-Overhead. */
  const GOP_GROESSE = 256 * 1024;

  function cmStream(raw) { // I-Block: frischer Modellzustand garantiert
    const stream = [];
    run(raw, false, stream, null);
    return Uint8Array.from(stream);
  }

  function encodeGOP(data, onProgress) {
    const n = data.length;
    const gop = GOP_GROESSE;
    const anzahl = Math.max(1, Math.ceil(n / gop));
    const eintraege = []; // {len, mode}
    const teile = [];
    let vorher = null; // Original-Bytes des vorigen Blocks (für XOR-P-Blocks)
    for (let i = 0; i < anzahl; i++) {
      const roh = data.subarray(i * gop, Math.min(n, (i + 1) * gop));
      let mode = 0, beste = roh;
      const cm = cmStream(roh);
      if (cm.length < roh.length) { mode = 1; beste = cm; }
      if (vorher && vorher.length === roh.length) {
        const delta = new Uint8Array(roh.length);
        for (let j = 0; j < roh.length; j++) delta[j] = roh[j] ^ vorher[j];
        const cmx = cmStream(delta);
        if (cmx.length < beste.length) { mode = 2; beste = cmx; }
      }
      eintraege.push({ len: beste.length, mode });
      teile.push(beste);
      vorher = roh;
      if (onProgress) onProgress((i + 1) / anzahl);
    }
    let payload = 0;
    for (const t of teile) payload += t.length;
    const hyb = new Uint8Array(20 + 8 * anzahl + payload);
    const dv = new DataView(hyb.buffer);
    dv.setUint32(0, MAGIC_V5, true);
    dv.setUint32(4, n >>> 0, true);
    dv.setUint32(8, Math.floor(n / 0x100000000), true);
    dv.setUint32(12, gop, true);
    dv.setUint32(16, anzahl, true);
    let pos = 20;
    for (const e of eintraege) { dv.setUint32(pos, e.len, true); dv.setUint32(pos + 4, e.mode, true); pos += 8; }
    for (const t of teile) { hyb.set(t, pos); pos += t.length; }
    return { hyb, wasm: false };
  }

  function decodeGOP(hyb, n, onProgress) {
    const dv = new DataView(hyb.buffer, hyb.byteOffset);
    const gop = dv.getUint32(12, true);
    const anzahl = dv.getUint32(16, true);
    const tabelle = 20;
    const data = new Uint8Array(n);
    let pos = tabelle + 8 * anzahl;
    let vorher = null;
    for (let i = 0; i < anzahl; i++) {
      const compLen = dv.getUint32(tabelle + 8 * i, true);
      const mode = dv.getUint32(tabelle + 8 * i + 4, true);
      const rohLen = Math.min(gop, n - i * gop);
      const block = data.subarray(i * gop, i * gop + rohLen);
      if (mode === 0) block.set(hyb.subarray(pos, pos + rohLen));
      else {
        run(block, true, hyb.subarray(pos, pos + compLen), null);
        if (mode === 2 && vorher) for (let j = 0; j < rohLen; j++) block[j] ^= vorher[j];
      }
      vorher = block;
      pos += mode === 0 ? rohLen : compLen;
      if (onProgress) onProgress((i + 1) / anzahl);
    }
    return { data, wasm: false };
  }

  /* ================= WASM-Beschleunigung (05.11.) =================
   * Derselbe v4-Kern, in C portiert (bitseed-core-wasm.c).  Der Bitstrom
   * ist byte-identisch zur JS-Schleife — gemessen und belegt im
   * Verification-Bundle.  Das Modul wird einmal geladen; fehlt es oder
   * ist die Datei groesser als der Linearspeicher hergibt, rechnet
   * weiterhin die JS-Schleife.  Konsistenz vor Tempo, immer. */
  const WASM_MAX = 12 * 1024 * 1024; /* 32 MiB Speicher, ~6,3 MiB Tabellen, In+Out */
  let wasmKern = null, wasmVersuch = null;
  function wasmLaden() {
    if (!wasmVersuch) wasmVersuch = (async () => {
      try {
        if (typeof importScripts === "function" && typeof BitseedWasm === "undefined") importScripts("bitseed-wasm.js");
        const fabrik = typeof BitseedWasm !== "undefined" ? BitseedWasm : null;
        if (!fabrik) return null;
        const mod = await fabrik();
        mod._bs_init();
        wasmKern = mod;
      } catch (e) { wasmKern = null; }
      return wasmKern;
    })();
    return wasmVersuch;
  }
  function wasmEncode(data) {
    try {
      const w = wasmKern, heap = w.HEAPU8;
      const inPtr = w._malloc(data.length);
      const outCap = data.length + 1024; /* Reserve fuer nicht-kompressibles */
      const outPtr = w._malloc(outCap);
      if (!inPtr || !outPtr) { w._free(inPtr); w._free(outPtr); return null; }
      heap.set(data, inPtr);
      const len = w._bs_encode(inPtr, data.length, outPtr, outCap);
      if (len < 0) { w._free(inPtr); w._free(outPtr); return null; }
      const out = heap.slice(outPtr, outPtr + len);
      w._free(inPtr); w._free(outPtr);
      return out;
    } catch (e) { return null; }
  }
  function wasmDecode(stream, n) {
    try {
      const w = wasmKern, heap = w.HEAPU8;
      const inPtr = w._malloc(stream.length);
      const outPtr = w._malloc(n);
      if (!inPtr || !outPtr) { w._free(inPtr); w._free(outPtr); return null; }
      heap.set(stream, inPtr);
      if (w._bs_decode(inPtr, stream.length, outPtr, n) !== 0) { w._free(inPtr); w._free(outPtr); return null; }
      const out = heap.slice(outPtr, outPtr + n);
      w._free(inPtr); w._free(outPtr);
      return out;
    } catch (e) { return null; }
  }

  function encode(data, onProgress) {
    /* Grosse Dateien: BTS5-GOP (Random Access, Resync, XOR-P-Blocks).
     * Kleine (<= 1 MiB): monolithischer BTS4-Pfad — dort trägt der WASM-Kern
     * das Tempo, und der LZP-Match nutzt ohnehin schon die Gesamt-Redundanz. */
    if (data.length > 1024 * 1024) return encodeGOP(data, onProgress);
    let stream = null, viaWasm = false;
    if (wasmKern && data.length <= WASM_MAX) {
      /* WASM-Pfad: derselbe Bitstrom ohne JS-Interpreter dazwischen.
       * Misslingt die Reservierung oder der Lauf, faellt die Datei
       * still auf die JS-Schleife zurueck — Konsistenz vor Tempo. */
      if (onProgress) onProgress(0);
      stream = wasmEncode(data);
      viaWasm = !!stream;
      if (stream && onProgress) onProgress(1);
    }
    if (!stream) { stream = []; run(data, false, stream, onProgress); }
    const hyb = new Uint8Array(12 + stream.length);
    const dv = new DataView(hyb.buffer);
    dv.setUint32(0, MAGIC, true);
    dv.setUint32(4, data.length >>> 0, true);
    dv.setUint32(8, Math.floor(data.length / 0x100000000), true);
    hyb.set(stream, 12);
    return { hyb, wasm: viaWasm };
  }

  function decode(hyb, onProgress) {
    const dv = new DataView(hyb.buffer, hyb.byteOffset);
    const magic = dv.getUint32(0, true);
    if (magic !== MAGIC && magic !== MAGIC_V5 && magic !== MAGIC_V3 && magic !== MAGIC_V2 && magic !== MAGIC_V1) throw new Error("Kein Bitseed-Archiv (Magic mismatch).");
    const n = dv.getUint32(4, true) + dv.getUint32(8, true) * 0x100000000;
    if (magic === MAGIC_V5) return decodeGOP(hyb, n, onProgress);
    const stream = magic === MAGIC || magic === MAGIC_V3 ? hyb.subarray(12)
      : magic === MAGIC_V2 ? hyb.subarray(14 + dv.getUint16(12, true))
      : hyb.subarray(12 + 512);
    if (magic === MAGIC) {
      if (wasmKern && n <= WASM_MAX && stream.length <= WASM_MAX) {
        if (onProgress) onProgress(0);
        const wout = wasmDecode(stream, n);
        if (wout) { if (onProgress) onProgress(1); return { data: wout, wasm: true }; }
      }
      const data = new Uint8Array(n);
      run(data, true, stream, onProgress);
      return { data, wasm: false };
    }
    const data = new Uint8Array(n);
    decodeLegacy(magic, data, stream, onProgress);
    return { data, wasm: false };
  }

  /* ---- Legacy-Pfad: v2-Engine (bitweise) fuer BTS1-BTS3 ---- */
  function decodeLegacy(magic, data, stream, onProgress) {
    const HALF = 0x80000000, QUARTER = 0x40000000, THREE_QUARTER = 0xc0000000;
    let pos = 0;
    const readBit = () => {
      const byte = pos >> 3 < stream.length ? stream[pos >> 3] : 0;
      const bit = (byte >> (7 - (pos & 7))) & 1;
      pos++;
      return bit;
    };
    let low = 0, high = 0xffffffff, code = 0;
    for (let i = 0; i < 32; i++) code = (code * 2 + readBit()) >>> 0;

    const NMODL = 7;
    const STL = ST;
    const m = {
      T1: new Uint32Array(1 << 16), T2: new Uint32Array(1 << 18),
      T3: new Uint32Array(1 << 18), T4: new Uint32Array(1 << 19),
      T6: new Uint32Array(1 << 19),
      APM: new Uint16Array(256 * 32),
      MTAB: new Int32Array(1 << 17).fill(-1),
      w: new Float64Array(NMODL).fill(1 / NMODL),
      c1: 0, c2: 0, c3: 0, c4: 0, c6: 0,
      n0c: 0, n1c: 0, prevByte: 0,
      mActive: false, mSrc: 0, mOff: 0, mByte: 0, mBitPos: 0,
    };
    const M1L = 0xffff, M2L = 0x3ffff, M3L = 0x3ffff, M4L = 0x7ffff, M6L = 0x7ffff;

    const n = data.length;
    for (let p = 0; p < n; p++) {
      let hm = -1;
      if (p >= 4) {
        const h = (data[p - 1] * 0x1e35a5bd ^ data[p - 2] * 0x9e3779b1 ^
                   data[p - 3] * 0x85ebca6b ^ data[p - 4] * 0xc2b2ae35) >>> 0;
        hm = (h ^ (h >>> 15)) & 0x1ffff;
      }
      if (!m.mActive && hm >= 0) {
        const cand = m.MTAB[hm];
        if (cand >= 4 && p >= 4 &&
            data[cand - 4] === data[p - 4] && data[cand - 3] === data[p - 3] &&
            data[cand - 2] === data[p - 2] && data[cand - 1] === data[p - 1]) {
          m.mActive = true; m.mSrc = cand; m.mOff = 0;
        }
      }
      if (m.mActive) {
        if (m.mSrc + m.mOff >= p) m.mActive = false;
        else m.mByte = data[m.mSrc + m.mOff];
      }

      let prefix = 0, byteVal = 0;
      for (let i = 7; i >= 0; i--) {
        m.mBitPos = i;
        const marker = (prefix << 1) | 1;
        const i1 = (m.c1 + marker) & M1L;
        const i2 = ((m.c2 ^ (marker * 0x9e37)) >>> 0) & M2L;
        const i3 = ((m.c3 + marker * 257) >>> 0) & M3L;
        const i4 = ((m.c4 ^ (marker * 0x85eb)) >>> 0) & M4L;
        const i6 = ((m.c6 + marker * 131) >>> 0) & M6L;
        m.i1 = i1; m.i2 = i2; m.i3 = i3; m.i4 = i4; m.i6 = i6;
        m.t1 = (m.c2 >>> 18) & 255; m.t3 = (m.c3 >>> 18) & 255;
        m.t4 = (m.c4 >>> 19) & 255; m.t6 = (m.c6 >>> 19) & 255;

        const p0 = counterP16(m.n0c | (m.n1c << 8)); m.ps0 = p0;
        m.p1 = counterP(m.T1[i1]); m.p2 = counterP(m.T2[i2]);
        m.p3 = counterP(m.T3[i3]); m.p4 = counterP(m.T4[i4]); m.p6 = counterP(m.T6[i6]);
        m.matchConf = Math.min(65472, 61000 + Math.min(m.mOff, 300) * 15);
        m.pm = (m.mActive && (((m.mByte >> m.mBitPos) & 1) ? m.matchConf : 65535 - m.matchConf)) || 32768;

        const w = m.w;
        const s = w[0] * ST[p0] + w[1] * ST[m.p1] + w[2] * ST[m.p2] +
                  w[3] * ST[m.p3] + w[4] * ST[m.p4] + w[5] * ST[m.p6] + w[6] * ST[m.pm];
        const mixed = squash(Math.round(s));
        m.mixed = mixed;
        const bin = mixed >> 11;
        const ai = (m.prevByte * 32 + bin) & 8191;
        m.ai = ai;
        const p2v = counterP16(m.APM[ai]);
        const fin = (mixed + p2v) >> 1;
        m.pFinal = fin < 1 ? 1 : (fin > 65535 ? 65535 : fin);

        /* bitweiser Dekodierschritt (E1/E2/E3) */
        const pInt = m.pFinal;
        const range2 = high - low + 1;
        const split = Math.floor((range2 * pInt) / 0x10000);
        let bit;
        if (code < low + split) { high = low + split - 1; bit = 1; }
        else { low = low + split; bit = 0; }
        for (;;) {
          if (high < HALF) {}
          else if (low >= HALF) { low -= HALF; high -= HALF; code -= HALF; }
          else if (low >= QUARTER && high < THREE_QUARTER) { low -= QUARTER; high -= QUARTER; code -= QUARTER; }
          else break;
          low = (low * 2) >>> 0; high = ((high * 2) + 1) >>> 0; code = ((code * 2) + readBit()) >>> 0;
        }
        byteVal = (byteVal << 1) | bit;

        /* update (v2-Logik, Float-Gewichte) */
        const err = (bit ? 65536 : 0) - m.mixed;
        let sw = 0;
        const sts = [ST[m.ps0], ST[m.p1], ST[m.p2], ST[m.p3], ST[m.p4], ST[m.p6], ST[m.pm]];
        const nw = [];
        for (let k = 0; k < NMODL; k++) {
          let x = w[k] + 0.1 * (err / 65536) * (sts[k] / 2840);
          if (x < 0.0005) x = 0.0005;
          nw.push(x); sw += x;
        }
        for (let k = 0; k < NMODL; k++) w[k] = nw[k] / sw;
        if (bit) { if (m.n1c < 255) m.n1c++; } else { if (m.n0c < 255) m.n0c++; }
        if (m.n0c >= 128 && m.n1c >= 128) { m.n0c >>= 1; m.n1c >>= 1; }
        m.T1[m.i1] = counterUp(m.T1[m.i1], bit, 0);
        m.T2[m.i2] = counterUp(m.T2[m.i2], bit, m.t1);
        m.T3[m.i3] = counterUp(m.T3[m.i3], bit, m.t3);
        m.T4[m.i4] = counterUp(m.T4[m.i4], bit, m.t4);
        m.T6[m.i6] = counterUp(m.T6[m.i6], bit, m.t6);
        m.APM[m.ai] = counterUp16(m.APM[m.ai], bit);
        prefix = ((prefix << 1) | bit) & 255;
      }

      const byteOut = byteVal;
      data[p] = byteOut;
      m.prevByte = byteOut;
      if (m.mActive) {
        if (byteOut !== m.mByte) m.mActive = false;
        else m.mOff++;
      }
      if (hm >= 0) m.MTAB[hm] = p;
      m.c1 = byteOut;
      m.c2 = ((m.c2 * 257) ^ byteOut) & 0x1ffff;
      m.c3 = ((m.c3 * 131) ^ (byteOut * 7)) & 0x1ffff;
      m.c4 = ((m.c4 * 65) ^ (byteOut * 3)) & 0x3ffff;
      m.c6 = ((m.c6 * 33) ^ (byteOut * 5)) & 0x3ffff;
      if (onProgress && (p & 0xffff) === 0) onProgress(p / n);
    }
    if (onProgress) onProgress(1);
  }

  function headerSize(hyb) {
    const dv = new DataView(hyb.buffer, hyb.byteOffset);
    const magic = dv.getUint32(0, true);
    if (magic === MAGIC_V5) return 20 + 8 * dv.getUint32(16, true);
    if (magic === MAGIC || magic === MAGIC_V3) return 12;
    if (magic === MAGIC_V2) return 14 + dv.getUint16(12, true);
    if (magic === MAGIC_V1) return 12 + 512;
    return 0;
  }

  /* ================= Generierung (wie v2, auf v3-Modell API) ================= */
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
    let wH = 0, wLen = 0;

    const feedBit = (bit, prefix, i, learnRate) => {
      m.mBitPos = i;
      const pInt = predictBit(m, prefix);
      let b = bit;
      if (b === null) {
        let p = pInt / 65536;
        if (temperature !== 1) {
          const eps = 1 / 65536;
          p = Math.min(1 - eps, Math.max(eps, p));
          const logit = Math.log(p / (1 - p)) / Math.max(0.05, temperature);
          p = 1 / (1 + Math.exp(-logit));
        }
        const pSamp = Math.min(65535, Math.max(1, Math.round(p * 65536)));
        b = rnd() * 65536 < pSamp ? 1 : 0;
      }
      /* Lernrate: erhoehtes Tempo im Lernmodus */
      const save = m.w;
      updateBit(m, b);
      return { pInt, b };
    };

    const feedByte = (byte, learnRate) => {
      let prefix = 0;
      for (let i = 7; i >= 0; i--) {
        const r = feedBit((byte >> i) & 1, prefix, i, learnRate);
        prefix = ((prefix << 1) | r.b) & 255;
      }
      /* Kontexte rollen (gleiche Logik wie run) */
      const bLo = byte | 32;
      if (bLo >= 97 && bLo <= 122) {
        wH = ((wH * 257) ^ byte) & 0x7ffff;
        m.wH = wH;
        if (wLen < 12) wLen++;
      } else { wH = 0; wLen = 0; m.wH = 0; }
      m.prevByte = byte;
      m.c1 = byte;
      m.c2 = ((m.c2 * 257) ^ byte) & 0x1ffff;
      m.c3 = ((m.c3 * 131) ^ (byte * 7)) & 0x1ffff;
      m.c4 = ((m.c4 * 65) ^ (byte * 3)) & 0x3ffff;
      m.c6 = ((m.c6 * 33) ^ (byte * 5)) & 0x3ffff;
      m.c8 = ((m.c8 * 17) ^ (byte * 11)) & 0xfffff;
      m.c12 = ((m.c12 * 13) ^ (byte * 7)) & 0xfffff;
    };

    for (let i = 0; i < n; i++) feedByte(bytes[i], 1);

    const out = [];
    let stop = false;
    for (let k = 0; k < maxBytes && !stop; k++) {
      let prefix = 0, byte = 0;
      for (let i = 7; i >= 0; i--) {
        const r = feedBit(null, prefix, i, 0.5);
        byte = (byte << 1) | r.b;
        prefix = ((prefix << 1) | r.b) & 255;
      }
      out.push(byte);
      feedByte(byte, 0.5);
      if (stopMarks && out.length >= minBytes) {
        const tail = String.fromCharCode.apply(null, out.slice(-64));
        for (const sm of stopMarks) if (tail.includes(sm)) { stop = true; break; }
      }
    }
    const dec = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
    const text = dec ? dec.decode(new Uint8Array(out)) : out.map((c) => String.fromCharCode(c)).join("");
    return { text, bytes: out.length };
  }

  /* Entropie-Messung (8-Bit-Symbol, naiver Schaetzer — wie v2) */
  function entropyBits(data) {
    const cnt = new Uint32Array(256);
    for (let i = 0; i < data.length; i++) cnt[data[i]]++;
    let H = 0;
    const n = data.length || 1;
    for (let s = 0; s < 256; s++) {
      if (!cnt[s]) continue;
      const p = cnt[s] / n;
      H -= cnt[s] * Math.log2(p);
    }
    return H / n;
  }

  /* ================= Worker-Protokoll ================= */
  function handle(msg, post) {
    if (msg.cmd === "init") { post({ type: "ready", engine: wasmKern ? "wasm" : "js" }); return; }
    if (msg.cmd === "encode") {
      const data = new Uint8Array(msg.data);
      const r = encode(data, (frac) => post({ type: "progress", frac }));
      post({ type: "encoded", hyb: r.hyb.buffer, engine: r.wasm ? "wasm" : "js" }, [r.hyb.buffer]);
      return;
    }
    if (msg.cmd === "decode") {
      const hyb = new Uint8Array(msg.hyb);
      const r = decode(hyb, (frac) => post({ type: "progress", frac }));
      post({ type: "decoded", data: r.data.buffer, engine: r.wasm ? "wasm" : "js" }, [r.data.buffer]);
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
    /* WASM einmal laden, dann Befehle annehmen.  Der Ladevorgang ist
     * schnell (13 KB); danach steht der Kern fuer jede Datei bereit. */
    wasmLaden().then(() => {
      self.onmessage = (e) => {
        try { handle(e.data, (...a) => self.postMessage(...a)); }
        catch (err) { self.postMessage({ type: "error", message: String((err && err.message) || err) }); }
      };
    });
  }

  global.BitseedEngine = {
    encode: (data, onProgress) => encode(data, onProgress).hyb,
    decode: (hyb, onProgress) => decode(hyb, onProgress).data,
    encodeDetail: encode, decodeDetail: decode,
    generate, entropyBits, wasmLaden,
  };
})(typeof self !== "undefined" ? self : globalThis);
