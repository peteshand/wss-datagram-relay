'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./verify-webassembly-manifest.cjs');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function aws(args) {
  const result = childProcess.spawnSync('aws', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`aws exited ${result.status}`);
}
function main() {
  const file = argument('--file');
  const bucket = argument('--bucket');
  if (!file || !bucket) throw new Error('Usage: npm run upload -- --file <release.zip> --bucket <private-bucket> [--prefix lyra/releases] [--profile profile] [--region us-east-1]');
  const zip = path.resolve(file);
  const metadataPath = zip.replace(/\.zip$/i, '.json');
  if (!fs.statSync(zip, { throwIfNoEntry: false })?.isFile() || !fs.statSync(metadataPath, { throwIfNoEntry: false })?.isFile()) throw new Error('Release ZIP or its adjacent metadata JSON is missing. Run bundle first.');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (!/^[a-f0-9]{32}$/.test(metadata.run || '') || metadata.archive !== path.basename(zip) || metadata.bytes !== fs.statSync(zip).size || metadata.sha256 !== sha256(zip)) throw new Error('Release metadata does not match the ZIP. Re-run bundle.');
  const prefix = argument('--prefix', 'lyra/releases').replace(/^\/+|\/+$/g, '');
  const common = ['--region', argument('--region', 'us-east-1')];
  const profile = argument('--profile');
  if (profile) common.push('--profile', profile);
  const destination = `s3://${bucket}/${prefix}/${metadata.run}`;
  aws([...common, 's3', 'cp', zip, `${destination}/${path.basename(zip)}`, '--only-show-errors']);
  aws([...common, 's3', 'cp', metadataPath, `${destination}/${path.basename(metadataPath)}`, '--only-show-errors']);
  console.log(`Uploaded ${metadata.run} to ${destination}/`);
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
