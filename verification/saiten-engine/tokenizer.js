export function vokabularLaden(roh) {
    const v = roh;
    const zuId = new Map();
    for (let i = 0; i < v.stuecke.length; i++)
        zuId.set(v.stuecke[i], i);
    v._zuId = zuId;
    if (v.byteStart === undefined) {
        const b = v.stuecke.indexOf('<0x00>');
        v.byteStart = b >= 0 ? b : -1;
    }
    if (!v.userDefiniert)
        v.userDefiniert = [];
    return v;
}
// SentencePiece-Minimalnormalisierung: whitespace runs → ein '▁'
function normalisiere(text) {
    return '▁' + text.replace(/\s+/g, ' ').trim().replace(/ /g, '▁');
}
const RESERVIERT_BIS = 2; // <unk>, <s>, </s> — niemals mergen
export function encodiere(vok, text) {
    const v = vok;
    const s = normalisiere(text);
    const symbole = [];
    const neuesSymbol = (stueck, id, laenge, freeze) => {
        const idx = symbole.length;
        symbole.push({
            stueck, id, laenge, freeze,
            prev: idx === 0 ? -1 : idx - 1,
            next: -1, leer: false,
        });
        if (idx > 0)
            symbole[idx - 1].next = idx;
        return idx;
    };
    const byteId = (b) => (v.byteStart >= 0 ? v.byteStart + b : v.unk);
    let i = 0;
    while (i < s.length) {
        // längstes user-defined-Symbol, das hier beginnt
        let udMatch = '';
        for (const ud of v.userDefiniert) {
            if (ud.length > udMatch.length && s.startsWith(ud, i))
                udMatch = ud;
        }
        if (udMatch) {
            const id = v._zuId.get(udMatch) ?? v.unk;
            neuesSymbol(udMatch, id, udMatch.length, true);
            i += udMatch.length;
            continue;
        }
        const ch = [...s.slice(i, i + 2)][0]; // ein Unicode-Zeichen
        const id = v._zuId.get(ch);
        if (id !== undefined && id > RESERVIERT_BIS) {
            neuesSymbol(ch, id, ch.length, false);
            i += ch.length;
        }
        else {
            // byte_fallback: Zeichen in UTF-8-Bytes auflösen
            for (const b of new TextEncoder().encode(ch)) {
                neuesSymbol(String.fromCharCode(b), byteId(b), ch.length, false);
            }
            i += ch.length;
        }
    }
    if (symbole.length === 0)
        return [];
    const agenda = [];
    const paarId = (a, b) => {
        const stueck = a.stueck + b.stueck;
        const id = v._zuId.get(stueck);
        if (id === undefined || id <= RESERVIERT_BIS || id === v.unk)
            return -1;
        return id;
    };
    const pruefePaar = (left, right) => {
        if (left < 0 || right < 0)
            return;
        const a = symbole[left];
        const b = symbole[right];
        if (a.leer || b.leer || a.freeze || b.freeze)
            return;
        const id = paarId(a, b);
        if (id < 0)
            return;
        agenda.push({ left, right, id, score: v.scores[id], laenge: a.laenge + b.laenge });
    };
    for (let k = 0; k < symbole.length - 1; k++)
        pruefePaar(k, k + 1);
    for (;;) {
        // bestes Paar: max Score, Tie → kleinster left
        let best = -1;
        for (let k = 0; k < agenda.length; k++) {
            const p = agenda[k];
            const a = symbole[p.left];
            const b = symbole[p.right];
            if (a.leer || b.leer || a.laenge + b.laenge !== p.laenge)
                continue; // stale
            if (best < 0) {
                best = k;
                continue;
            }
            const q = agenda[best];
            if (p.score > q.score || (p.score === q.score && p.left < q.left))
                best = k;
        }
        if (best < 0)
            break;
        const top = agenda[best];
        agenda.splice(best, 1);
        const a = symbole[top.left];
        const b = symbole[top.right];
        // merge: links wächst, rechts wird geleert
        a.stueck += b.stueck;
        a.id = top.id;
        a.laenge += b.laenge;
        a.next = b.next;
        if (b.next >= 0)
            symbole[b.next].prev = top.left;
        b.leer = true;
        pruefePaar(a.prev, top.left);
        pruefePaar(top.left, a.next);
    }
    // --- 3. Ausgabe ---
    const ids = [];
    for (let k = 0; k !== -1; k = symbole[k].next) {
        const s2 = symbole[k];
        if (s2.leer)
            continue;
        ids.push(s2.id);
    }
    return ids;
}
export function decodiere(vok, ids, trimmen = true) {
    const v = vok;
    let out = '';
    const bytes = [];
    const spuelen = () => {
        if (bytes.length) {
            out += new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
            bytes.length = 0;
        }
    };
    for (const id of ids) {
        const st = v.stuecke[id] ?? '';
        if (v.byteStart >= 0 && id >= v.byteStart && id < v.byteStart + 256) {
            bytes.push(id - v.byteStart);
        }
        else {
            spuelen();
            out += st;
        }
    }
    spuelen();
    const text = out.replace(/▁/g, ' ');
    return trimmen ? text.trim() : text;
}
