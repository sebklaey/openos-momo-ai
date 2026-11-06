"use strict";
/* OpenOS Bitcoin-Credits — die einzige Kauf- und Bezahlmöglichkeit.
 *
 * Kein Stripe, kein Paket, kein Kurs, keine Währungsrechnung:
 *   1 Credit = 1 Satoshi = 0,00000001 BTC.
 * Der Nutzer sendet eine BELIEBIGe Anzahl Satoshis direkt an die offizielle
 * OpenOS-Adresse; nach Zahlungseingang (öffentliche Blockchain-Inspektion
 * via mempool.space — nur Adresse und Betrag, keine Nutzerdaten) wird das
 * lokale Credit-Ledger um genau die empfangenen Satoshis gutgeschrieben.
 *
 * Gutschrift: lokal + idempotent (TxID als Referenz) — ein Kauf kann nie
 * doppelt verbucht werden, auch nicht bei wiederholtem Prüfen.
 */
(function(ns){
  const WALLET_KEY="openos-credits-v1";
  const MEMPOOL="https://mempool.space/api";
  const POLL_MS=20000, MAX_MIN=20;
  const SATOSHI=1e-8;

  const cfg=()=>(window.MOMO_CONFIG||{}).openosBtc||{};
  const adresse=()=>String(cfg().adresse||"").trim();

  const fmtBtc=v=>Number(v).toFixed(8)+" BTC";
  const fmtSat=v=>Math.round(Number(v)).toLocaleString("de-CH")+" Satoshi";
  const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

  /* Gutschrift: idempotent über TxID-Referenz. */
  function gutschreiben(credits,ref){
    return ns.auth?.getClient?.().then(c=>c.openosWallet.gutschreiben(credits,ref))
      .catch(()=>{
        const w=JSON.parse(localStorage.getItem(WALLET_KEY)||"{}");
        w.refs=w.refs||{};
        if(ref&&w.refs["kauf:"+ref])return{ok:true,bereitsBuchung:true};
        w.balance=Number(w.balance||0)+credits;
        w.purchased=Number(w.purchased||0)+credits;
        if(ref)w.refs["kauf:"+ref]=credits;
        try{localStorage.setItem(WALLET_KEY,JSON.stringify(w))}catch{}
        return{ok:true};
      });
  }
  async function bereitsGutgeschrieben(ref){
    try{
      const c=await ns.auth.getClient();
      const w=c.openosWallet.wallet();
      return Boolean(w.refs?.["kauf:"+ref]);
    }catch{
      try{const w=JSON.parse(localStorage.getItem(WALLET_KEY)||"{}");return Boolean(w.refs?.["kauf:"+ref])}catch{return false}
    }
  }

  /* Zahlung auf der Adresse suchen (mempool.space, öffentlich). */
  async function sucheZahlung(erwartetBtc){
    const r=await fetch(`${MEMPOOL}/address/${adresse()}/txs`);
    if(!r.ok)throw new Error("Blockchain-Abfrage nicht erreichbar.");
    const txs=await r.json();
    for(const tx of txs){
      for(const v of (tx.vout||[])){
        if(v?.scriptpubkey_address===adresse()&&Number(v.value||0)/1e8>=erwartetBtc*0.999){
          return{txid:tx.txid,wertBtc:Number(v.value)/1e8,confirmed:Boolean(tx.status?.confirmed)};
        }
      }
    }
    return null;
  }

  /* ── UI ─────────────────────────────────────────────────────── */
  let pollTimer=null;
  function statusSet(host,text,fehler){
    const el=host.querySelector("#btcStatus");
    if(el){el.textContent=text;el.style.color=fehler?"#ff7b72":""}
  }

  function render(host){
    if(!host)return;
    host.innerHTML=`
      <section class="account-card">
        <div class="account-section-head">
          <div>
            <div class="eyebrow">CREDITS KAUFEN · BITCOIN</div>
            <h3>Die einzige Bezahlmöglichkeit: Bitcoin</h3>
            <p><strong>1 Credit = 1 Satoshi (0,00000001 BTC).</strong> Kein Stripe, kein Paket,
               kein Kurs, keine Währungsrechnung — du schickst eine beliebige Anzahl Satoshis
               direkt an die OpenOS-Adresse und erhältst genau dieselbe Anzahl Credits.</p>
          </div>
        </div>
        <div class="donate-row" style="align-items:center;gap:12px;flex-wrap:wrap;margin:14px 0">
          <label class="donate-amount"><span>Credits (= Satoshi)</span>
            <input type="number" id="btcCredits" min="1" max="21000000" step="1" value="1000" inputmode="numeric">
          </label>
          <div><div class="account-muted">Bitcoin-Betrag</div><strong id="btcBetrag">—</strong></div>
          <button class="action-btn white" id="btcPruefen" type="button">Zahlung prüfen</button>
        </div>
        <div style="margin:14px 0;padding:12px;border:1px dashed #3a3a55;border-radius:12px;word-break:break-all">
          <div class="account-muted">Zahlung an (nur Bitcoin / BTC, beliebiger Betrag):</div>
          <code id="btcAdr">${esc(adresse())}</code>
          <button class="action-btn" id="btcCopy" type="button" style="margin-left:8px">Adresse kopieren</button>
        </div>
        <p class="account-muted">Du kannst jederzeit mehrmals zahlen — jede Transaktion wird einzeln
           erkannt und idempotent verbucht. Kleine Beträge werden schon nach Sichtung der Transaktion
           gutgeschrieben; die Gutschrift ist final, sobald die Transaktion eine Bestätigung hat.</p>
        <div class="account-notice" id="btcStatus" role="status" aria-live="polite" style="margin-top:12px"></div>
      </section>`;

    const creditsEl=host.querySelector("#btcCredits");
    const betragEl=host.querySelector("#btcBetrag");
    const anzeigen=()=>{
      const n=Math.max(1,Math.min(21000000,Number(creditsEl?.value||1000)));
      betragEl.textContent=fmtBtc(n*SATOSHI)+" · "+fmtSat(n);
    };
    creditsEl?.addEventListener("input",anzeigen);
    anzeigen();

    host.querySelector("#btcCopy")?.addEventListener("click",async()=>{
      try{await navigator.clipboard.writeText(adresse());statusSet(host,"Adresse kopiert.")}catch{statusSet(host,"Kopieren nicht möglich — bitte manuell markieren.",true)}
    });

    host.querySelector("#btcPruefen")?.addEventListener("click",async()=>{
      const n=Math.max(1,Math.min(21000000,Number(creditsEl?.value||1000)));
      const erwartet=n*SATOSHI;
      const ende=Date.now()+MAX_MIN*60000;
      let versuch=0;
      statusSet(host,"Suche Zahlung von "+fmtBtc(erwartet)+" auf der Adresse … (0/"+MAX_MIN+" min)");
      const runde=async()=>{
        versuch++;
        try{
          const z=await sucheZahlung(erwartet);
          if(z){
            const credits=Math.round(z.wertBtc/SATOSHI);
            const doppelt=await bereitsGutgeschrieben(z.txid);
            await gutschreiben(credits,z.txid);
            statusSet(host,(doppelt?"Kauf bereits verbucht.":"Zahlung gefunden ("+fmtBtc(z.wertBtc)+", Tx "+z.txid.slice(0,12)+"…). "
              +fmtSat(credits)+" Credits gutgeschrieben.")
              +(z.confirmed?" Bestätigt.":" Noch unbestätigt — final nach 1 Bestätigung."));
            ns.momoCredits?.laden?.(true).catch(()=>{});
            return;
          }
          if(Date.now()>ende){statusSet(host,"Keine passende Zahlung gefunden (20 Min). Bitte prüfe die Transaktion und versuche es erneut — die Gutschrift erfolgt jederzeit idempotent.",true);return}
          statusSet(host,"Suche Zahlung von "+fmtBtc(erwartet)+" … ("+Math.round(versuch*POLL_MS/60000)+" min)");
          setTimeout(runde,POLL_MS);
        }catch(e){
          statusSet(host,"Blockchain-Abfrage fehlgeschlagen: "+e.message+" — bitte später erneut prüfen (Gutschrift bleibt idempotent anhand der TxID).",true);
        }
      };
      await runde();
    });
  }

  ns.bitcoinPay={render,gutschreiben,sucheZahlung,adresse};
})(window.MomoApp=window.MomoApp||{});