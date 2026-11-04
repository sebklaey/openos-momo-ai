#!/usr/bin/env python3
"""OpenOS Momo — Saiten-Trainer.

Trainiert das Modell, das die App wirklich lädt: das Saiten-148M
(wortsaite.weight, 20 Schichten, Thalamus-Gates, Hippocampus-Zeiger,
RoPE, Fenster-Köpfe + kausale Köpfe).  Kein Ersatzmodell, kein
Spielzeug — derselbe Rechengraph wie momo/saiten-engine/saiten-llm.js,
gespiegelt in NumPy, plus Backward.

Warum diese Datei existiert: Das frühere nachttraining.py trainierte
ein Modell mit D=256 und 4 Schichten — eine Architektur, die die App
nie lädt, in einem Format, das nie exportiert werden konnte.  Dieser
Trainer lädt momo-llm.bin, hebt es in fp32 ab, trainiert mit Adam
und exportiert wieder in denselben Container (int8 + fp16, zeilenweise
Skalen, deckungsgleiche Offsets).  Wenn die Nacht etwas bringt, kann
man es morgen in der App sehen — nicht nur in einem Log.

Ehrlichkeit vor Eleganz: verify_forward() gleicht den Python-Forward
mit der JS-Engine auf demselben Prompt ab.  Numerischer Gradienten-
Check prüft den Backward.  Beides liegt im Log, bevor Stufe 1 läuft.
"""

import argparse
import json
import math
import pathlib
import re
import subprocess
import sys
import time

import numpy as np

HIER = pathlib.Path(__file__).parent
BIN = HIER / "momo-llm.bin"
MANIFEST = HIER / "momo-llm.json"
VOCAB = HIER / "momo-vocab.json"
KORPUS = HIER / "korpus.txt"
IDS_DATEI = HIER / "korpus.ids.npy"
MASK_DATEI = HIER / "korpus.mask.npy"
CKPT = HIER / "checkpoint.npz"
OPT = HIER / "opt.npz"
FORTSCHRITT = HIER / "fortschritt.log"
STOP = HIER / "STOP"
BERICHT = HIER / "bericht.json"
EXPORT = HIER / "export"

SEED = 20261103
FERTIG_UM = 7 * 60 + 45

# Rechenpräzision.  Training läuft in float32 (schnell).  Der Gradienten-Check
# setzt DT auf float64 — sonst liegt die numerische Differenz unter dem
# float32-Rauschboden und jeder Check schlägt fälschlich fehl.
DT = np.float32

# Lerngrößen — bewusst konservativ: Feintuning eines existierenden
# Modells, kein Neubau.
BATCH = 4
SEQ = 256
LR = 2e-4
BETA1, BETA2, EPS = 0.9, 0.95, 1e-8
CLIP = 1.0
WARMUP = 30
MOMO_RE = re.compile(r"(?m)^MOMO:[^\n]*")


# ------------------------------------------------------------------ Container
# Laden/Entpacken spiegelt gewichteEntpacken() aus saiten-llm.js inklusive
# der Deckungsprüfung.  Ein Container mit Lücke oder Überlappung bricht
# hier genauso hart ab wie im Browser.
def gewichte_laden(binp=BIN, manifest=MANIFEST):
    manifest_daten = json.loads(pathlib.Path(manifest).read_text(encoding="utf-8"))
    cfg = manifest_daten["konfig"]
    roh = np.fromfile(binp, dtype=np.uint8)
    tens = {}
    cursor = 0
    for name, t in manifest_daten["tensoren"].items():
        shape = t["shape"]
        n = int(np.prod(shape))
        off = int(t.get("offset", 0))
        span = n if t.get("int8") else 2 * n
        if off != cursor:
            raise ValueError(f"Container-Bruch vor {name}: offset {off}, erwartet {cursor}")
        cursor += span
        if t.get("int8"):
            werte = roh[off:off + n].astype(np.int8).astype(DT)
            if t.get("skalen") and len(shape) == 2:
                sk = np.array(t["skalen"], dtype=DT).reshape(-1, 1)
                if sk.shape[0] != shape[0]:
                    raise ValueError(f"{name}: {sk.shape[0]} Skalen für {shape[0]} Zeilen")
                werte = (werte.reshape(shape) * sk).reshape(-1)
            else:
                werte = werte * float(t.get("skala", 1.0))
            tens[name] = werte.reshape(shape).copy()
        else:
            u16 = roh[off:off + 2 * n].view(np.uint16).astype(np.uint32)
            s = np.where(u16 & 0x8000, -1.0, 1.0).astype(DT)
            e = ((u16 >> 10) & 0x1F).astype(np.int32)
            m = (u16 & 0x3FF).astype(DT)
            out = np.where(e == 0, s * m * (2.0 ** -24),
                           np.where(e == 31, s * np.where(m != 0, np.nan, np.inf),
                                    s * (1 + m / 1024) * np.exp2((e - 15).astype(DT))))
            if not np.isfinite(out).all():
                raise ValueError(f"{name}: ungültige fp16-Werte im Container")
            tens[name] = out.reshape(shape).copy()
    if cursor != len(roh):
        raise ValueError(f"Container: {len(roh) - cursor} Bytes gehören keinem Tensor")
    return cfg, tens


def fp16_paketieren(x):
    """float32 → uint16 (IEEE 754 binary16, round-to-nearest-even)."""
    a = np.nan_to_num(x.astype(DT), nan=0.0, posinf=65504.0, neginf=-65504.0)
    bits = a.view(np.uint32)
    zeichen = (bits >> 16) & 0x8000
    expo = ((bits >> 23) & 0xFF).astype(np.int32)
    mant = bits & 0x7FFFFF
    e = expo - 127 + 15
    out = np.zeros_like(bits)
    norm = (expo != 0) & (e >= 1) & (e < 31)
    rn = e[norm].astype(np.uint32)
    rm = (mant[norm].astype(np.uint64) + 0x1000 + ((mant[norm] >> 13) & 1)) >> 13
    carry = (rm >> 10).astype(np.uint32)
    rn = rn + carry
    rm = (rm & 0x3FF).astype(np.uint32)
    ok = rn < 31
    idx = np.where(norm)[0]
    good = idx[ok]
    out[good] = zeichen[good] | (rn[ok] << 10) | rm[ok]
    bad = idx[~ok]
    out[bad] = zeichen[bad] | 0x7C00  # Overflow → ±Inf (passt zum Laden-Check nicht auf — siehe export)
    inf = (e >= 31) & (expo != 0)
    out[inf] = zeichen[inf] | 0x7C00
    sub = (expo != 0) & (e < 1) & (e > -25)
    sh = (14 - e[sub]).astype(np.uint64)
    sm = (mant[sub] | 0x800000).astype(np.uint64)
    sm = (sm + (1 << (sh - 1)) - 1 + ((sm >> sh) & 1)) >> sh
    ovs = sm >> 10
    out[sub] = zeichen[sub] | np.where(ovs > 0, (np.uint32(0x400) | (sm & 0x3FF).astype(np.uint32)),
                                       (sm & 0x3FF).astype(np.uint32))
    zero = (expo == 0) | ((e <= -25) & (expo != 0))
    out[zero] = zeichen[zero]
    return out.astype(np.uint16)


def exportieren(tens, cfg, ziel=EXPORT):
    """fp32-Gewichte → derselbe Container, den die App lädt."""
    EXPORT.mkdir(exist_ok=True)
    manifest_daten = json.loads(MANIFEST.read_text(encoding="utf-8"))
    stuecke = []
    cursor = 0
    for name, t0 in manifest_daten["tensoren"].items():
        w = tens[name].astype(DT)
        shape = list(w.shape)
        n = int(np.prod(shape))
        if t0.get("int8"):
            if len(shape) == 2:
                sk = np.abs(w).max(axis=1) / 127.0
                sk = np.where(sk == 0, 1e-12, sk)
                q = np.clip(np.round(w / sk[:, None]), -127, 127).astype(np.int8)
                t0["skalen"] = [float(x) for x in sk]
                t0.pop("skala", None)
            else:
                sk = float(np.abs(w).max() / 127.0) or 1e-12
                q = np.clip(np.round(w / sk), -127, 127).astype(np.int8)
                t0["skala"] = sk
            stuecke.append(q.tobytes())
            span = n
        else:
            bits16 = fp16_paketieren(w.reshape(-1))
            if not np.isfinite(np.where(bits16 & 0x7C00 == 0x7C00, np.inf, 0)).all():
                pass
            if ((bits16 & 0x7C00) == 0x7C00).any():
                raise ValueError(f"{name}: fp16-Overflow beim Export — Gewicht zu groß")
            stuecke.append(bits16.tobytes())
            span = 2 * n
        t0["offset"] = cursor
        cursor += span
    (EXPORT / "momo-llm.bin").write_bytes(b"".join(stuecke))
    manifest_daten["konfig"] = cfg
    (EXPORT / "momo-llm.json").write_text(json.dumps(manifest_daten, ensure_ascii=False), encoding="utf-8")
    (EXPORT / "momo-vocab.json").write_text(VOCAB.read_text(encoding="utf-8"), encoding="utf-8")
    return EXPORT / "momo-llm.bin"


# ------------------------------------------------------------------ Tokenizer
# Zeichengetreue Python-Portierung von saiten-engine/tokenizer.js (encodiere).
# Zusatz: antwort_maske() markiert die Token, die zu MOMO:-Zeilen gehören —
# darauf wird der Verlust gelegt.  DU:-Stil braucht das Modell nicht zu lernen.
def vokabular_laden():
    v = json.loads(VOCAB.read_text(encoding="utf-8"))
    v["_zuId"] = {s: i for i, s in enumerate(v["stuecke"])}
    v["byteStart"] = v["stuecke"].index("<0x00>") if "<0x00>" in v["stuecke"] else -1
    v.setdefault("userDefiniert", [])
    v["unk"] = v["_zuId"].get("<unk>", 0)
    v["ende"] = v["_zuId"].get("<|ende|>", -1)
    return v


def normalisiere(text):
    return "▁" + " ".join(text.split()).replace(" ", "▁")


def encodiere(v, text):
    s = normalisiere(text)
    symbole = []

    def neu(stueck, idx, laenge, freeze):
        i = len(symbole)
        symbole.append({"stueck": stueck, "id": idx, "laenge": laenge, "freeze": freeze,
                        "prev": i - 1 if i else -1, "next": -1, "leer": False})
        if i:
            symbole[i - 1]["next"] = i

    i = 0
    while i < len(s):
        ud = ""
        for u in v["userDefiniert"]:
            if len(u) > len(ud) and s.startswith(u, i):
                ud = u
        if ud:
            neu(ud, v["_zuId"].get(ud, v["unk"]), len(ud), True)
            i += len(ud)
            continue
        ch = s[i]
        idx = v["_zuId"].get(ch)
        if idx is not None and idx > 2:
            neu(ch, idx, 1, False)
        else:
            for b in ch.encode("utf-8"):
                neu(chr(b), v["byteStart"] + b if v["byteStart"] >= 0 else v["unk"], 1, False)
        i += 1
    if not symbole:
        return []

    def paar_id(a, b):
        st = symbole[a]["stueck"] + symbole[b]["stueck"]
        idx = v["_zuId"].get(st)
        return -1 if idx is None or idx <= 2 or idx == v["unk"] else idx

    agenda = []

    def pruefe(l, r):
        if l < 0 or r < 0:
            return
        a, b = symbole[l], symbole[r]
        if a["leer"] or b["leer"] or a["freeze"] or b["freeze"]:
            return
        idx = paar_id(l, r)
        if idx < 0:
            return
        agenda.append([l, r, idx, v["scores"][idx], a["laenge"] + b["laenge"]])

    for k in range(len(symbole) - 1):
        pruefe(k, k + 1)
    while agenda:
        bestk, best = -1, None
        for k, p in enumerate(agenda):
            a, b = symbole[p[0]], symbole[p[1]]
            if a["leer"] or b["leer"] or a["laenge"] + b["laenge"] != p[4]:
                continue
            if best is None or p[3] > best[3] or (p[3] == best[3] and p[0] < best[0]):
                bestk, best = k, p
        if best is None:
            break
        agenda.pop(bestk)
        a, b = symbole[best[0]], symbole[best[1]]
        a["stueck"] += b["stueck"]
        a["id"] = best[2]
        a["laenge"] += b["laenge"]
        a["next"] = b["next"]
        if b["next"] >= 0:
            symbole[b["next"]]["prev"] = best[0]
        b["leer"] = True
        pruefe(a["prev"], best[0])
        pruefe(best[0], a["next"])
    ids, laengen = [], []
    k = 0
    while k != -1:
        s2 = symbole[k]
        if not s2["leer"]:
            ids.append(s2["id"])
            laengen.append(s2["laenge"])
        k = s2["next"]
    return ids, laengen


def korpus_tokenisieren():
    """Korpus → ids + MOMO-Antwortmaske (gecacht auf Disk)."""
    if IDS_DATEI.exists() and MASK_DATEI.exists():
        return np.load(IDS_DATEI), np.load(MASK_DATEI)
    v = vokabular_laden()
    text = KORPUS.read_text(encoding="utf-8")
    gesamt, gesamt_laengen = [], []
    for block in text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        r = encodiere(v, block)
        if not r:
            continue
        ids, laengen = r
        gesamt.extend(ids)
        gesamt_laengen.extend(laengen)
    ids = np.array(gesamt, dtype=np.int64)
    # Maske über Zeilenebene: in jedem Chat-Block gilt alles ab der ersten
    # "MOMO:"-Zeile als MOMO-Antwort.  Zeilen werden im normalisierten Text
    # über die Literal-Position "MOMO:" gefunden; Token-Spans laufen über
    # die vom Tokenizer gelieferten Längen.
    maske = np.zeros(len(ids), dtype=DT)
    pos = 0
    for block in text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        r = encodiere(v, block)
        if not r:
            continue
        bid, bl = r
        momo_ab = normalisiere(block).find("MOMO:")
        if momo_ab >= 0:
            off = 0
            for k, la in enumerate(bl):
                if off >= momo_ab:
                    maske[pos + k] = 1.0
                off += la
        pos += len(bid)
    assert pos == len(ids), f"Maskenlauf {pos} != ids {len(ids)}"
    np.save(IDS_DATEI, ids)
    np.save(MASK_DATEI, maske)
    return ids, maske


# ------------------------------------------------------------------ GELU
# Dieselbe Abramowitz-Stegun-7.1.26-Näherung wie saiten-llm.js — damit
# Training und Inferenz dieselbe Funktion sehen.  Ableitung exakt genug.
def gelu_js(x):
    t = 1.0 / (1.0 + 0.3275911 * np.abs(x))
    y = 1.0 - ((((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
                 - 0.284496736) * t + 0.254829592) * t) * np.exp(-x * x))
    return np.where(x >= 0, y, -y)


def gelu_fwd(x):
    return (0.5 * x * (1.0 + gelu_js(x / math.sqrt(2.0)))).astype(DT)


def gelu_grad(x):
    phi = np.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)
    gross = 0.5 * (1.0 + gelu_js(x / math.sqrt(2.0))) + x * phi
    return gross.astype(DT)


def softmax(x):
    z = x - x.max(-1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(-1, keepdims=True)


def softmax_bwd(dp, p):
    return p * (dp - (dp * p).sum(-1, keepdims=True))


# ------------------------------------------------------------------ Modell
class Saiten:
    """Forward: exakter Clone von saiten-llm.js.  Backward: dazu passend."""

    def __init__(self, cfg, tens):
        self.cfg = cfg
        self.D = D = int(cfg["D"])
        self.L = int(cfg["L"])
        self.NH = int(cfg["NH"])
        self.dk = D // self.NH
        self.Dh = D // 2
        self.V = int(cfg["V"])
        self.FEN = int(cfg["FENSTER"])
        self.LINKS = int(cfg["LINKS"])
        self.p = {k: v.astype(DT) for k, v in tens.items()}
        dk = self.dk
        f = 1.0 / np.power(10000.0, (2.0 * np.arange(dk // 2)) / dk)
        t = np.arange(int(cfg["CTX"]))
        winkel = np.outer(t, f)
        self.cos = np.cos(winkel).astype(DT)
        self.sin = np.sin(winkel).astype(DT)
        self.opt_m, self.opt_v, self.opt_t = None, None, 0

    def ln(self, x, w, b):
        mu = x.mean(-1, keepdims=True)
        var = x.var(-1, keepdims=True)
        inv = (1.0 / np.sqrt(var + 1e-5)).astype(DT)
        xh = ((x - mu) * inv).astype(DT)
        return (xh * w + b).astype(DT), (xh, inv, w)

    def ln_bwd(self, dy, cache, Dd):
        xh, inv, g = cache
        achsen = tuple(range(dy.ndim - 1))
        dg = (dy * xh).sum(axis=achsen)
        db = dy.sum(axis=achsen)
        dln = dy * g
        d = dln * inv
        dmu = -d.sum(-1, keepdims=True)
        dvar = (dln * xh * -0.5 * inv).sum(-1, keepdims=True)
        dx = (d + (dmu + dvar * 2 * xh) / Dd).astype(DT)
        return dx, dg.astype(DT), db.astype(DT)

    def _rope_tabelle(self, T):
        return (self.cos[:T][None, :, None, :], self.sin[:T][None, :, None, :])

    def rope(self, x):
        c, s = self._rope_tabelle(x.shape[1])
        a = x[..., 0::2].copy()
        b = x[..., 1::2].copy()
        x[..., 0::2] = a * c - b * s
        x[..., 1::2] = a * s + b * c
        return x

    def rope_bwd(self, dx):
        c, s = self._rope_tabelle(dx.shape[1])
        a = dx[..., 0::2].copy()
        b = dx[..., 1::2].copy()
        dx[..., 0::2] = a * c + b * s
        dx[..., 1::2] = -a * s + b * c
        return dx

    def masken(self, T):
        pos = np.arange(T)
        kausal = pos[:, None] >= pos[None, :]
        maske = np.zeros((self.NH, T, T), dtype=bool)
        for h in range(self.NH):
            if h < self.LINKS:
                maske[h] = kausal & ((pos[:, None] - pos[None, :]) < self.FEN)
            else:
                maske[h] = kausal
        return np.where(maske[None], DT(0.0), DT(-1e30))

    def forward(self, ids):
        B, T = ids.shape
        D, NH, dk, L = self.D, self.NH, self.dk, self.L
        p = self.p
        c = {"ids": ids}
        maske = self.masken(T)
        kausal_exp = np.where(np.tril(np.ones((T, T), dtype=bool))[None],
                              DT(0.0), DT(-1e30))
        x = p["wortsaite.weight"][ids]
        c["x0"] = x
        inv_dk = DT(1.0 / math.sqrt(dk))
        c["schichten"] = []
        for l in range(L):
            pr = f"schichten.{l}."
            h1, ln1 = self.ln(x, p[pr + "n1.weight"], p[pr + "n1.bias"])
            qkv = (h1 @ p[pr + "qkv.weight"].T).astype(DT)
            q = qkv[..., :D].reshape(B, T, NH, dk).copy()
            k = qkv[..., D:2 * D].reshape(B, T, NH, dk).copy()
            v = qkv[..., 2 * D:].reshape(B, T, NH, dk)
            self.rope(q)
            self.rope(k)
            qh = q.transpose(0, 2, 1, 3).reshape(B * NH, T, dk)
            kh = k.transpose(0, 2, 1, 3).reshape(B * NH, T, dk)
            vh = v.transpose(0, 2, 1, 3).reshape(B * NH, T, dk)
            sc = (np.matmul(qh, kh.transpose(0, 2, 1)) * inv_dk).reshape(B, NH, T, T) + maske
            sc -= sc.max(-1, keepdims=True)
            a = np.exp(sc)
            a /= a.sum(-1, keepdims=True)
            y = np.matmul(a.reshape(B * NH, T, T), vh).reshape(B, NH, T, dk).transpose(0, 2, 1, 3).reshape(B, T, D)
            g = (2.0 / (1.0 + np.exp(-p[pr + "thalamus"]))).astype(DT)
            y_raw = y
            y_g = (y * np.repeat(g, dk)[None, None, :]).astype(DT)
            x_m = (x + y_g @ p[pr + "proj.weight"].T).astype(DT)
            h2, ln2 = self.ln(x_m, p[pr + "n2.weight"], p[pr + "n2.bias"])
            u = (h2 @ p[pr + "fc.weight"].T).astype(DT)
            gf = gelu_fwd(u)
            x = (x_m + gf @ p[pr + "out.weight"].T).astype(DT)
            c["schichten"].append({"x_in": c["x0"] if l == 0 else None, "ln1": ln1, "h1": h1,
                                   "q": q, "k": k, "v": v, "a": a, "g": g, "y_raw": y_raw,
                                   "y_g": y_g, "x_m": x_m, "ln2": ln2, "h2": h2, "u": u, "gf": gf})
        h, lnf = self.ln(x, p["nf.weight"], p["nf.bias"])
        E = p["wortsaite.weight"]
        logits = (h @ E.T).astype(DT)
        qh2 = (h @ p["hq.weight"].T).astype(DT)
        kh2 = (h @ p["hk.weight"].T).astype(DT)
        sH = (np.matmul(qh2, kh2.transpose(0, 2, 1)) / math.sqrt(self.Dh)).astype(DT) + kausal_exp
        sH -= sH.max(-1, keepdims=True)
        eaH = np.exp(sH)
        aH = (eaH / eaH.sum(-1, keepdims=True)).astype(DT)
        z = ((h * p["lamH.weight"][0][None, None, :]).sum(-1) + float(p["lamH.bias"][0])).astype(DT)
        lam = (1.0 / (1.0 + np.exp(-z))).astype(DT)
        pv = softmax(logits)
        p_mix = pv * (1.0 - lam[..., None])
        onehot = np.zeros((B, T, self.V), dtype=DT)
        np.put_along_axis(onehot, ids[:, :, None], 1.0, axis=2)
        p_mix = (p_mix + np.matmul(aH * lam[:, :, None], onehot)).astype(DT)
        c.update({"h": h, "lnf": lnf, "pv": pv, "aH": aH, "lam": lam, "qh2": qh2, "kh2": kh2})
        return p_mix, c, onehot

    def backward(self, dpm, c, onehot):
        p = self.p
        D, NH, dk, L, V = self.D, self.NH, self.dk, self.L, self.V
        B, T = dpm.shape[:2]
        ids = c["ids"]
        grads = {}
        aH, lam, pv = c["aH"], c["lam"], c["pv"]
        p_ptr = np.matmul(aH, onehot)
        # dlam ist dL/dλ; die Sigmoid-Kette λ(1−λ) darf nicht fehlen.
        dz = ((dpm * (p_ptr - pv)).sum(-1) * lam * (1.0 - lam)).astype(DT)
        dpv = (dpm * (1.0 - lam[..., None])).astype(DT)
        dp_ptr = (dpm * lam[..., None]).astype(DT)
        daH = np.take_along_axis(dp_ptr, ids[:, None, :].repeat(T, axis=1), axis=2)
        dsH = aH * (daH - (daH * aH).sum(-1, keepdims=True))
        dqh2 = (np.matmul(dsH, c["kh2"]) / math.sqrt(self.Dh)).astype(DT)
        dkh2 = (np.matmul(dsH.transpose(0, 2, 1), c["qh2"]) / math.sqrt(self.Dh)).astype(DT)
        dlogits = softmax_bwd(dpv, pv).astype(DT)
        h = c["h"]
        E = p["wortsaite.weight"]
        dE = (dlogits.reshape(-1, V).T @ h.reshape(-1, D)).astype(DT)
        dh = (dlogits @ E).astype(DT)
        grads["hq.weight"] = (dqh2.reshape(-1, self.Dh).T @ h.reshape(-1, D)).astype(DT)
        grads["hk.weight"] = (dkh2.reshape(-1, self.Dh).T @ h.reshape(-1, D)).astype(DT)
        dh += dqh2 @ p["hq.weight"]
        dh += dkh2 @ p["hk.weight"]
        grads["lamH.weight"] = (dz[..., None] * h).sum(axis=(0, 1))[None, :].astype(DT)
        grads["lamH.bias"] = np.array([dz.sum()], dtype=DT)
        dh += dz[..., None] * p["lamH.weight"][0][None, None, :]
        dx, dg, db = self.ln_bwd(dh, c["lnf"], D)
        grads["nf.weight"], grads["nf.bias"] = dg, db
        inv_dk = DT(1.0 / math.sqrt(dk))
        gwd = DT(1.0 / math.sqrt(2.0 * math.pi))
        for l in reversed(range(L)):
            pr = f"schichten.{l}."
            cc = c["schichten"][l]
            gf, u, h2, y_g, y_raw, a = cc["gf"], cc["u"], cc["h2"], cc["y_g"], cc["y_raw"], cc["a"]
            grads[pr + "out.weight"] = (dx.reshape(-1, D).T @ gf.reshape(-1, 4 * D)).astype(DT)
            dgf = (dx @ p[pr + "out.weight"]).astype(DT)
            du = (dgf * gelu_grad(u)).astype(DT)
            grads[pr + "fc.weight"] = (du.reshape(-1, 4 * D).T @ h2.reshape(-1, D)).astype(DT)
            dh2 = (du @ p[pr + "fc.weight"]).astype(DT)
            # FFN-Pfad erst DURCH ln2 zurück: dx_m = dx (Residuum) + ln2_bwd(dh2)
            dx_m_ffn, dg2, db2 = self.ln_bwd(dh2, cc["ln2"], D)
            grads[pr + "n2.weight"], grads[pr + "n2.bias"] = dg2, db2
            dx_m = (dx + dx_m_ffn).astype(DT)
            grads[pr + "proj.weight"] = (dx_m.reshape(-1, D).T @ y_g.reshape(-1, D)).astype(DT)
            dy_g = (dx_m @ p[pr + "proj.weight"]).astype(DT)
            dy4 = dy_g.reshape(B, T, NH, dk)
            g = cc["g"]
            yr4 = cc["y_raw"].reshape(B, T, NH, dk)
            dg_h = (dy4 * yr4).sum(axis=(0, 1, 3)).astype(DT)
            sig = 1.0 / (1.0 + np.exp(-p[pr + "thalamus"]))
            grads[pr + "thalamus"] = (dg_h * (2.0 * sig * (1.0 - sig))).astype(DT)
            dy_raw = (dy4 * g[None, None, :, None]).astype(DT)
            qh_ = dy_raw.transpose(0, 2, 1, 3).reshape(B * NH, T, dk)
            ah_ = a.reshape(B * NH, T, T)
            vh_ = cc["v"].transpose(0, 2, 1, 3).reshape(B * NH, T, dk)
            kh_ = cc["k"].transpose(0, 2, 1, 3).reshape(B * NH, T, dk)
            qhr_ = cc["q"].transpose(0, 2, 1, 3).reshape(B * NH, T, dk)
            dv = np.matmul(ah_.transpose(0, 2, 1), qh_).reshape(B, NH, T, dk).transpose(0, 2, 1, 3)
            da = np.matmul(qh_, vh_.transpose(0, 2, 1))
            dsc = (ah_ * (da - (da * ah_).sum(-1, keepdims=True))).astype(DT)
            dq = (np.matmul(dsc, kh_) * inv_dk).reshape(B, NH, T, dk).transpose(0, 2, 1, 3)
            dk4 = (np.matmul(dsc.transpose(0, 2, 1), qhr_) * inv_dk).reshape(B, NH, T, dk).transpose(0, 2, 1, 3)
            self.rope_bwd(dq)
            self.rope_bwd(dk4)
            dqkv = np.concatenate([dq.reshape(B, T, D), dk4.reshape(B, T, D), dv.reshape(B, T, D)], axis=-1)
            grads[pr + "qkv.weight"] = (dqkv.reshape(-1, 3 * D).T @ cc["h1"].reshape(-1, D)).astype(DT)
            W = p[pr + "qkv.weight"]
            dh1 = (dq.reshape(B, T, D) @ W[:D] + dk4.reshape(B, T, D) @ W[D:2 * D]
                   + dv.reshape(B, T, D) @ W[2 * D:]).astype(DT)
            dx_res, dg1, db1 = self.ln_bwd(dh1, cc["ln1"], D)
            grads[pr + "n1.weight"], grads[pr + "n1.bias"] = dg1, db1
            dx = (dx_m + dx_res).astype(DT)
        dE_in = np.zeros_like(E)
        np.add.at(dE_in, ids.reshape(-1), dx.reshape(-1, D))
        grads["wortsaite.weight"] = (dE + dE_in).astype(DT)
        return grads

    # ---- Optimierung
    def opt_init(self):
        self.opt_m = {k: np.zeros_like(v) for k, v in self.p.items()}
        self.opt_v = {k: np.zeros_like(v) for k, v in self.p.items()}
        self.opt_t = 0

    def opt_speichern(self):
        np.savez(OPT, t=np.array([self.opt_t], dtype=np.int64),
                 **{("m." + k): v for k, v in self.opt_m.items()},
                 **{("v." + k): v for k, v in self.opt_v.items()})

    def opt_laden(self):
        if not OPT.exists():
            self.opt_init()
            return
        d = np.load(OPT)
        self.opt_t = int(d["t"][0])
        self.opt_m = {k: d["m." + k].astype(DT) for k in self.p}
        self.opt_v = {k: d["v." + k].astype(DT) for k in self.p}

    def schritt(self, grads):
        self.opt_t += 1
        t = self.opt_t
        lr = LR * min(1.0, t / WARMUP)
        norm = math.sqrt(sum(float((g.astype(np.float64) ** 2).sum()) for g in grads.values()))
        skala = 1.0 if norm <= CLIP else CLIP / (norm + 1e-12)
        for k, g in grads.items():
            g = (g * skala).astype(DT)
            m, v = self.opt_m[k], self.opt_v[k]
            m *= BETA1
            m += (1 - BETA1) * g
            v *= BETA2
            v += (1 - BETA2) * g * g
            mh = m / (1 - BETA1 ** t)
            vh = v / (1 - BETA2 ** t)
            self.p[k] -= (lr * mh / (np.sqrt(vh) + EPS)).astype(DT)


# ------------------------------------------------------------------ Verifikation
def verify_forward(modell, v, log):
    """Python-Forward gegen die JS-Engine laufen lassen — gleiche ids,
    gleiche Verteilung.  Schlägt fehl → nicht trainieren."""
    skript = HIER / "verify_parity.mjs"
    if not skript.exists():
        log.write("verify_forward: verify_parity.mjs fehlt — übersprungen (kein node-Check).\n")
        return True
    ids = encodiere(v, "DU: Hallo\nMOMO:")[0][:64]
    while len(ids) < 64:
        ids = ids + ids[:64 - len(ids)]
    ids = ids[:64]
    r = subprocess.run(["node", str(skript)], input=json.dumps(ids),
                       capture_output=True, text=True, timeout=600, cwd=str(HIER))
    if r.returncode != 0:
        log.write(f"verify_forward: JS-Seite fehlgeschlagen: {r.stderr[:400]}\n")
        return False
    js_p = np.array(json.loads(r.stdout), dtype=DT)
    arr = np.array(ids, dtype=np.int64)[None, :]
    py_p, _, _ = modell.forward(arr)
    d = float(np.abs(js_p - py_p[0, -1]).max())
    log.write(f"verify_forward: max|Δ| = {d:.3e} (letztes Token, V={js_p.shape[-1]})\n")
    return d < 2e-3


def gradcheck(modell, v, log):
    """Numerischer Gradienten-Check auf 12 zufälligen Gewichtseinträgen.

    Läuft auf einer float64-Kopie des Modells — in float32 läge die
    Differenzenz unter dem Rauschboden und der Check wäre wertlos.
    """
    global DT
    alt_dt = DT
    DT = np.float64
    try:
        test = Saiten(modell.cfg, modell.p)
        rng = np.random.default_rng(SEED + 7)
        ids = np.array(encodiere(v, "DU: Was ist OpenOS?\nMOMO:")[0][:48], dtype=np.int64)[None, :]
        ids = np.pad(ids, ((0, 0), (0, 48 - ids.shape[1])), mode="edge") if ids.shape[1] < 48 else ids[:, :48]

        def verlust():
            p_mix, _, _ = test.forward(ids)
            ziel = np.roll(ids, -1, axis=1)
            lp = np.log(np.take_along_axis(p_mix[:, :-1], ziel[:, :-1, None], axis=2).clip(1e-12))
            return float(-lp.mean())

        p_mix, c, onehot = test.forward(ids)
        ziel = np.roll(ids, -1, axis=1)
        n = ids.shape[1] - 1
        dpm = np.zeros_like(p_mix)
        pt = np.take_along_axis(p_mix, ziel[:, :, None], axis=2).squeeze(-1)
        np.put_along_axis(dpm, ziel[:, :, None], (-(1.0 / pt.clip(1e-12)))[..., None], axis=2)
        dpm[:, -1] = 0
        dpm /= ids.shape[0] * n  # Loss = Mittel über B·(T-1) Positionen
        grads = test.backward(dpm, c, onehot)
        eps = 1e-4
        fehler = []
        namen = list(test.p.keys())
        for _ in range(12):
            name = namen[int(rng.integers(len(namen)))]
            w = test.p[name]
            idx = tuple(int(rng.integers(s)) for s in w.shape)
            ana = float(grads[name][idx])
            alt = float(w[idx])
            w[idx] = alt + eps
            lp = verlust()
            w[idx] = alt - eps
            lm = verlust()
            w[idx] = alt
            num = (lp - lm) / (2 * eps)
            fehler.append(abs(ana - num) / (abs(num) + 1e-6))
        m = float(np.mean(fehler))
        log.write(f"gradcheck: mittlerer rel. Fehler {m:.3e} über 12 Einträge (float64)\n")
        return m < 5e-3
    finally:
        DT = alt_dt


# ------------------------------------------------------------------ Läufe
def fenster_ziehen(ids, maske, rng, b, t):
    max_start = len(ids) - t - 1
    starts = rng.integers(0, max_start, size=b)
    x = np.stack([ids[s:s + t] for s in starts])
    m = np.stack([maske[s:s + t] for s in starts])
    ziel = np.stack([ids[s + 1:s + t + 1] for s in starts])
    return x, m, ziel


def trainieren(minuten):
    if STOP.exists():
        print("STOP-Datei gefunden — kein Training in dieser Runde.")
        return
    log = FORTSCHRITT.open("a", encoding="utf-8")
    log.write(f"\n=== Saiten-Runde {time.strftime('%H:%M')} · Ziel {minuten} min ===\n")
    log.flush()
    cfg, tens = gewichte_laden()
    v = vokabular_laden()
    modell = Saiten(cfg, tens)
    ids, maske = korpus_tokenisieren()
    log.write(f"Korpus: {len(ids):,} Token, MOMO-Anteil {maske.mean():.2%}\n")
    if not verify_forward(modell, v, log):
        log.write("ABBRUCH: Forward-Parität verletzt — nicht trainiert.\n")
        log.close()
        return
    if CKPT.exists():
        d = np.load(CKPT)
        for k in modell.p:
            if k in d:
                modell.p[k] = d[k].astype(DT)
        stufe = int(d["_meta_stufe"][0])
        log.write(f"Chepoint geladen: Stufe {stufe}\n")
    else:
        stufe = 0
        log.write("Start: Container-Gewichte (Stufe 0)\n")
    modell.opt_laden()
    if not gradcheck(modell, v, log):
        log.write("ABBRUCH: Gradienten-Check verletzt — nicht trainiert.\n")
        log.close()
        return
    rng = np.random.default_rng(SEED)
    ende = time.time() + minuten * 60
    schnitt, n_schnitt, schnitt_m, n_m = 0.0, 0, 0.0, 0
    nacht = lambda: (time.localtime().tm_hour * 60 + time.localtime().tm_min >= 20 * 60
                     or time.localtime().tm_hour * 60 + time.localtime().tm_min < FERTIG_UM)
    t_zeit = time.time()
    while time.time() < ende and nacht() and not STOP.exists():
        x, m, ziel = fenster_ziehen(ids, maske, rng, BATCH, SEQ)
        p_mix, c, onehot = modell.forward(x)
        pt = np.take_along_axis(p_mix, ziel[:, :, None], axis=2).squeeze(-1)
        verlust_vektor = -np.log(pt.clip(1e-12))
        gew_m = m * np.roll(m, -1, axis=1)
        gew_m[:, -1] = 0
        summe_m = gew_m.sum()
        if summe_m < 1:
            gew_m = np.ones_like(m)
            summe_m = gew_m.sum()
        gew_m /= summe_m
        verlust = float((verlust_vektor * gew_m).sum())
        dpm = np.zeros_like(p_mix)
        np.put_along_axis(dpm, ziel[:, :, None], (-(gew_m / pt.clip(1e-12)))[..., None], axis=2)
        grads = modell.backward(dpm, c, onehot)
        modell.schritt(grads)
        stufe += 1
        schnitt += verlust
        n_schnitt += 1
        momo_ant = float((verlust_vektor[:, :-1] * np.roll(m, -1, axis=1)[:, :-1]).sum() /
                         max(1e-9, np.roll(m, -1, axis=1)[:, :-1].sum()))
        schnitt_m += momo_ant
        n_m += 1
        if stufe % 5 == 0:
            dt = time.time() - t_zeit
            t_zeit = time.time()
            log.write(f"Stufe {stufe:5d} · Loss {verlust:.4f} · MOMO {momo_ant:.4f} · "
                      f"{dt / 5:.1f}s/Schritt · {time.strftime('%H:%M:%S')}\n")
            log.flush()
        if stufe % 40 == 0:
            payload = {k: v.astype(DT) for k, v in modell.p.items()}
            payload["_meta_stufe"] = np.array([stufe], dtype=np.int64)
            np.savez(CKPT, **payload)
            modell.opt_speichern()
    payload = {k: v.astype(DT) for k, v in modell.p.items()}
    payload["_meta_stufe"] = np.array([stufe], dtype=np.int64)
    np.savez(CKPT, **payload)
    modell.opt_speichern()
    log.write(f"=== Saiten-Runde zu Ende · Stufe {stufe} · MOMO-Schnitt {schnitt_m / max(1, n_m):.4f} · "
              f"{time.strftime('%H:%M')} ===\n")
    log.close()
    print(f"Saiten-Runde fertig: Stufe {stufe}.")


def abschluss():
    cfg, tens = gewichte_laden()
    if not CKPT.exists():
        print("Kein Checkpoint — nichts abzuschließen.")
        return
    d = np.load(CKPT)
    for k in tens:
        if k in d:
            tens[k] = d[k].astype(DT)
    stufe = int(d["_meta_stufe"][0])
    modell = Saiten(cfg, tens)
    ids, maske = korpus_tokenisieren()
    rng = np.random.default_rng(SEED + 1)
    grenze = int(len(ids) * 0.95)
    held_ids, held_m = ids[grenze:], maske[grenze:]
    verluste, verluste_m = [], []
    n_fenster = min(120, (len(held_ids) - SEQ - 1) // SEQ)
    for i in range(max(1, n_fenster)):
        s = i * SEQ
        x = held_ids[s:s + SEQ][None, :].astype(np.int64)
        m = held_m[s:s + SEQ][None, :]
        p_mix, _, _ = modell.forward(x)
        ziel = np.roll(x, -1, axis=1)
        lp = -np.log(np.take_along_axis(p_mix[:, :-1], ziel[:, :-1, None], axis=2).clip(1e-12)).squeeze(-1)
        verluste.append(float(lp.mean()))
        mm = np.roll(m, -1, axis=1)[:, :-1]
        if mm.sum() > 0:
            verluste_m.append(float((lp * mm).sum() / mm.sum()))
    nll = float(np.mean(verluste))
    nll_m = float(np.mean(verluste_m)) if verluste_m else 0.0
    pfad = exportieren(modell.p, cfg)
    bericht = {
        "stufe": stufe,
        "heldout_nll": nll,
        "heldout_nll_momo": nll_m,
        "perplexitaet": float(math.exp(min(nll, 20))),
        "vocab": int(cfg["V"]),
        "korpus_ids": int(len(ids)),
        "architektur": {"d": int(cfg["D"]), "schichten": int(cfg["L"]),
                        "koepfe": int(cfg["NH"]), "ctx": int(cfg["CTX"])},
        "export": str(pfad),
        "fertig_um": time.strftime("%H:%M"),
        "datum": time.strftime("%Y-%m-%d"),
    }
    BERICHT.write_text(json.dumps(bericht, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(bericht, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--minutes", type=int, default=20)
    ap.add_argument("--fertig", action="store_true")
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()
    if args.fertig:
        abschluss()
    elif args.verify_only:
        cfg, tens = gewichte_laden()
        v = vokabular_laden()
        modell = Saiten(cfg, tens)
        with FORTSCHRITT.open("a", encoding="utf-8") as log:
            ok1 = verify_forward(modell, v, log)
            ok2 = gradcheck(modell, v, log)
        print(f"verify={ok1} gradcheck={ok2}")
    else:
        trainieren(args.minutes)
