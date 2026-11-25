// Menjalankan seluruh e2e Playwright. Tiap skrip mendapat server segar dengan database kosong.
//   npm run test:e2e
// Prasyarat: Playwright dan Chromium terpasang (npm i -D playwright && npx playwright install chromium,
// atau playwright global; jalur global dicari otomatis lewat `npm root -g`).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, startServer, tmpDir } from '../helpers.js';
import { makeFixtures } from './fixtures.mjs';

const require = createRequire(import.meta.url);
let nodePath = process.env.NODE_PATH || '';
try {
  require.resolve('playwright');
} catch {
  const g = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
  if (g && fs.existsSync(path.join(g, 'playwright'))) nodePath = [g, nodePath].filter(Boolean).join(path.delimiter);
  else {
    console.error('Playwright tidak ditemukan. Pasang dengan: npm i -D playwright && npx playwright install chromium');
    process.exit(2);
  }
}

const here = path.dirname(new URL(import.meta.url).pathname);
const only = process.argv.slice(2);
const scripts = fs.readdirSync(here).filter((f) => f.endsWith('.e2e.cjs') && (!only.length || only.some((o) => f.includes(o)))).sort();
const work = tmpDir('papan-e2e-');
const fixtures = makeFixtures(path.join(work, 'fixtures'));
const shots = path.join(work, 'screenshots');
fs.mkdirSync(shots);

let failed = 0;
for (const f of scripts) {
  console.log(`\n=== ${f} ===`);
  const srv = await startServer();
  try {
    const r = spawnSync(process.execPath, [path.join(here, f)], {
      stdio: 'inherit', timeout: 10 * 60 * 1000,
      env: { ...process.env, NODE_PATH: nodePath, E2E_BASE: srv.base, E2E_FIXTURES: fixtures, E2E_SHOTS: shots, E2E_ROOT: ROOT },
    });
    if (r.status !== 0) { failed += 1; console.log(`>>> GAGAL: ${f} (kode ${r.status})`); }
  } finally {
    await srv.stop();
    fs.rmSync(srv.dataDir, { recursive: true, force: true });
  }
}
console.log(`\nTangkapan layar: ${shots}`);
console.log(failed ? `\n${failed} dari ${scripts.length} skrip e2e gagal` : `\nSemua ${scripts.length} skrip e2e lolos`);
process.exit(failed ? 1 : 0);
