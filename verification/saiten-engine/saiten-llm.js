// SaitenLLM — Browser-Port von Momos Saiten-Transformer (saite_kern.py).
// Wort-Ebene (V=8000), KV-Cache-Inkrementaldecodierung, Gewichte fp32 im Speicher
// (aus fp16 exportiert). Rechnet deterministisch; Sampling passiert im Worker.
//
// Bausteine (siehe ARCHITECTURE.md): Wort-Saite (geteilte Embeddings),
// Phasenbindung (RoPE), Kleinhirn-Fenster + Rinde-kausal pro Schicht,
// Thalamus-Gewichtung, Hippocampus-Zeiger mit gelernter lam-Mischung.
// fp16 → fp32 (IEEE 754 half precision)
function f16(z) {
    const s = (z & 0x8000) ? -1 : 1;
    const e = (z >> 10) & 0x1f;
    const m = z & 0x3ff;
    if (e === 0)
        return s * m * Math.pow(2, -24);
    if (e === 31)
        return m ? NaN : s * Infinity;
    return s * (1 + m / 1024) * Math.pow(2, e - 15);
}
export function gewichteEntpacken(buf, manifest) {
    const bytes = new Uint8Array(buf);
    const ansicht = new DataView(buf);
    const aus = new Map();
    // Binärdeckungsprüfung — jedes Byte der Gewichtedatei gehoert GENAU
    // EINEM Tensor.  Nicht "soweit lesbar", sondern belegt: gueltige
    // Shapes, Offset innerhalb der Datei, keine Ueberlappung, keine
    // Luecke von Byte 0 bis Dateiende, Skalen vollstaendig und ungleich
    // null.  Ein Manifest, das das nicht erfuellt, ist ein beschaedigter
    // Export — laden waere raten.  Also: hart abbrechen statt still
    // falsch zu entpacken.
    const laenge = bytes.length;
    const intervalle = [];
    for (const [name, t] of Object.entries(manifest.tensoren)) {
        if (!Array.isArray(t.shape) || !t.shape.length || t.shape.some(x => !Number.isInteger(x) || x <= 0))
            throw new Error(`gewichteEntpacken: ${name} hat keine gueltige shape (${JSON.stringify(t.shape)})`);
        const off = t.offset ?? t.offset32 ?? 0;
        if (!Number.isInteger(off) || off < 0)
            throw new Error(`gewichteEntpacken: ${name} hat keinen gueltigen Offset (${off})`);
        const n = t.shape.reduce((a, b) => a * b, 1);
        const span = t.int8 ? n : 2 * n;
        if (off + span > laenge)
            throw new Error(`gewichteEntpacken: ${name} laeuft ueber die Datei hinaus (offset ${off} + ${span} > ${laenge} Bytes)`);
        if (t.int8 && t.shape.length === 2) {
            // zeilenweise Skalen: Anzahl muss zur Zeilenzahl passen, jede
            // Skala muss eine endliche Zahl ungleich null sein — sonst
            // wird aus Quantelungsrauschen "Gewicht".
            if (!Array.isArray(t.skalen) || t.skalen.length !== t.shape[0])
                throw new Error(`gewichteEntpacken: ${name} braucht ${t.shape[0]} zeilenweise Skalen, hat ${Array.isArray(t.skalen) ? t.skalen.length : 0}`);
            for (let r = 0; r < t.skalen.length; r++) {
                const sk = t.skalen[r];
                if (!Number.isFinite(sk) || sk === 0)
                    throw new Error(`gewichteEntpacken: ${name} hat in Zeile ${r} eine ungueltige Skala (${sk})`);
            }
        }
        else if (t.int8 && t.skala !== undefined && (!Number.isFinite(t.skala) || t.skala === 0)) {
            throw new Error(`gewichteEntpacken: ${name} hat eine ungueltige Skala (${t.skala})`);
        }
        intervalle.push([off, off + span, name]);
    }
    // Deckung: sortiert muss jeder Tensor genau an der Cursor-Position
    // beginnen — Luecke wie Ueberlappung sind gleichermassen ein Fehler.
    intervalle.sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const [von, bis, name] of intervalle) {
        if (von < cursor)
            throw new Error(`gewichteEntpacken: ${name} ueberlappt den vorherigen Tensor (ab Byte ${von})`);
        if (von > cursor)
            throw new Error(`gewichteEntpacken: Luecke vor ${name} — Bytes ${cursor}..${von} gehoeren keinem Tensor`);
        cursor = bis;
    }
    if (cursor !== laenge)
        throw new Error(`gewichteEntpacken: ${laenge - cursor} Bytes am Dateiende gehoeren keinem Tensor`);
    for (const [name, t] of Object.entries(manifest.tensoren)) {
        const n = t.shape.reduce((a, b) => a * b, 1);
        const arr = new Float32Array(n);
        const off = t.offset ?? t.offset32 ?? 0;
        if (t.int8) {
            if (t.skalen && t.shape.length === 2) {
                // zeilenweise Skalen (pro Ausgabekanal)
                const cols = t.shape[1];
                for (let r = 0; r < t.shape[0]; r++) {
                    const sk = t.skalen[r];
                    const basis = r * cols;
                    for (let i = 0; i < cols; i++) {
                        const b = bytes[off + basis + i];
                        arr[basis + i] = (b > 127 ? b - 256 : b) * sk;
                    }
                }
            }
            else {
                const skala = t.skala ?? 1;
                for (let i = 0; i < n; i++) {
                    const b = bytes[off + i];
                    arr[i] = (b > 127 ? b - 256 : b) * skala;
                }
            }
        }
        else {
            // fp16-Rohlinge, 2 Bytes pro Wert
            for (let i = 0; i < n; i++)
                arr[i] = f16(ansicht.getUint16(off + 2 * i, true));
        }
        aus.set(name, arr);
    }
    return aus;
}
function layernorm(x, w, b, aus, D) {
    let mu = 0;
    for (let i = 0; i < D; i++)
        mu += x[i];
    mu /= D;
    let va = 0;
    for (let i = 0; i < D; i++) {
        const d = x[i] - mu;
        va += d * d;
    }
    const inv = 1 / Math.sqrt(va / D + 1e-5);
    for (let i = 0; i < D; i++)
        aus[i] = (x[i] - mu) * inv * w[i] + b[i];
}
function matvec(w, x, aus, rows, cols) {
    for (let o = 0; o < rows; o++) {
        let s = 0;
        const zeile = o * cols;
        for (let i = 0; i < cols; i++)
            s += w[zeile + i] * x[i];
        aus[o] = s;
    }
}
function gelu(x) {
    return 0.5 * x * (1 + erf(x / Math.SQRT2));
}
function erf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
    return x >= 0 ? y : -y;
}
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
export class SaitenLLM {
    constructor(cfg, g) {
        // KV-Cache je Schicht: [CTX, D] — kausal voll, Fenster wird beim Lesen begrenzt
        this.kC = [];
        this.vC = [];
        this.tokens = [];
        this.t = 0;
        this.cfg = cfg;
        const D = this.D = cfg.D;
        this.NH = cfg.NH;
        this.dk = D / cfg.NH;
        this.L = cfg.L;
        this.Dh = D / 2;
        this.E = g.get('wortsaite.weight');
        this.schichten = [];
        for (let l = 0; l < cfg.L; l++) {
            const p = `schichten.${l}.`;
            this.schichten.push({
                n1w: g.get(p + 'n1.weight'), n1b: g.get(p + 'n1.bias'),
                n2w: g.get(p + 'n2.weight'), n2b: g.get(p + 'n2.bias'),
                qkv: g.get(p + 'qkv.weight'), proj: g.get(p + 'proj.weight'),
                fc: g.get(p + 'fc.weight'), out: g.get(p + 'out.weight'),
                thalamus: g.get(p + 'thalamus'),
            });
            this.kC.push(new Float32Array(cfg.CTX * D));
            this.vC.push(new Float32Array(cfg.CTX * D));
        }
        this.hkC = new Float32Array(cfg.CTX * this.Dh);
        this.nfw = g.get('nf.weight');
        this.nfb = g.get('nf.bias');
        this.hq = g.get('hq.weight');
        this.hk = g.get('hk.weight');
        this.lamW = g.get('lamH.weight');
        this.lamB = g.get('lamH.bias')[0];
        // Scratch
        this.x = new Float32Array(D);
        this.h1 = new Float32Array(D);
        this.qkv = new Float32Array(3 * D);
        this.q = new Float32Array(D);
        this.k = new Float32Array(D);
        this.v = new Float32Array(D);
        this.y = new Float32Array(D);
        this.h2 = new Float32Array(D);
        this.gf = new Float32Array(4 * D);
        this.logits = new Float32Array(cfg.V);
        this.qh = new Float32Array(this.Dh);
        this.a = new Float32Array(cfg.CTX);
        this.cosT = new Float32Array(this.dk / 2);
        this.sinT = new Float32Array(this.dk / 2);
        this.reset();
    }
    reset() {
        this.t = 0;
        this.tokens = [];
    }
    rope(dreh, pos) {
        const dk = this.dk, NH = this.NH;
        if (this.cosT[0] === undefined || this._ropePos !== pos) {
            for (let i = 0; i < dk / 2; i++) {
                const f = 1 / Math.pow(10000, (2 * i) / dk);
                const w = pos * f;
                this.cosT[i] = Math.cos(w);
                this.sinT[i] = Math.sin(w);
            }
            ;
            this._ropePos = pos;
        }
        // Jeder Kopf besitzt einen eigenen dk-Slice — Rotation kopfweise anwenden
        for (let h = 0; h < NH; h++) {
            const basis = h * dk;
            for (let i = 0; i < dk / 2; i++) {
                const a = dreh[basis + 2 * i], b = dreh[basis + 2 * i + 1];
                const c = this.cosT[i], s = this.sinT[i];
                dreh[basis + 2 * i] = a * c - b * s;
                dreh[basis + 2 * i + 1] = a * s + b * c;
            }
        }
    }
    /** Ein Token einarbeiten → Verteilung fürs nächste. Füllt KV-Cache. */
    schritt(id) {
        const { D, NH, dk, L } = this;
        const pos = this.t;
        const x = this.x;
        x.set(this.E.subarray(id * D, id * D + D));
        for (let l = 0; l < L; l++) {
            const s = this.schichten[l];
            layernorm(x, s.n1w, s.n1b, this.h1, D);
            matvec(s.qkv, this.h1, this.qkv, 3 * D, D);
            // Kopf-Split: q/k/v je [NH, dk] — qkv zeilenmajor: q = [0,D), k = [D,2D), v = [2D,3D)
            for (let h = 0; h < NH; h++) {
                this.q.set(this.qkv.subarray(h * dk, h * dk + dk), h * dk);
                this.k.set(this.qkv.subarray(D + h * dk, D + h * dk + dk), h * dk);
                this.v.set(this.qkv.subarray(2 * D + h * dk, 2 * D + h * dk + dk), h * dk);
            }
            this.rope(this.q, pos);
            this.rope(this.k, pos);
            // Cache füllen
            this.kC[l].set(this.k, pos * D);
            this.vC[l].set(this.v, pos * D);
            // Attention: links=Fenster, rechts=kausal-voll
            const inv = 1 / Math.sqrt(dk);
            const kC = this.kC[l], vC = this.vC[l];
            for (let h = 0; h < NH; h++) {
                const qb = h * dk;
                const von = h < this.cfg.LINKS ? Math.max(0, pos - this.cfg.FENSTER + 1) : 0;
                // Scores
                let mx = -Infinity;
                for (let j = von; j <= pos; j++) {
                    let s2 = 0;
                    const kb = j * D + qb;
                    for (let i = 0; i < dk; i++)
                        s2 += this.q[qb + i] * kC[kb + i];
                    s2 *= inv;
                    this.a[j] = s2;
                    if (s2 > mx)
                        mx = s2;
                }
                let summe = 0;
                for (let j = von; j <= pos; j++) {
                    this.a[j] = Math.exp(this.a[j] - mx);
                    summe += this.a[j];
                }
                // y[h] = Σ a_j · v_j
                for (let i = 0; i < dk; i++)
                    this.y[qb + i] = 0;
                for (let j = von; j <= pos; j++) {
                    const aw = this.a[j] / summe;
                    const vb = j * D + qb;
                    for (let i = 0; i < dk; i++)
                        this.y[qb + i] += aw * vC[vb + i];
                }
            }
            // Thalamus
            for (let h = 0; h < NH; h++) {
                const g2 = 2 * sigmoid(s.thalamus[h]);
                const bb = h * dk;
                for (let i = 0; i < dk; i++)
                    this.y[bb + i] *= g2;
            }
            this.debug?.(-l - 1, this.y);
            // x += proj @ y
            for (let o = 0; o < D; o++) {
                let s3 = 0;
                const z3 = o * D;
                for (let i = 0; i < D; i++)
                    s3 += s.proj[z3 + i] * this.y[i];
                x[o] += s3;
            }
            layernorm(x, s.n2w, s.n2b, this.h2, D);
            matvec(s.fc, this.h2, this.gf, 4 * D, D);
            for (let i = 0; i < 4 * D; i++)
                this.gf[i] = gelu(this.gf[i]);
            for (let o = 0; o < D; o++) {
                let s4 = 0;
                const z4 = o * 4 * D;
                for (let i = 0; i < 4 * D; i++)
                    s4 += s.out[z4 + i] * this.gf[i];
                x[o] += s4;
            }
            this.debug?.(l, x);
        }
        // Kopf: LayerNorm → geteilte Saite (Logits) + Hippocampus
        layernorm(x, this.nfw, this.nfb, this.h1, D);
        for (let vv = 0; vv < this.cfg.V; vv++) {
            let s5 = 0;
            const z5 = vv * D;
            for (let i = 0; i < D; i++)
                s5 += this.E[z5 + i] * this.h1[i];
            this.logits[vv] = s5;
        }
        matvec(this.hq, this.h1, this.qh, this.Dh, D);
        // hk dieses Moments merken
        const hkZeile = new Float32Array(this.Dh);
        matvec(this.hk, this.h1, hkZeile, this.Dh, D);
        this.hkC.set(hkZeile, pos * this.Dh);
        // Zeiger-Gewichte über alle bisherigen Positionen
        const invH = 1 / Math.sqrt(this.Dh);
        let mxH = -Infinity;
        for (let j = 0; j <= pos; j++) {
            let s6 = 0;
            const zb = j * this.Dh;
            for (let i = 0; i < this.Dh; i++)
                s6 += this.qh[i] * this.hkC[zb + i];
            s6 *= invH;
            this.a[j] = s6;
            if (s6 > mxH)
                mxH = s6;
        }
        let summeH = 0;
        for (let j = 0; j <= pos; j++) {
            this.a[j] = Math.exp(this.a[j] - mxH);
            summeH += this.a[j];
        }
        this.tokens.push(id);
        this.t = pos + 1;
        return this.mische(summeH);
    }
    /** p = (1−lam)·softmax(Logits) + lam·Zeiger — verteilung() aus saite_kern.py */
    mische(summeH) {
        const p = new Float32Array(this.cfg.V);
        let mx = -Infinity;
        for (let vv = 0; vv < this.cfg.V; vv++)
            if (this.logits[vv] > mx)
                mx = this.logits[vv];
        let summe = 0;
        for (let vv = 0; vv < this.cfg.V; vv++) {
            const e = Math.exp(this.logits[vv] - mx);
            p[vv] = e;
            summe += e;
        }
        const lam = sigmoid(this.lamW.reduce((acc, w, i) => acc + w * this.h1[i], this.lamB * 0) + this.lamB);
        const rl = 1 - lam;
        for (let vv = 0; vv < this.cfg.V; vv++)
            p[vv] = (p[vv] / summe) * rl;
        for (let j = 0; j < this.t; j++)
            p[this.tokens[j]] += lam * (this.a[j] / summeH);
        return p;
    }
}
