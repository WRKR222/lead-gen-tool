#!/usr/bin/env node
// Downloads the Litestream binary into ./bin during `npm install` so hosts
// without a persistent disk (e.g. Render's free plan) can back the SQLite
// database up to S3-compatible storage. Never fails the install: without the
// binary the app runs as before, and src/db/replication.js explains what is
// missing if backups were configured.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const VERSION = 'v0.3.13';
const URL = `https://github.com/benbjohnson/litestream/releases/download/${VERSION}/litestream-${VERSION}-linux-amd64.tar.gz`;
const SHA256 = 'eb75a3de5cab03875cdae9f5f539e6aedadd66607003d9b1e7a9077948818ba0';
const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN = path.join(BIN_DIR, 'litestream');

function download(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'chunguza-install' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(res.headers.location, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  if (process.env.LITESTREAM_SKIP_DOWNLOAD === 'true') return;
  if (process.platform !== 'linux' || process.arch !== 'x64') return; // Render/Linux hosts only
  if (fs.existsSync(BIN)) return;
  try {
    const tgz = await download(URL);
    const sum = crypto.createHash('sha256').update(tgz).digest('hex');
    if (sum !== SHA256) throw new Error(`checksum mismatch (${sum})`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'litestream-'));
    fs.writeFileSync(path.join(tmp, 'ls.tgz'), tgz);
    execFileSync('tar', ['xzf', path.join(tmp, 'ls.tgz'), '-C', tmp]);
    fs.mkdirSync(BIN_DIR, { recursive: true });
    fs.copyFileSync(path.join(tmp, 'litestream'), BIN);
    fs.chmodSync(BIN, 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`[litestream] installed ${VERSION} to ${BIN}`);
  } catch (err) {
    console.warn(`[litestream] download skipped: ${err.message}`);
  }
})();
