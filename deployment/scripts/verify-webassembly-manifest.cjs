'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  throw new Error(message);
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    let position = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, position);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    } while (bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function verifyManifest(manifestPath) {
  const absoluteManifest = path.resolve(manifestPath);
  if (!fs.statSync(absoluteManifest, { throwIfNoEntry: false })?.isFile()) {
    fail(`Manifest not found: ${absoluteManifest}`);
  }
  const root = path.dirname(absoluteManifest);
  const manifest = JSON.parse(fs.readFileSync(absoluteManifest, 'utf8').replace(/^\uFEFF/, ''));
  if (manifest.schema !== 1 || manifest.status !== 'succeeded' || !/^[a-f0-9]{32}$/.test(manifest.run || '')) {
    fail('Invalid successful WebAssembly build manifest.');
  }
  if (!manifest.artifacts || typeof manifest.artifacts !== 'object' || Array.isArray(manifest.artifacts) || !manifest.artifacts[manifest.entryPoint]) {
    fail('Manifest has no valid artifact list or entry point.');
  }
  for (const [relative, expected] of Object.entries(manifest.artifacts)) {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) {
      fail(`Unsafe artifact path: ${JSON.stringify(relative)}`);
    }
    if (!expected || typeof expected.bytes !== 'number' || !Number.isSafeInteger(expected.bytes) || !/^[a-f0-9]{64}$/.test(expected.sha256 || '')) {
      fail(`Invalid artifact metadata: ${relative}`);
    }
    const artifact = path.resolve(root, ...relative.split('/'));
    if (!artifact.startsWith(root + path.sep) || !fs.statSync(artifact, { throwIfNoEntry: false })?.isFile()) {
      fail(`Missing artifact: ${relative}`);
    }
    if (fs.statSync(artifact).size !== expected.bytes || sha256(artifact) !== expected.sha256) {
      fail(`Hash mismatch: ${relative}`);
    }
  }
  return { manifest, root: root, manifestPath: absoluteManifest };
}

if (require.main === module) {
  const manifestPath = process.argv[2];
  if (!manifestPath || process.argv.length !== 3) {
    console.error('Usage: npm run verify -- <archive>/WebAssemblyBuild.json');
    process.exitCode = 2;
  } else {
    try {
      const { manifest } = verifyManifest(manifestPath);
      console.log(`Verified sealed WebAssembly build ${manifest.run} (${Object.keys(manifest.artifacts).length} artifacts)`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}

module.exports = { sha256, verifyManifest };
