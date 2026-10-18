/**
 * Peluncur 9Router untuk adaLOCAL.
 *
 * 9Router tidak punya berkas config untuk provider: provider hanya bisa
 * ditambah lewat dasbor atau API lokalnya, dan disimpan di SQLite. Karena
 * itu "model adaCODE sudah tersambung" tak bisa dicapai lewat env seperti
 * Open WebUI - harus ada yang memanggil API-nya sesudah server hidup.
 * Berkas ini yang melakukannya, dan sekaligus menggantikan `cli.js` bawaan
 * 9Router, yang di mesin pelanggan melakukan hal-hal yang TIDAK kita mau:
 * mengikat 0.0.0.0 (terbuka ke seluruh jaringan lokal), membunuh proses
 * lain di port yang sama, memeriksa pembaruan ke registry npm, membuka
 * browser, dan menulis ke folder 9router di APPDATA.
 *
 * Yang dilakukan tiap peluncuran (semuanya idempoten):
 *   1. Jalankan server 9Router yang dibundel (app/custom-server.js) di
 *      127.0.0.1:20128 dengan DATA_DIR di dalam folder app.
 *   2. Tunggu /api/health.
 *   3. Masuk dengan sandi sementara (INITIAL_PASSWORD dibaca 9Router tiap
 *      kali login selama pengguna belum menyetel sandinya sendiri), lalu
 *      matikan kewajiban login dasbor - router ini hanya bisa dijangkau dari
 *      mesin ini sendiri, sandi tambahan cuma gesekan (alasan yang sama
 *      dengan n8n tanpa basic auth di manifes n8n).
 *   4. Pastikan node provider "adacode" (OpenAI-compatible -> gerbang
 *      adaCODE) ada, koneksinya memakai kunci API pelanggan YANG SEKARANG
 *      (kunci dirotasi -> ikut berganti di peluncuran berikutnya), dan ada
 *      satu kunci 9Router bernama "adaCODE App" untuk ditempel di alat CLI.
 *   5. Cetak baris siap - pemasang adaCODE App menunggu baris ini.
 *
 * Kunci API adaCODE datang lewat env ADACODE_API_KEY dan TIDAK diteruskan ke
 * proses 9Router; ia hanya dikirim sekali lewat API lokal ke koneksi provider.
 */
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const FOLDER = __dirname;
const HOST = '127.0.0.1';
const PORT = 20128;
const DASAR = `http://${HOST}:${PORT}`;
const DATA = path.join(FOLDER, 'data');
const SERVER = path.join(FOLDER, 'node_modules', '9router', 'app', 'custom-server.js');
const BERKAS_KUNCI = path.join(FOLDER, 'kunci-9router.txt');
// sql.js yang dibundel 9Router 0.5.81 hanya membawa sql-wasm.js TANPA
// sql-wasm.wasm, jadi driver cadangan itu mati di semua mesin. Manifes
// memasang sql.js versi SAMA (1.14.2) di samping 9Router; berkas .wasm-nya
// disalin ke tempat yang dicari 9Router.
const WASM_9ROUTER = path.join(FOLDER, 'node_modules', '9router', 'app', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const WASM_CADANGAN = path.join(FOLDER, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

const PREFIX = 'adacode';
const NAMA_NODE = 'adaCODE';
const NAMA_KUNCI = 'adaCODE App';
// Combo bernama PERSIS nama model bawaan alat coding -> model adaCODE (7 Okt 2026). Tanpa ini, Claude Code yang
// diarahkan ke 9Router gagal "No active credentials for provider: anthropic" sampai pengguna mengganti model ke
// `adacode/...` - titik pengguna paling sering bingung. Combo tampil di /v1/models dan boleh diubah pengguna
// (yang sudah ada tak disentuh). Nama kiri = yang benar-benar dikirim Claude Code (peta di gerbang adaCODE).
const COMBO_ALAT_CODING = {
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6',
  'claude-sonnet-4-5': 'claude-sonnet-4-6',
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-1-20250805': 'claude-opus-4-6',
  'claude-opus-4-1': 'claude-opus-4-6',
  'claude-opus-4-6': 'claude-opus-4-6',
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
  'claude-3-5-haiku': 'claude-haiku-4-5',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'claude-haiku-4-5': 'claude-haiku-4-5',
};

const gateway = (process.env.ADACODE_BASE_URL || '').trim().replace(/\/+$/, '');
const kunciAdacode = (process.env.ADACODE_API_KEY || '').trim();
const sandiSementara = crypto.randomBytes(18).toString('base64url');

function log(pesan) {
  process.stdout.write(`[adaCODE] ${pesan}\n`);
}

/**
 * Flag Node untuk `node:sqlite`, driver utama 9Router. Modul itu baru tanpa
 * flag sejak Node 22.13 / 23.4; di 22.5-22.12 dan 23.0-23.3 hanya ada di
 * balik `--experimental-sqlite`. Node portabel app adalah 22.12.0, jadi
 * tanpa flag ini 9Router di Mac gagal membuka database ("No SQLite driver
 * available") dan dasbornya meminta sandi yang tak pernah tersimpan
 * (pengguna Mac, 5 Okt 2026). Versi lain tak diberi flag: Node 20 menolak
 * opsi yang tak dikenalnya.
 */
function argSqlite() {
  const [besar, kecil] = process.versions.node.split('.').map(Number);
  if ((besar === 22 && kecil >= 5 && kecil < 13) || (besar === 23 && kecil < 4)) return ['--experimental-sqlite'];
  return [];
}

function lengkapiWasm() {
  if (fs.existsSync(WASM_9ROUTER) || !fs.existsSync(WASM_CADANGAN)) return;
  try {
    fs.copyFileSync(WASM_CADANGAN, WASM_9ROUTER);
  } catch (e) {
    log(`Gagal melengkapi sql-wasm.wasm: ${e.message}`);
  }
}

function portDipakai(port) {
  return new Promise((selesai) => {
    const s = net.connect({ host: HOST, port });
    s.once('connect', () => { s.destroy(); selesai(true); });
    s.once('error', () => selesai(false));
  });
}

let cookie = '';
async function api(metode, jalur, badan) {
  const res = await fetch(DASAR + jalur, {
    method: metode,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: badan === undefined ? undefined : JSON.stringify(badan),
  });
  const teks = await res.text();
  let json = null;
  try { json = JSON.parse(teks); } catch { /* bukan JSON */ }
  return { status: res.status, ok: res.ok, json, teks, res };
}

async function tungguSiap(batasDetik) {
  const sampai = Date.now() + batasDetik * 1000;
  while (Date.now() < sampai) {
    try {
      const r = await api('GET', '/api/health');
      if (r.ok && r.json && r.json.ok) return true;
    } catch { /* belum mendengar */ }
    await new Promise((t) => setTimeout(t, 500));
  }
  return false;
}

/**
 * Masuk ke dasbor. Ditolak = pengguna sudah menyetel sandinya sendiri.
 * Galat database BUKAN penolakan sandi: dulu keduanya disamakan, sehingga
 * database yang mati tercatat "sudah bersandi milik pengguna" dan galat
 * aslinya tak pernah sampai ke log.
 */
async function masuk() {
  const r = await api('POST', '/api/auth/login', { password: sandiSementara });
  if (r.status >= 500 || /\[DB\]|SQLite/i.test(r.teks)) {
    const pesan = (r.json && (r.json.error || r.json.message)) || r.teks.slice(0, 160);
    throw new Error(`database 9Router tak bisa dibuka (${pesan})`);
  }
  if (!r.ok) return false;
  const set = r.res.headers.get('set-cookie') || '';
  const m = set.match(/auth_token=[^;]+/);
  if (m) cookie = m[0];
  return true;
}

async function semai() {
  const status = (await api('GET', '/api/auth/status')).json || {};
  if (status.requireLogin !== false) {
    if (!(await masuk())) {
      log('Dasbor 9Router sudah bersandi milik pengguna - penyemaian dilewati (setelan yang ada dibiarkan).');
      return null;
    }
    const s = await api('PATCH', '/api/settings', { requireLogin: false });
    if (!s.ok) throw new Error(`gagal mematikan wajib-login dasbor: HTTP ${s.status} ${s.teks.slice(0, 120)}`);
    log('Dasbor 9Router dibuka tanpa login (hanya bisa dijangkau dari komputer ini).');
  }

  // Node provider "adacode" -> gerbang adaCODE.
  const daftarNode = ((await api('GET', '/api/provider-nodes')).json || {}).nodes || [];
  let node = daftarNode.find((n) => n.prefix === PREFIX);
  if (!node) {
    const r = await api('POST', '/api/provider-nodes', {
      name: NAMA_NODE, prefix: PREFIX, type: 'openai-compatible', apiType: 'chat', baseUrl: gateway,
    });
    if (!r.ok) throw new Error(`gagal membuat provider adaCODE: HTTP ${r.status} ${r.teks.slice(0, 120)}`);
    node = r.json.node;
    log('Provider adaCODE ditambahkan ke 9Router.');
  } else if (node.baseUrl !== gateway) {
    const r = await api('PUT', `/api/provider-nodes/${node.id}`, {
      name: node.name, prefix: PREFIX, apiType: node.apiType || 'chat', baseUrl: gateway,
    });
    if (!r.ok) throw new Error(`gagal memperbarui alamat gerbang: HTTP ${r.status}`);
    log('Alamat gerbang adaCODE di 9Router diperbarui.');
  }

  // Koneksi (kunci API pelanggan) - dibuat sekali, kuncinya ditimpa tiap
  // peluncuran supaya rotasi kunci di adacode.ai ikut sampai ke sini.
  if (!kunciAdacode) {
    log('PERINGATAN: kunci API adaCODE tidak diterima dari app - koneksi provider tidak disemai.');
  } else {
    const koneksi = ((await api('GET', '/api/providers')).json || {}).connections || [];
    const ada = koneksi.find((c) => c.provider === node.id);
    if (!ada) {
      const r = await api('POST', '/api/providers', { provider: node.id, apiKey: kunciAdacode, name: NAMA_NODE });
      if (!r.ok) throw new Error(`gagal menyambungkan kunci adaCODE: HTTP ${r.status} ${r.teks.slice(0, 120)}`);
      log('Kunci API adaCODE tersambung ke provider.');
    } else {
      const r = await api('PUT', `/api/providers/${ada.id}`, { apiKey: kunciAdacode });
      if (!r.ok) throw new Error(`gagal memperbarui kunci adaCODE: HTTP ${r.status}`);
    }
  }

  // Kunci 9Router untuk alat CLI (Claude Code, Codex, Cline, ...).
  const kunci = ((await api('GET', '/api/keys')).json || {}).keys || [];
  let milikKita = kunci.find((k) => k.name === NAMA_KUNCI && k.isActive !== false);
  if (!milikKita) {
    const r = await api('POST', '/api/keys', { name: NAMA_KUNCI });
    if (!r.ok) throw new Error(`gagal membuat kunci 9Router: HTTP ${r.status}`);
    milikKita = r.json;
  }
  try {
    fs.writeFileSync(BERKAS_KUNCI, `${milikKita.key}\n`);
  } catch { /* berkas cuma kenyamanan; kuncinya tetap ada di dasbor */ }

  // Combo nama model bawaan Claude Code -> adaCODE (lihat COMBO_ALAT_CODING). Gagal di sini bukan
  // alasan menggagalkan peluncuran: provider & kunci sudah beres, hanya kenyamanannya yang kurang.
  try {
    const ada = (((await api('GET', '/api/combos')).json || {}).combos || []).map((c) => c.name);
    let baru = 0;
    for (const [nama, model] of Object.entries(COMBO_ALAT_CODING)) {
      if (ada.includes(nama)) continue;
      const r = await api('POST', '/api/combos', { name: nama, models: [`${PREFIX}/${model}`] });
      if (r.ok) baru += 1;
    }
    if (baru) log(`${baru} combo nama model Claude Code -> adaCODE ditambahkan (Claude Code jalan tanpa ganti model).`);
  } catch (e) {
    log(`Combo Claude Code tak disemai: ${e.message}. Claude Code tetap bisa dipakai dengan model ${PREFIX}/<nama-model>.`);
  }
  return milikKita.key;
}

async function utama() {
  if (!fs.existsSync(SERVER)) {
    log(`9Router belum terpasang (tidak ada ${SERVER}). Jalankan Pasang ulang.`);
    process.exit(1);
  }
  if (!gateway) {
    log('ADACODE_BASE_URL kosong - manifes seharusnya mengisinya dari server.');
    process.exit(1);
  }
  if (await portDipakai(PORT)) {
    // 9Router LAIN sudah memegang port (mis. "npm i -g 9router", versi apa pun) - kasus pengguna 6 Okt
    // 2026: dasbor v0.5.95 tanpa node adaCODE, bingung "integrasinya bagaimana". Dulu peluncur menyerah
    // ("port dipakai"), pengguna pun membuka dasbor 9Router-nya sendiri yang memang kosong. Kini adaCODE
    // DISEMAI ke 9Router yang ada (provider, kunci, combo) dan peluncur menunggu di sampingnya supaya kartu
    // adaLOCAL tetap "berjalan". Yang memegang port bukan 9Router (health bisu) -> tetap menyerah.
    let sehat = false;
    try {
      const r = await api('GET', '/api/health');
      sehat = Boolean(r.ok && r.json && r.json.ok);
    } catch { /* bukan 9Router */ }
    if (!sehat) {
      log(`Port ${PORT} sudah dipakai program lain (bukan 9Router) - hentikan dulu, lalu JALANKAN lagi.`);
      process.exit(1);
    }
    log(`9Router lain sudah berjalan di port ${PORT} (bukan dari adaLOCAL) - menyemai adaCODE ke dalamnya.`);
    let kunci9r = null;
    try {
      kunci9r = await semai();
    } catch (e) {
      log(`Penyemaian ke 9Router yang ada gagal: ${e.message}.`);
    }
    if (!kunci9r) log(PETUNJUK_MANUAL);
    cetakSiap(kunci9r);
    // Menunggu di samping: kartu adaLOCAL "berjalan" selama 9Router itu hidup; Hentikan hanya
    // mematikan penunggu ini, bukan 9Router milik pengguna.
    while (await portDipakai(PORT)) await new Promise((t) => setTimeout(t, 10000));
    log('9Router lain berhenti.');
    process.exit(0);
  }
  fs.mkdirSync(DATA, { recursive: true });
  lengkapiWasm();

  const env = { ...process.env };
  delete env.ADACODE_API_KEY;
  Object.assign(env, {
    PORT: String(PORT),
    HOSTNAME: HOST,
    DATA_DIR: DATA,
    INITIAL_PASSWORD: sandiSementara,
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
  });

  const anak = spawn(process.execPath, ['--dns-result-order=ipv4first', ...argSqlite(), SERVER], {
    cwd: path.dirname(SERVER),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // Peringatan "SQLite is an experimental feature" dari Node tidak berarti
  // apa-apa bagi pelanggan dan terlihat seperti galat; sisanya diteruskan.
  const teruskan = (aliran, tujuan) => {
    let sisa = '';
    aliran.on('data', (potong) => {
      sisa += potong.toString();
      const baris = sisa.split('\n');
      sisa = baris.pop();
      for (const b of baris) {
        if (/ExperimentalWarning|--trace-warnings/.test(b)) continue;
        tujuan.write(b + '\n');
      }
    });
  };
  teruskan(anak.stdout, process.stdout);
  teruskan(anak.stderr, process.stderr);

  anak.on('exit', (kode, sinyal) => {
    log(`9Router berhenti (${sinyal || `kode ${kode}`}).`);
    process.exit(kode == null ? 1 : kode);
  });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(s, () => { try { anak.kill(); } catch { /* sudah mati */ } });
  }

  if (!(await tungguSiap(120))) {
    log('9Router tidak menjawab /api/health dalam 120 detik.');
    anak.kill();
    process.exit(1);
  }

  let kunci9r = null;
  try {
    kunci9r = await semai();
  } catch (e) {
    // Database mati = dasbor tak bisa dipakai sama sekali (login pun gagal);
    // jangan cetak "siap" yang membuat app menandainya berjalan.
    if (/^database 9Router/.test(e.message)) {
      log(`9Router tidak bisa dipakai: ${e.message}. Coba Pasang ulang; bila tetap gagal, kirim log ini ke dukungan adaCODE.`);
      anak.kill();
      process.exit(1);
    }
    log(`Penyemaian provider adaCODE gagal: ${e.message}. ${PETUNJUK_MANUAL}`);
  }
  cetakSiap(kunci9r);
}

// Dicetak ke sel log kartu adaLOCAL - satu-satunya tempat pengguna membaca "lalu bagaimana memakainya".
const PETUNJUK_MANUAL = `Tambahkan manual di dasbor ${DASAR}/dashboard: Providers -> Custom Providers -> "Add OpenAI Compatible" (versi lama: API Key Providers -> "+ Add Custom OpenAI-Compatible"): Name adaCODE, Prefix ${PREFIX}, Base URL ${gateway || '(alamat gateway adaCODE dari ADACODE_BASE_URL)'}, API Key = kunci adaCODE dari https://adacode.ai/api-keys, API Type Chat Completions. Lalu di alat coding pakai endpoint ${DASAR}/v1 + kunci 9Router (menu Endpoint & Key) + model ${PREFIX}/<nama-model>.`;

function cetakSiap(kunci9r) {
  log(`9Router siap: ${DASAR}/dashboard`);
  if (!kunci9r) return;
  // Kunci TIDAK dicetak utuh: keluaran ini direkam app (logs/keluaran) dan bisa dibacakan adaGENTIC
  // lewat server (lokal_log) - cukup awalannya + tempat menyalinnya (dasbor -> API Keys, atau berkas).
  const awalan = `${kunci9r.slice(0, 8)}...`;
  log(`Untuk alat CLI (Codex, Cline, Cursor, ...): endpoint ${DASAR}/v1 - kunci 9Router "${NAMA_KUNCI}" (${awalan}; salin dari dasbor -> API Keys atau berkas kunci-9router.txt) - model ${PREFIX}/<nama-model>.`);
  log(`Claude Code: ANTHROPIC_BASE_URL=${DASAR} dan ANTHROPIC_AUTH_TOKEN=<kunci 9Router itu> (tanpa ganti model - nama bawaannya sudah dipetakan ke adaCODE).`);
}

utama().catch((e) => {
  log(`Peluncur gagal: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
