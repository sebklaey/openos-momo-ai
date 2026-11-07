// Momo-Saiten-Worker: unser eigenes trainiertes Modell (momo-llm.bin)
// in das Protokoll der Momo-App eingebunden.  Läuft vollständig im Browser —
// die Gewichte kommen einmalig von GitHub, das Denken passiert on-device.
//
// Protokoll (kompatibel zu momo-client.js):
//   load {url, toolIds}            -> progress* + {id, type:'loaded', info}
//   reply {key, text, ...}         -> {id, type:'token', text}* + {id, type:'done', tool, text, stats}
//   abort {target}                 -> laufende Generation sauber beenden
//   reset {key}                    -> {id, type:'ok'}
//   snapshot/restore/strings/info  -> Stubs (Momo Chain degradiert ohne Saitenzustand)
import { vokabularLaden, encodiere, decodiere, flusheDecodiere } from './saiten-engine/tokenizer.js'
import { SaitenLLM, gewichteEntpacken } from './saiten-engine/saiten-llm.js'

// Die Gewichte leben kanonisch im oeffentlichen Supabase-Bucket des OpenOS-
// Projekts (rivudmparhyqvtgcboxw). Eine Datei ueber 50 MB scheitert am Storage-
// API-Limit — darum liegt das Binaerfile in fuenf 32-MB-Teilen vor, die der
// Worker parallel zieht und wieder zu einem Puffer zusammensetzt.  Lesen ist
// oeffentlich (access-control-allow-origin: *), Schreiben war nur fuer den
// Upload offen und ist wieder zu. Integritaet: SHA-256 des Gesamtfiles ist
// c9421248fdce3d58171b6138d12de13110b220d79757e51a6adbaaf1c723bbdb.
const GEWICHTE_BASIS = 'https://rivudmparhyqvtgcboxw.supabase.co/storage/v1/object/public/saiten-gewichte/'
const GEWICHTE = {
  manifest: GEWICHTE_BASIS + 'momo-llm.json?v=saiten148m-s7',
  vocab: GEWICHTE_BASIS + 'momo-vocab.json?v=saiten148m-s7',
  teile: [0, 1, 2, 3, 4].map((i) => GEWICHTE_BASIS + `momo-llm.bin.part${i}?v=saiten148m-s7`),
}

const post = (m) => self.postMessage(m)

let llm = null
let vok = null
let modelInfo = null
const sessions = new Map()   // key -> [{rolle:'DU'|'MOMO', text}]
const abgebrochen = new Set()

async function ladeUrl(url, aufProgress) {
  let letzterFehler = null
  for (let versuch = 1; versuch <= 2; versuch++) {
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`Laden fehlgeschlagen: ${url} (${r.status})`)
      const gesamt = Number(r.headers.get('content-length') ?? 0)
      // Erst Content-Length pruefen, BEVOR der Reader den Stream lockt —
      // sonst wirft r.arrayBuffer() 'body stream is locked'.
      if (!r.body || !gesamt) return r.arrayBuffer()
      const reader = r.body.getReader()
      const teile = []
      let empfangen = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        teile.push(value)
        empfangen += value.length
        aufProgress(empfangen / gesamt)
      }
      const zusammen = new Uint8Array(empfangen)
      let off = 0
      for (const t of teile) { zusammen.set(t, off); off += t.length }
      return zusammen.buffer
    } catch (e) {
      letzterFehler = e
      if (versuch === 1) post({ type: 'progress', stage: 'download', value: 0.02 })
    }
  }
  throw letzterFehler
}

// Fuenf 32-MB-Teile parallel ziehen und in der Reihenfolge der Indizes
// zu einem einzigen ArrayBuffer zusammensetzen.  Fortschritt meldet jeden
// fertigen Teil — Bandbreite kommt aus Parallelitaet statt einem Stream.
async function ladeTeile(urls, aufProgress) {
  const puffer = new Array(urls.length)
  let fertig = 0
  await Promise.all(urls.map(async (url, i) => {
    puffer[i] = new Uint8Array(await ladeUrl(url, () => {}))
    fertig++
    aufProgress(fertig / urls.length)
  }))
  const bytes = puffer.reduce((n, t) => n + t.byteLength, 0)
  const bin = new Uint8Array(bytes)
  let off = 0
  for (const t of puffer) { bin.set(t, off); off += t.byteLength }
  return bin.buffer
}

async function laden(id) {
  const t0 = performance.now()
  post({ type: 'progress', stage: 'download', value: 0.02 })
  const [manifest, vocabRoh, bin] = await Promise.all([
    fetch(GEWICHTE.manifest).then((r) => r.json()),
    fetch(GEWICHTE.vocab).then((r) => r.json()),
    ladeTeile(GEWICHTE.teile, (a) => post({ type: 'progress', stage: 'download', value: 0.02 + 0.8 * a })),
  ])
  post({ type: 'progress', stage: 'build', value: 0.85 })
  const gewichte = gewichteEntpacken(bin, manifest)
  llm = new SaitenLLM(manifest.konfig, gewichte)
  vok = vokabularLaden(vocabRoh)
  const k = manifest.konfig
  // Gesprächszustand: K/V-Cache je Schicht + Hopfield-Kopf (Float32 je Zahl).
  const memoryNumbers = k.L * 2 * k.CTX * k.D + k.CTX * llm.Dh
  modelInfo = {
    name: 'Momo Saiten-LLM', version: 'v2026-10-s2 (gross)', parametern: 148e6,
    sprachen: ['de', 'en'], groesseMb: Math.round(bin.byteLength / 1048576),
    fingerprint: `saiten-148m-${k.D}x${k.L}`,
    faehigkeiten: ['mehrfach_erinnerung'],
    // Felder der Einstellungen-Karte (kompatibel zum alten Engine-Info):
    source: 'saite', ms: Math.round(performance.now() - t0), bytes: bin.byteLength,
    modes: k.D, layers: k.L, strings: k.D, points: k.L * k.D,
    d: k.D, heads: k.NH, ctx: k.CTX, memoryNumbers,
  }
  post({ type: 'progress', stage: 'ready', value: 1 })
  post({ id, type: 'loaded', info: modelInfo })
}

/** Top-k + Temperatur-Sampling (wie im Trainings-Code), mit Wiederholungsstrafe:
 * Tokens, die in den letzten ~50 generierten Tokens schon vorkamen, werden um
 * den Faktor `strafe` (z.B. 1.15) abgewertet — mildert Zitat-Schleifen aus dem
 * alten Korpus, ohne der Sprache den Schwung zu nehmen. */
function sample(p, temperatur, topK, strafeIds, strafe) {
  const V = p.length
  const idx = new Uint32Array(V)
  for (let i = 0; i < V; i++) idx[i] = i
  const k = Math.min(topK, V)
  for (let i = 0; i < k; i++) {
    let best = i
    for (let j = i + 1; j < V; j++) if (p[idx[j]] > p[idx[best]]) best = j
    if (best !== i) { const t = idx[i]; idx[i] = idx[best]; idx[best] = t }
  }
  const gewichte = new Float64Array(k)
  let summe = 0
  const f = strafe || 1
  for (let i = 0; i < k; i++) {
    const q = p[idx[i]] / (strafeIds && strafeIds.has(idx[i]) ? f : 1)
    const w = Math.pow(q, 1 / temperatur)
    gewichte[i] = w
    summe += w
  }
  let z = Math.random() * summe
  for (let i = 0; i < k; i++) {
    z -= gewichte[i]
    if (z <= 0) return idx[i]
  }
  return idx[k - 1]
}

async function antworten(id, msg) {
  if (!llm || !vok) throw new Error('Modell nicht initialisiert')
  const key = String(msg.key || 'main')
  const verlauf = sessions.get(key) || []
  verlauf.push({ rolle: 'DU', text: String(msg.text || '') })

  const zeilen = verlauf.map((m) => `${m.rolle}: ${m.text}`)
  zeilen.push('MOMO:')
  const ctx = llm.cfg.CTX - 1
  // Gedächtnis (Momo Chain) als erste Zeile einweben — vor dem Verlauf, damit es
  // bei knappem Kontext-Fenster nicht wegfällt. Passt zum Lernstil aus dem Korpus
  // (Merke-dir- und Erinnerungs-Gespräche).
  const g = String(msg.memory || '').trim().slice(0, 700)
  let promptIds
  if (g) {
    const einleitung = encodiere(vok, `DU: Zur Erinnerung: ${g}\nMOMO: Okay, ich erinnere mich.`)
    const verlaufIds = encodiere(vok, zeilen.join('\n'))
    const platz = Math.max(32, ctx - einleitung.length)
    promptIds = [...einleitung, ...(verlaufIds.length > platz ? verlaufIds.slice(verlaufIds.length - platz) : verlaufIds)]
  } else {
    const ids = encodiere(vok, zeilen.join('\n'))
    promptIds = ids.length > ctx ? ids.slice(ids.length - ctx) : ids
  }

  const temperatur = msg.temperature > 0 ? Math.min(1, msg.temperature) : 0.45
  const maxTokens = Math.min(110, Math.max(32, Math.round((msg.maxBytes || 220) / 1.6)))

  llm.reset()
  const t0 = performance.now()
  let generiert = 0
  let naechste = -1
  let text = ''
  const dekodZustand = { dec: new TextDecoder('utf-8', { fatal: false }) }
  const zuletzt = [] // IDs der letzten ~50 generierten Tokens (Wiederholungsstrafe)
  const ngramme = new Set() // bereits generierte 3-Wort-Ketten (Wort-Ebene)
  const woerter = []
  for (let n = 0; ; n++) {
    if (abgebrochen.has(id)) { abgebrochen.delete(id); break }
    const pid = n < promptIds.length ? promptIds[n] : naechste
    const p = llm.schritt(pid)
    if (n < promptIds.length - 1) continue
    const id2 = sample(p, temperatur, 12, new Set(zuletzt), 1.3)
    const stueck = decodiere(vok, [id2], false, dekodZustand)
    if (id2 === vok.ende || generiert >= maxTokens) break
    // Stopp am Zeilenende
    if (stueck.includes('\n')) break
    // Stopp, sobald Momo eine eigene neue DU:-Runde anfängt (Dialogfortsetzung)
    if (/^\s*DU\s*:/.test(stueck)) break
    if (generiert > 2 && /\bDU\s*:/.test(text + stueck)) break
    // Stopp beim Echo einer neuen MOMO:-Runde (Modell zitiert Korpus-Dialoge)
    if (/^\s*MOMO\s*:/.test(stueck)) break
    if (generiert > 2 && /\bMOMO\s*:/.test(text + stueck)) break
    // No-Repeat-Ngram (Wort-Ebene): dieselbe 3-Wort-Kette nie zweimal —
    // verhindert die typischen Boilerplate-Schleifen („keine Abos, keine
    // Server, keine Uploads" …). Bei Verstoß einmalig kühler nachziehen.
    {
      const w = stueck.trim()
      if (w) {
        woerter.push(w)
        if (woerter.length >= 3) {
          const kette = woerter.slice(-3).join(' ').toLowerCase()
          if (ngramme.has(kette)) {
            const id3 = sample(p, Math.max(0.2, temperatur * 0.7), 30, new Set(zuletzt), 1.45)
            const s2 = decodiere(vok, [id3], false, dekodZustand)
            if (id3 === vok.ende || s2.includes('\n') || /^\s*(DU|MOMO)\s*:/.test(s2)) break
            woerter.pop()
            const w2 = s2.trim()
            if (w2) woerter.push(w2)
            generiert++
            text += s2
            zuletzt.push(id3)
            if (zuletzt.length > 50) zuletzt.shift()
            if (woerter.length >= 3) ngramme.add(woerter.slice(-3).join(' ').toLowerCase())
            post({ id, type: 'token', text: s2.replace(/\n$/, '').trim(), tool: null })
            naechste = id3
            continue
          }
          ngramme.add(kette)
        }
      }
    }
    generiert++
    text += stueck
    zuletzt.push(id2)
    if (zuletzt.length > 50) zuletzt.shift()
    // Wiederholungswaechter: bei schwachen Modellen frueh und hart stoppen.
    // 1) dasselbe Wort 4x direkt hintereinander ("Wasser Wasser Wasser Wasser")
    if (generiert >= 4) {
      const ws = text.trim().split(/\s+/)
      const letzte4 = ws.slice(-4)
      if (letzte4.length === 4 && letzte4.every((w) => w === letzte4[0])) break
    }
    // 2) derselbe 12-Zeichen-Block 3x am Stueck
    if (generiert > 8 && text.length >= 36) {
      const ende = text.slice(-12)
      if (ende === text.slice(-24, -12) && ende === text.slice(-36, -24)) break
    }
    // 3) klassischer 30-Zeichen-Block 3x
    if (generiert > 18 && text.length >= 90) {
      const ende = text.slice(-30)
      if (ende === text.slice(-60, -30) && ende === text.slice(-90, -60)) break
    }
    // 4) sauberer Satzabschluss nach Mindestlänge beenden — kürzere, runde
    //    Antworten statt Sinnverlust durch lange Fetzen (Tempo-Bonus inklusive).
    if (generiert >= 8 && /[.!?…]\s*["'»”’)\]]*$/.test(text)) break
    post({ id, type: 'token', text: stueck.replace(/\n$/, '').trim(), tool: null })
    naechste = id2
    if (generiert % 8 === 0) await new Promise((r) => setTimeout(r, 0))
  }
  text += flusheDecodiere(dekodZustand)
  text = text.replace(/<\|ende\|>/g, '').trim()
  // Auf vollständigen Satz zurückschneiden: Ein abgebrochener Satzende-Fetzen
  // („nur …", „Sob'squal;") wirkt gebrochener als ein sauberer Abschluss.
  if (text && !/[.!?…]\s*["'»”’)\]]*$/.test(text)) {
    const cut = text.match(/^(.*[.!?…]["'»”’)\]]*)/s)
    if (cut && cut[1].trim().length >= Math.max(12, text.length * 0.35)) {
      text = cut[1].trim()
    } else {
      text = text.replace(/[\s"'«»„“;:,–—-]+$/, '').trim()
    }
  }
  if (text) verlauf.push({ rolle: 'MOMO', text })
  sessions.set(key, verlauf.slice(-16))
  const ms = performance.now() - t0
  post({ id, type: 'done', tool: null, text, stats: { ms: Math.round(ms), tokens: generiert, modell: 'saiten-148m' } })
}

self.onmessage = (ev) => {
  const msg = ev.data || {}
  const id = msg.id
  void (async () => {
    try {
      if (msg.type === 'load') return await laden(id)
      if (msg.type === 'abort') { abgebrochen.add(msg.target); return }
      if (msg.type === 'reply') return await antworten(id, msg)
      if (msg.type === 'reset') { sessions.delete(msg.key); post({ id, type: 'ok' }); return }
      if (msg.type === 'snapshot') { post({ id, type: 'snapshot', snap: null }); return }
      if (msg.type === 'restore') { post({ id, type: 'restored', ok: false, reason: 'Saite-Engine ohne Zustands-Export' }); return }
      if (msg.type === 'strings') { post({ id, type: 'strings', data: [] }); return }
      if (msg.type === 'info') { post({ id, type: 'info', info: modelInfo, sessions: sessions.size }); return }
    } catch (err) {
      post({ id, type: 'error', message: String(err?.message || err) })
    }
  })()
}
