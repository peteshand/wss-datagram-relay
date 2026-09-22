'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-bundle-'));
try {
  const archive = path.join(root, 'Archive');
  fs.mkdirSync(archive);
  fs.writeFileSync(path.join(archive, 'game.wasm'), 'test bytes');
  const hash = crypto.createHash('sha256').update('test bytes').digest('hex');
  fs.writeFileSync(path.join(archive, 'WebAssemblyBuild.json'), JSON.stringify({
    schema: 1, status: 'succeeded', run: 'fedcba9876543210fedcba9876543210', entryPoint: 'game.wasm',
    artifacts: { 'game.wasm': { bytes: 10, sha256: hash } }
  }));
  const bundle = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'bundle-release.cjs'), '--archive', archive], { cwd: root, encoding: 'utf8' });
  assert.equal(bundle.status, 0, bundle.stderr || bundle.stdout);
  const zip = path.join(root, 'releases', 'LyraWebAssembly-fedcba9876543210fedcba9876543210.zip');
  assert.ok(fs.statSync(zip).isFile());
  const contents = childProcess.spawnSync('tar.exe', ['-tf', zip], { encoding: 'utf8' });
  assert.equal(contents.status, 0, contents.stderr);
  assert.match(contents.stdout, /game\.wasm/);
  assert.match(contents.stdout, /WebAssemblyBuild\.json/);
  console.log('PASS WebAssembly release ZIP bundler');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
