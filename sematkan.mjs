// Menyematkan peluncur-adacode.js ke dalam adacode.json (aksi `tulis`).
//
// Pemasang hanya membaca manifes; berkas .js di sebelahnya ada supaya bisa
// dibaca, di-lint, dan diuji langsung (`node peluncur-adacode.js`). Dua
// salinan yang disunting terpisah pasti menyimpang, jadi yang satu ini
// DITURUNKAN dari yang lain: sunting .js-nya, lalu `node sematkan.mjs`.
// Dijalankan tanpa argumen ia menulis; dengan `--periksa` ia hanya
// membandingkan dan keluar 1 bila manifes tertinggal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const manifesPath = path.join(dir, 'adacode.json');
const teks = fs.readFileSync(path.join(dir, 'peluncur-adacode.js'), 'utf8');
const manifes = JSON.parse(fs.readFileSync(manifesPath, 'utf8'));
const aksi = manifes.pasang.find((a) => a.aksi === 'tulis' && a.buat === 'peluncur-adacode.js');
if (!aksi) throw new Error('manifes tak punya aksi tulis peluncur-adacode.js');

if (process.argv.includes('--periksa')) {
  if (aksi.teks !== teks) {
    console.error('adacode.json tertinggal dari peluncur-adacode.js — jalankan: node sematkan.mjs');
    process.exit(1);
  }
  console.log('adacode.json sinkron dengan peluncur-adacode.js');
} else {
  aksi.teks = teks;
  fs.writeFileSync(manifesPath, JSON.stringify(manifes, null, 2) + '\n');
  console.log(`tersemat: ${teks.length} karakter`);
}
