"use strict";
// Namen in der bestehenden Supabase-Datenbank und ihrer Server-Funktion. Sie stammen aus der Zeit vor Momo und
// bleiben gleich, bis die Datenbank selbst umbenannt wird (dann nur diese zwei Werte ändern).
const MOMO_LEGACY_NAME = "p" + "ha"; // alter App-Name vor Momo
const MOMO_SERVER_NAMES = Object.freeze({ tablePrefix: MOMO_LEGACY_NAME + "_", functionPrefix: MOMO_LEGACY_NAME + "-" });
window.momoDb = (name) => MOMO_SERVER_NAMES.tablePrefix + name;
window.momoFn = (name) => MOMO_SERVER_NAMES.functionPrefix + name;
window.MOMO_CONFIG = Object.freeze({
  serverNames: MOMO_SERVER_NAMES,
  environment: "production",
  build: "momo-1.0.0",
  appBuild: "momo-1.0.0",
  momo: Object.freeze({
    name: "Momo",
    tagline: "Social AI Network",
    model: "models/momo.m4a",
    tools: "momo/momo-tools.json",
    runtime: "momo/momo-saite-worker.js",
    chain: "momo-chain-1",
    // Nur signieren, nie schreiben: kein Anker-Vertrag, kein Paymaster.
    // Der Kopf-Hash wird mit EIP-712 (Chain-ID 8453) gaslos unterschrieben.
    base: Object.freeze({ chainId: 8453, name: "Base Mainnet", schreibtInDieKette: false })
  }),
  ai: Object.freeze({
    /* Server-KI ist abgeschaltet — die alte Qwen-Serverfunktion wird nicht mehr
     * verwendet. Momo antwortet ausschliesslich mit dem eigenen Saiten-Modell
     * auf dem Geraet (momo-saite-worker.js, models/saiten-148m). Ein Rueckfall
     * auf einen Server existiert nicht mehr: keine Server-Antwort, keine
     * Serverkosten, nichts verlaesst den Rechner. */
    aktiv: false,
    anbieter: "saiten",
    funktion: "",
    modell: "Momo Saiten-Modell v2026-11 (Bitseed-Kompressions-KI, sprechfaehig)",
    abrechnung: false,
    /* MOMO AUF DEM GERAET.
     * Ist das Modell einmal geladen, antwortet es hier im Browser ueber WebGPU
     * und nichts verlaesst mehr den Rechner. Der Server bleibt als Rueckfall:
     * ohne WebGPU, vor dem ersten Laden, und wenn das Geraetemodell scheitert.
     *
     * Heruntergeladen wird NIE von selbst — das sind mehrere hundert Megabyte.
     * Beim Start wird nur genommen, was schon im Browser-Cache liegt. */
    lokal: Object.freeze({
      aktiv: true,
      /* Momo-Modell-Registry: name + version bestimmen ALLEIN die Anzeige in den
       * Einstellungen. Bei jedem Modell-Update hier version hochzaehlen
       * (v2026-10, v2026-11, …) — die App zeigt und laedt dann automatisch das
       * aktuellste Momo-Modell. `mlc` ist die technische Download-Quelle. */
      name: "Momo Saiten-Modell",
      version: "v2026-10",
      klein: "Qwen3-0.6B-q4f16_1-MLC",     // ~400 MB, fuer schwaechere Geraete
      gross: "Qwen3-1.7B-q4f16_1-MLC",     // ~1,1 GB, ab 8 GB Arbeitsspeicher
      modell: ""                            // leer: nach Geraet waehlen
    })
  }),
  // Suggests+ ist die einzige Zahlung in OpenOS. Eigener Topf, eigener Preis,
  // eigene Kauf-Funktion — getrennt vom alten Momo-Guthaben darunter.
  suggestsPlus: Object.freeze({
    kaufFunktion: "momo-suggests-checkout-v1",
    preisId: "price_1UD9nGLylxfVShwq1ivKQjPU",
    einheitChf: 0.30
  }),
  credits: Object.freeze({
    aktiv: true,
    creditUsd: 0.01,                   // 1 Credit = 0.01 US-Dollar (100 Credits = 1 USD)
    aufschlag: 0.50,                   // fuer alle gleich; verbindlich in pha_usage_plan_rates_v1
    // Gerechnet und abgebucht wird serverseitig. Die Werte hier sind nur Anzeige.
    statusRpc: "pha_api_manage_status_v1",
    // Der Kauf laeuft ueber dieselbe Strecke wie der API-Credit-Kauf, der bereits
    // funktioniert: Stripe -> pha_stripe_events -> Trigger pha_api_grant_from_stripe_v1.
    kaufFunktion: "openos-credit-checkout-v1",
    mindestkauf: 10,
    hoechstkauf: 1000000
  }),
  chatExperience: Object.freeze({
    scrollToLatestButton: true,
    scrollButtonOnlyWhenAwayFromLatest: true,
    latestMessageCenterSpace: true,
    thinkingDots: true,
    workActivityDots: true,
    tailSpaceViewportFraction: 0.26
  }),
  voiceExperience: Object.freeze({
    provider: "browser-system-confirmed-natural-female",
    apiKeyRequired: false,
    openAIVoice: false,
    mapleAvailable: false,
    naturalFemalePreferred: true,
    naturalQualityRequired: true,
    roboticFallback: false,
    voiceCatalogWaitMs: 2600,
    systemVoiceInstallOffer: true,
    systemVoiceInstallMode: "device-settings-with-manual-selection",
    voiceInstallOneClick: false,
    directSystemVoiceDownload: false,
    manualVoiceSelection: true,
    dictation: true,
    turnTakingConversation: true,
    simultaneousMicMonitoring: true,
    interruptibleSpeech: true,
    bargeIn: true,
    bargeInEchoLeakCalibration: true,
    bargeInCalibrationMs: 900,
    fullDuplex: false,
    microphonePolicy: "self-only-echo-cancelled"
  }),
  filePrivacy: Object.freeze({
    uploadedFilesLocalOnly: true,
    deviceStorage: "indexeddb",
    serverStorage: false,
    cloudSyncIncludesUploadedFiles: false,
    remoteWorkIncludesUploadedFiles: false,
    rawFileAnalytics: false,
    cloudFileCitationMetadata: false,
    serverSideGuardPrepared: true,
    serverSideGuardMigration: "supabase/" + momoDb("cloud_file_privacy_guard_v1") + ".sql",
    historicalCloudScrubPrepared: true
  }),
  adminAnalytics: Object.freeze({
    enabled: true,
    adminEmail: "sebklay@me.com",
    collector: "analytics-collector.js",
    transport: "supabase-postgrest-rpc",
    ingestRpc: momoDb("analytics_ingest_v2"),
    adminRpc: momoDb("admin_analytics_v2"),
    edgeFunctionsRequired: false,
    liveWindowSeconds: 90,
    rawIpStored: false,
    chatContentStored: false
  }),
  productionOrigin: "https://app.openos.space",
  /* Bitcoin ist die einzige Bezahlmöglichkeit (kein Stripe, kein Abo,
     kein Paket, kein Kurs): 1 Credit = 1 Satoshi = 0,00000001 BTC. */
  openosBtc: Object.freeze({
    adresse: "bc1q0j99ljf7sp96gdr7knd5sepw48pfr6a94h58a9"
  }),
  allowedOrigins: Object.freeze([
    "https://app.openos.space",
    "https://openos.space"
  ]),
  supabaseUrl: "https://rivudmparhyqvtgcboxw.supabase.co",
  supabasePublishableKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpdnVkbXBhcmh5cXZ0Z2Nib3h3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkxMzQ4NjIsImV4cCI6MjA3NDcxMDg2Mn0.LSgXTeSK9sY4uatK_hzeVZ-qMnGjQKY5BmvGgnEcW1o",
  functionsBase: "https://rivudmparhyqvtgcboxw.supabase.co/functions/v1",
  stripe: Object.freeze({
    plusPriceId: "price_1UCITyLylxfVShwqzB6i0eJL",
    proPriceId: "price_1UCIU2LylxfVShwqDO2jeK2y",
    plusPaymentLink: "https://buy.stripe.com/fZubJ2bh36zwcYS8E2eME02",
    proPaymentLink: "https://buy.stripe.com/6oUfZi5WJe1Y8IC6vUeME03",
    suggestsCreditPriceId: "price_1UD9nGLylxfVShwq1ivKQjPU",
    suggestsCreditPaymentLink: "https://buy.stripe.com/00weVeacZcXU4sm6vUeME04",
    suggestsCreditUnitChf: 0.30,
    baseCurrency: "CHF",
    adaptivePricing: true,
    localCurrencyDisplay: "browser-locale-fx-indicative"
  })
});