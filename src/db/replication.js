/**
 * Continuous SQLite backup with Litestream, for hosts without a persistent
 * disk (Render's free plan wipes the filesystem on every deploy and restart).
 *
 * - restoreIfNeeded(): before the database is opened, pull the latest backup
 *   when there is no local file (a fresh container).
 * - startReplication(): stream every change to the replica while the server
 *   runs; stopReplication() lets it flush on shutdown.
 *
 * Enabled by LITESTREAM_BUCKET (any S3-compatible storage: Backblaze B2,
 * Cloudflare R2, AWS S3) with LITESTREAM_ACCESS_KEY_ID /
 * LITESTREAM_SECRET_ACCESS_KEY, or by LITESTREAM_REPLICA_DIR (a local folder,
 * for testing).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const BIN = process.env.LITESTREAM_BIN || path.join(__dirname, '..', '..', 'bin', 'litestream');
let child = null;
let stopping = false;

function enabled() {
  return !!(process.env.LITESTREAM_BUCKET || process.env.LITESTREAM_REPLICA_DIR);
}

function describe() {
  if (process.env.LITESTREAM_BUCKET) return `s3://${process.env.LITESTREAM_BUCKET}/${replicaPath()}`;
  return process.env.LITESTREAM_REPLICA_DIR;
}

function replicaPath() {
  return (process.env.LITESTREAM_PATH || 'chunguza/leadgen').replace(/^\/+|\/+$/g, '');
}

function writeConfig(dbPath) {
  const replica = process.env.LITESTREAM_BUCKET
    ? [
      '        type: s3',
      `        bucket: ${JSON.stringify(process.env.LITESTREAM_BUCKET)}`,
      `        path: ${JSON.stringify(replicaPath())}`,
      ...(process.env.LITESTREAM_ENDPOINT ? [`        endpoint: ${JSON.stringify(process.env.LITESTREAM_ENDPOINT)}`, '        force-path-style: true'] : []),
      ...(process.env.LITESTREAM_REGION ? [`        region: ${JSON.stringify(process.env.LITESTREAM_REGION)}`] : [])
    ]
    : ['        type: file', `        path: ${JSON.stringify(path.resolve(process.env.LITESTREAM_REPLICA_DIR))}`];
  const yml = ['dbs:', `  - path: ${JSON.stringify(path.resolve(dbPath))}`, '    replicas:', '      - name: primary', ...replica, '        sync-interval: 1s', ''].join('\n');
  const file = path.join(os.tmpdir(), 'chunguza-litestream.yml');
  // Credentials stay in the environment (LITESTREAM_ACCESS_KEY_ID / _SECRET_ACCESS_KEY), never in the file.
  fs.writeFileSync(file, yml, { mode: 0o600 });
  return file;
}

function requireBinary() {
  if (!fs.existsSync(BIN)) {
    throw new Error(`[litestream] backups are configured but ${BIN} is missing. Reinstall dependencies (npm install downloads it on Linux x64) or set LITESTREAM_BIN.`);
  }
}

/**
 * Restore the latest backup when the database file does not exist yet.
 * A failed restore stops startup: starting empty would begin a new backup
 * generation and hide the real data behind it.
 */
function restoreIfNeeded(dbPath) {
  if (!enabled() || fs.existsSync(dbPath)) return;
  requireBinary();
  const cfg = writeConfig(dbPath);
  const res = spawnSync(BIN, ['restore', '-config', cfg, '-if-db-not-exists', '-if-replica-exists', path.resolve(dbPath)], { encoding: 'utf8', timeout: 5 * 60000 });
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (res.status !== 0) throw new Error(`[litestream] restore from ${describe()} failed: ${out || res.error?.message || 'unknown error'}`);
  console.log(fs.existsSync(dbPath) ? `[litestream] restored database from ${describe()}` : `[litestream] no backup yet at ${describe()}, starting a new database`);
}

function startReplication(dbPath) {
  if (!enabled() || child) return;
  requireBinary();
  const cfg = writeConfig(dbPath);
  child = spawn(BIN, ['replicate', '-config', cfg], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code, signal) => {
    child = null;
    if (!stopping) console.error(`[litestream] replication stopped unexpectedly (code ${code}, signal ${signal})`);
  });
  console.log(`[litestream] replicating to ${describe()}`);
}

/** Ask Litestream to flush and exit; resolves when it has (or after timeoutMs). */
function stopReplication(timeoutMs = 10000) {
  stopping = true;
  if (!child) return Promise.resolve();
  const proc = child;
  return new Promise(resolve => {
    const t = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, timeoutMs);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
    proc.kill('SIGTERM');
  });
}

module.exports = { enabled, describe, restoreIfNeeded, startReplication, stopReplication };
