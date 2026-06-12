/**
 * Container smoke test for VS Code workspaceStorage path resolution.
 *
 * Runs inside a Linux container (or anywhere) with ZERO dependencies — it only
 * exercises src/utils/paths.js, which uses Node built-ins. Verifies both
 * dev-container scenarios:
 *
 *   Scenario A — Copilot data lives on the HOST, bind-mounted read-only into
 *                the container at ~/.config/Code/User/workspaceStorage. The
 *                existing hardcoded Linux path should match (no fallback needed).
 *
 *   Scenario B — Copilot runs INSIDE the container; logs live under
 *                ~/.vscode-server/data/User/... The hardcoded paths miss, so the
 *                fallback derived from globalStorage (setGlobalStorageBase) should
 *                resolve the sibling workspaceStorage.
 *
 * Usage (from repo root):
 *   docker run --rm -e HOME=/home/node -v "$PWD":/work -w /work \
 *     -v "$HOME/Library/Application Support/Code/User/workspaceStorage":/home/node/.config/Code/User/workspaceStorage:ro \
 *     node:20 node scripts/container-smoke-test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getWorkspaceStoragePaths, setGlobalStorageBase } = require('../src/utils/paths');

let failures = 0;
function check(name, cond, detail) {
  const status = cond ? '✅ PASS' : '❌ FAIL';
  console.log(`${status}  ${name}`);
  if (detail) console.log(`         ${detail}`);
  if (!cond) failures++;
}

console.log('\n=== Container smoke test: workspaceStorage resolution ===\n');
console.log(`node ${process.version} on ${os.platform()} (${os.arch()}), HOME=${process.env.HOME}\n`);

// --- Scenario A: host data bind-mounted at the Linux desktop path -----------
const linuxPath = path.join(process.env.HOME || '', '.config/Code/User/workspaceStorage');
if (fs.existsSync(linuxPath)) {
  const dirs = fs.readdirSync(linuxPath).filter((d) => {
    try { return fs.statSync(path.join(linuxPath, d)).isDirectory(); } catch { return false; }
  });
  const found = getWorkspaceStoragePaths();
  check(
    'Scenario A: hardcoded Linux path matched host data (no fallback)',
    found.includes(linuxPath),
    `found ${dirs.length} workspace dir(s) at ${linuxPath}`
  );
} else {
  console.log(`⏭️  Scenario A skipped — nothing mounted at ${linuxPath}\n`);
}

// --- Scenario B: simulate a dev-container .vscode-server layout -------------
// Use an isolated temp HOME so the hardcoded desktop candidates all miss,
// forcing the globalStorage-derived fallback to fire.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devc-'));
const userDir = path.join(tmpHome, '.vscode-server/data/User');
const globalStorage = path.join(userDir, 'globalStorage/sathvikcheela.copilot-cost-analyzer');
const wsStorage = path.join(userDir, 'workspaceStorage');
fs.mkdirSync(globalStorage, { recursive: true });
fs.mkdirSync(path.join(wsStorage, 'deadbeefcafe0001'), { recursive: true });

const saved = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  APPDATA: process.env.APPDATA,
};
process.env.HOME = tmpHome;          // no .config/Code here → hardcoded miss
delete process.env.USERPROFILE;
delete process.env.APPDATA;

setGlobalStorageBase(globalStorage); // what extension.js does at activation
const foundB = getWorkspaceStoragePaths();

// restore env
process.env.HOME = saved.HOME;
if (saved.USERPROFILE !== undefined) process.env.USERPROFILE = saved.USERPROFILE;
if (saved.APPDATA !== undefined) process.env.APPDATA = saved.APPDATA;
fs.rmSync(tmpHome, { recursive: true, force: true });

check(
  'Scenario B: fallback derived the sibling .vscode-server workspaceStorage',
  foundB.length === 1 && foundB[0] === wsStorage,
  `derived → ${foundB[0] || '(nothing)'}`
);

console.log(`\n=== ${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILURE(S) ❌'} ===\n`);
process.exit(failures === 0 ? 0 : 1);
