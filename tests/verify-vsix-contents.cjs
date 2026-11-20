// verify-vsix-contents.cjs — release gate: the packaged VSIX must embed
// every runtime dependency the compiled extension require()s at root level.
// A VSIX built from a checkout without node_modules silently misses ws and
// crashes out/data/client.js on a clean install (colleague bug, 0.0.58).
//
// Usage: node tests/verify-vsix-contents.cjs [path/to/file.vsix]
//        (default: newest orchestrator-monitor-*.vsix in this directory)

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const extRoot = path.resolve(__dirname, '..');
let vsix = process.argv[2];
if (!vsix) {
  const candidates = fs.readdirSync(extRoot)
    .filter((f) => /^orchestrator-monitor-\d+\.\d+\.\d+\.vsix$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(extRoot, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!candidates.length) {
    console.error('[verify-vsix] no orchestrator-monitor-*.vsix found — run `npx vsce package` first');
    process.exit(1);
  }
  vsix = path.join(extRoot, candidates[0].f);
}
vsix = path.resolve(vsix);
if (!fs.existsSync(vsix)) {
  console.error(`[verify-vsix] VSIX not found: ${vsix}`);
  process.exit(1);
}

// --- minimal ZIP reader (no external deps) ----------------------------------
const buf = fs.readFileSync(vsix);
function readCentralDirectory(b) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 65536; i--) {
    if (b.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no EOCD)');
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (b.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central header');
    const method = b.readUInt16LE(off + 10);
    const compSize = b.readUInt32LE(off + 20);
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const localOff = b.readUInt32LE(off + 42);
    const name = b.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function extract(b, e) {
  const lh = e.localOff;
  const nameLen = b.readUInt16LE(lh + 26);
  const extraLen = b.readUInt16LE(lh + 28);
  const dataOff = lh + 30 + nameLen + extraLen;
  const data = b.subarray(dataOff, dataOff + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported compression method ${e.method} for ${e.name}`);
}

const entries = readCentralDirectory(buf);
const names = new Set(entries.map((e) => e.name));

const required = [
  'extension/node_modules/ws/package.json',
  'extension/node_modules/ws/index.js',
  'extension/node_modules/ws/lib/websocket.js',
  'extension/out/extension.js',
  'extension/out/data/client.js',
  'extension/package.json',
];
const missing = required.filter((e) => !names.has(e));
if (missing.length) {
  console.error(`[verify-vsix] FAIL ${path.basename(vsix)} — missing entries:`);
  for (const m of missing) console.error(`  - ${m}`);
  console.error('Root cause: node_modules was absent when `vsce package` ran. '
    + 'Run `npm install` (or `npm ci`) at the extension root, then repackage.');
  process.exit(1);
}

// Smoke: extract ws to a temp dir and make Node resolve it like out/data/client.js does.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-check-'));
try {
  const wsEntries = entries.filter((e) => e.name.startsWith('extension/node_modules/ws/') && !e.name.endsWith('/'));
  for (const e of wsEntries) {
    const dest = path.join(tmp, e.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, extract(buf, e));
  }
  const probe = path.join(tmp, 'extension', 'probe-resolve.js');
  fs.writeFileSync(probe, "console.log(require.resolve('ws'))");
  const resolved = execFileSync(process.execPath, [probe], {
    cwd: path.join(tmp, 'extension'),
    encoding: 'utf8',
  }).trim();
  console.log(`[verify-vsix] OK ${path.basename(vsix)} (${entries.length} entries, ${wsEntries.length} ws files)`);
  console.log(`[verify-vsix] ws resolves to: ${resolved}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
