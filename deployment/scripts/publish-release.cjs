'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');
const { verifyManifest } = require('./verify-webassembly-manifest.cjs');

function requireArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function main() {
  const archive = requireArgument('--archive');
  const bucket = requireArgument('--bucket');
  const optionalArguments = [];
  for (const name of ['--prefix', '--profile', '--region']) {
    const index = process.argv.indexOf(name);
    if (index >= 0) optionalArguments.push(name, process.argv[index + 1]);
  }
  const bundle = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'bundle-release.cjs'), '--archive', archive], { stdio: 'inherit' });
  if (bundle.error) throw bundle.error;
  if (bundle.status !== 0) throw new Error(`Bundling failed with exit code ${bundle.status ?? 'unknown'}.`);
  const { manifest } = verifyManifest(path.resolve(archive, 'WebAssemblyBuild.json'));
  const upload = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'upload-release.cjs'), '--file', path.resolve('releases', `LyraWebAssembly-${manifest.run}.zip`), '--bucket', bucket, ...optionalArguments], { stdio: 'inherit' });
  process.exitCode = upload.status || 0;
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
