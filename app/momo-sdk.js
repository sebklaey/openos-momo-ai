/*! Momo AI SDK v2.0.0 — lokal-first, ohne Key, ohne zentralen Server.
 *
 * Das Versprechen dieses SDK, in einem Satz: Es sendet nichts an niemanden.
 * Es lädt die offiziellen Module von https://openos.kimi.page und rechnet
 * Kompression, Dekompression und Chat vollständig auf dem Gerät des
 * Aufrufers — dieselbe Engine, dieselben Gewichte, dieselbe Logik wie in
 * der App selbst. Kein API-Key, kein Bearer-Token, kein Telemetrie-Rückkanal,
 * kein stiller Dienst im Hintergrund.
 *
 * Verifikation ist besser als Vertrauen: die geladenen Module sind dieselben
 * Dateien, deren sha256-Fingerabdrücke in der llms.txt der offiziellen URL
 * stehen (https://openos.kimi.page/llms.txt), und jede Dekompression kann
 * gegen den sha256 der Kompression geprüft werden.
 *
 * Browser + Node.js 18+. Lizenz: wie die App — frei nutzbar, Quelltext offen.
 *
 * Verwendung:
 *   const momo = await MomoAI.create();
 *   const c = await momo.compress(bytes);              // → { archive, ratio, sha256, ... }
 *   const r = await momo.decompress(c.archive);        // bit-exakt, sha256 prüfbar
 *   const a = await momo.chat("Was bist du?");         // lädt 148M-Modell (142 MB) einmalig
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MomoAI = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const VERSION = "2.0.0";
  const OFFIZIELLE_URL = "https://openos.kimi.page/";

  /* Gewichte: öffentlicher Lese-Bucket, CORS offen (access-control-allow-origin: *).
   * Dieselbe Quelle, die die App-Engine nutzt. Überschreibbar über options.gewichte. */
  const GEWICHTE_BASIS = "https://rivudmparhyqvtgcboxw.supabase.co/storage/v1/object/public/saiten-gewichte/";
  const GEWICHTE = {
    manifest: GEWICHTE_BASIS + "momo-llm.json?v=saiten148m-s7",
    vocab: GEWICHTE_BASIS + "momo-vocab.json?v=saiten148m-s7",
    teile: [0, 1, 2, 3, 4].map((i) => GEWICHTE_BASIS + "momo-llm.bin.part" + i + "?v=saiten148m-s7"),
  };

  const isNode = typeof process !== "undefined" && !!(process.versions && process.versions.node);

  /* ── Hilfen ─────────────────────────────────────────────────── */
  const bytesToBase64 = (bytes) => {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof Buffer !== "undefined") return Buffer.from(u8).toString("base64");
    let bin = "";
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  const base64ToBytes = (b64) => {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(String(b64 || ""), "base64"));
    const bin = atob(String(b64 || ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const toBytes = (value) => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === "string") return base64ToBytes(value);
    throw new TypeError("Erwarte Uint8Array, ArrayBuffer oder Base64-String.");
  };
  async function sha256Hex(buf) {
    const hash = await crypto.subtle.digest("SHA-256", buf instanceof Uint8Array ? buf : new Uint8Array(buf));
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /* Engine-Skript laden (stellt globalThis.BitseedEngine bereit). */
  async function engineLaden(basis) {
    if (typeof globalThis.BitseedEngine !== "undefined") return globalThis.BitseedEngine;
    const url = basis + "/kompression/assets/bitseed-engine.js";
    if (!isNode && typeof document !== "undefined") {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error("Engine konnte nicht geladen werden: " + url));
        (document.head || document.documentElement).appendChild(s);
      });
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error("Engine-Download fehlgeschlagen: HTTP " + res.status + " (" + url + ")");
      (0, eval)(await res.text()); // globaler Kontext → globalThis.BitseedEngine
    }
    if (typeof globalThis.BitseedEngine === "undefined") throw new Error("BitseedEngine nach dem Laden nicht gefunden.");
    return globalThis.BitseedEngine;
  }

  /* ES-Modul cross-env laden (Browser: direkt; Node: per data:-URL). */
  async function modulLaden(url) {
    if (!isNode) return import(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error("Download fehlgeschlagen: HTTP " + res.status + " (" + url + ")");
    const quelltext = await res.text();
    return import("data:text/javascript;base64," + Buffer.from(quelltext, "utf8").toString("base64"));
  }

  async function jsonLaden(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Download fehlgeschlagen: HTTP " + res.status + " (" + url + ")");
    return res.json();
  }
  async function teileLaden(urls, onFortschritt) {
    let fertig = 0;
    return Promise.all(urls.map((u) => fetch(u).then(async (res) => {
      if (!res.ok) throw new Error("Gewichts-Teil fehlgeschlagen: HTTP " + res.status);
      const buf = await res.arrayBuffer();
      fertig++;
      if (onFortschritt) onFortschritt(fertig / urls.length);
      return buf;
    })));
  }

  /* Top-k + Temperatur-Sampling — identisch zum Trainings-Code und zum Browser-Worker,
   * plus Wiederholungsstrafe: Tokens der letzten ~50 Schritte um Faktor `strafe` abwerten. */
  function sample(p, temperatur, topK, strafeIds, strafe) {
    const V = p.length;
    const idx = new Uint32Array(V);
    for (let i = 0; i < V; i++) idx[i] = i;
    const k = Math.min(topK, V);
    for (let i = 0; i < k; i++) {
      let best = i;
      for (let j = i + 1; j < V; j++) if (p[idx[j]] > p[idx[best]]) best = j;
      if (best !== i) { const t = idx[i]; idx[i] = idx[best]; idx[best] = t; }
    }
    const gewichte = new Float64Array(k);
    let summe = 0;
    const f = strafe || 1;
    for (let i = 0; i < k; i++) { const q = p[idx[i]] / (strafeIds && strafeIds.has(idx[i]) ? f : 1); const w = Math.pow(q, 1 / temperatur); gewichte[i] = w; summe += w; }
    let z = Math.random() * summe;
    for (let i = 0; i < k; i++) { z -= gewichte[i]; if (z <= 0) return idx[i]; }
    return idx[k - 1];
  }

  async function create(options = {}) {
    const basis = String(options.basis || OFFIZIELLE_URL).replace(/\/+$/, "");
    const Engine = await engineLaden(basis);
    if (typeof Engine.wasmLaden === "function") await Engine.wasmLaden();

    let inferenz = null; // { llm, vok, tok } — einmalig, dann im Speicher gehalten
    const sessions = new Map();

    async function chatVorbereiten() {
      if (inferenz) return inferenz;
      const gew = options.gewichte || GEWICHTE;
      const [llmMod, tokMod, manifest, vocabRoh, teile] = await Promise.all([
        modulLaden(basis + "/momo/saiten-engine/saiten-llm.js"),
        modulLaden(basis + "/momo/saiten-engine/tokenizer.js"),
        jsonLaden(gew.manifest),
        jsonLaden(gew.vocab),
        teileLaden(gew.teile, options.onProgress),
      ]);
      const gesamt = teile.reduce((a, t) => a + t.byteLength, 0);
      const bin = new Uint8Array(gesamt);
      let off = 0;
      for (const t of teile) { bin.set(new Uint8Array(t), off); off += t.byteLength; }
      const gewichte = llmMod.gewichteEntpacken(bin.buffer, manifest);
      inferenz = { llm: new llmMod.SaitenLLM(manifest.konfig, gewichte), vok: tokMod.vokabularLaden(vocabRoh), tok: tokMod };
      return inferenz;
    }

    return {
      version: VERSION,
      offizielleUrl: OFFIZIELLE_URL,
      basis,

      /* Verlustfreie Kompression (Bitseed Engine v4, on-device). */
      async compress(data, opts = {}) {
        const bytes = toBytes(data);
        const detail = await Engine.encodeDetail(bytes, opts.onProgress);
        const archive = detail.hyb instanceof Uint8Array ? detail.hyb : new Uint8Array(detail.hyb);
        return {
          archive,
          archiveBase64: bytesToBase64(archive),
          bytes: bytes.byteLength,
          archiveBytes: archive.byteLength,
          ratio: bytes.byteLength ? archive.byteLength / bytes.byteLength : 0,
          sha256: await sha256Hex(bytes),
          engine: detail.wasm ? "wasm" : "js",
        };
      },

      /* Dekompression — bit-exakt; Ergebnis trägt sha256 zum Abgleich mit compress(). */
      async decompress(archive, opts = {}) {
        const bytes = toBytes(archive);
        const detail = await Engine.decodeDetail(bytes, opts.onProgress);
        const data = detail.data instanceof Uint8Array ? detail.data : new Uint8Array(detail.data);
        return {
          data,
          dataBase64: bytesToBase64(data),
          bytes: data.byteLength,
          sha256: await sha256Hex(data),
          engine: detail.wasm ? "wasm" : "js",
        };
      },

      /* Entropie-Schätzung in Bits/Byte — ohne zu komprimieren. */
      entropyBits(data) {
        return Engine.entropyBits(toBytes(data));
      },

      /* Chat mit Saiten-148M (148M Parameter, de+en) — einmalig ~142 MB Gewichte laden. */
      async chat(text, opts = {}) {
        const { llm, vok, tok } = await chatVorbereiten();
        const key = String(opts.key || "main");
        const verlauf = sessions.get(key) || [];
        verlauf.push({ rolle: "DU", text: String(text || "") });

        const zeilen = verlauf.map((m) => m.rolle + ": " + m.text);
        zeilen.push("MOMO:");
        const ctx = llm.cfg.CTX - 1;
        const ids = tok.encodiere(vok, zeilen.join("\n"));
        const promptIds = ids.length > ctx ? ids.slice(ids.length - ctx) : ids;

        const temperatur = opts.temperature > 0 ? Math.min(1, opts.temperature) : 0.6;
        const maxTokens = Math.min(160, Math.max(40, Math.round((opts.maxBytes || 260) / 1.6)));

        llm.reset();
        const dekodZustand = { dec: new TextDecoder("utf-8", { fatal: false }) };
        let generiert = 0, naechste = -1, ausgabe = "";
        const zuletzt = []; // letzte ~50 generierte Token-IDs (Wiederholungsstrafe)
        for (let n = 0; ; n++) {
          const pid = n < promptIds.length ? promptIds[n] : naechste;
          const p = llm.schritt(pid);
          if (n < promptIds.length - 1) continue;
          const id2 = sample(p, temperatur, 15, new Set(zuletzt), 1.15);
          const stueck = tok.decodiere(vok, [id2], false, dekodZustand);
          if (id2 === vok.ende || generiert >= maxTokens) break;
          if (stueck.includes("\n")) break;
          if (/^\s*DU\s*:/.test(stueck)) break;
          if (generiert > 2 && /\bDU\s*:/.test(ausgabe + stueck)) break;
          // Stopp beim Echo einer neuen MOMO:-Runde (Modell zitiert Korpus-Dialoge)
          if (/^\s*MOMO\s*:/.test(stueck)) break;
          if (generiert > 2 && /\bMOMO\s*:/.test(ausgabe + stueck)) break;
          generiert++;
          ausgabe += stueck;
          zuletzt.push(id2);
          if (zuletzt.length > 50) zuletzt.shift();
          // Wiederholungswächter — identisch zum Browser-Worker
          if (generiert >= 4) {
            const w = ausgabe.trim().split(/\s+/);
            const l4 = w.slice(-4);
            if (l4.length === 4 && l4.every((x) => x === l4[0])) break;
          }
          if (generiert > 8 && ausgabe.length >= 36) {
            const e = ausgabe.slice(-12);
            if (e === ausgabe.slice(-24, -12) && e === ausgabe.slice(-36, -24)) break;
          }
          if (generiert > 18 && ausgabe.length >= 90) {
            const e = ausgabe.slice(-30);
            if (e === ausgabe.slice(-60, -30) && e === ausgabe.slice(-90, -60)) break;
          }
          if (opts.onToken) await opts.onToken(stueck);
          naechste = id2;
          if (generiert % 8 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        ausgabe += tok.flusheDecodiere(dekodZustand);
        ausgabe = ausgabe.replace(/<\|ende\|>/g, "").trim();
        // Auf vollständigen Satz zurückschneiden — identisch zum Browser-Worker.
        if (ausgabe && !/[.!?…]\s*["'»”’)\]]*$/.test(ausgabe)) {
          const cut = ausgabe.match(/^(.*[.!?…]["'»”’)\]]*)/s);
          if (cut && cut[1].trim().length >= Math.max(12, ausgabe.length * 0.35)) {
            ausgabe = cut[1].trim();
          } else {
            ausgabe = ausgabe.replace(/[\s"'«»„“;:,–—-]+$/, "").trim();
          }
        }
        if (ausgabe) verlauf.push({ rolle: "MOMO", text: ausgabe });
        sessions.set(key, verlauf.slice(-16));
        return { text: ausgabe, stats: { tokens: generiert, modell: "saiten-148m" } };
      },
    };
  }

  return { create, VERSION, OFFIZIELLE_URL };
});
