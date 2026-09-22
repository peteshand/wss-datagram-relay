'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyManifest } = require('../scripts/verify-webassembly-manifest.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-deployment-'));
try {
  const artifact = path.join(root, 'game.wasm');
  fs.writeFileSync(artifact, 'test bytes');
  const digest = crypto.createHash('sha256').update('test bytes').digest('hex');
  const manifest = { schema: 1, status: 'succeeded', run: '0123456789abcdef0123456789abcdef', entryPoint: 'game.wasm', artifacts: { 'game.wasm': { bytes: 10, sha256: digest } } };
  const manifestPath = path.join(root, 'WebAssemblyBuild.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal(verifyManifest(manifestPath).manifest.run, manifest.run);
  manifest.artifacts['../escape'] = manifest.artifacts['game.wasm'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyManifest(manifestPath), /Unsafe artifact path/);
  console.log('PASS WebAssembly manifest verifier');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
