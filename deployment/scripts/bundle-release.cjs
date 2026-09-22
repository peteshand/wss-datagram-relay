'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { sha256, verifyManifest } = require('./verify-webassembly-manifest.cjs');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main() {
  const archive = argument('--archive');
  if (!archive) throw new Error('Usage: npm run bundle -- --archive <Archive> [--output <zip-path>]');
  const archiveRoot = path.resolve(archive);
  const { manifest } = verifyManifest(path.join(archiveRoot, 'WebAssemblyBuild.json'));
  const output = path.resolve(argument('--output') || path.join('releases', `LyraWebAssembly-${manifest.run}.zip`));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) fs.rmSync(output);
  const result = childProcess.spawnSync('tar.exe', ['-a', '-c', '-f', output, '-C', archiveRoot, '.'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `tar.exe exited ${result.status}`);
  const metadata = {
    schema: 1,
    run: manifest.run,
    entryPoint: manifest.entryPoint,
    archive: path.basename(output),
    bytes: fs.statSync(output).size,
    sha256: sha256(output),
    createdUtc: new Date().toISOString()
  };
  const metadataPath = output.replace(/\.zip$/i, '.json');
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Bundled ${manifest.run}: ${output}`);
  console.log(`Release metadata: ${metadataPath}`);
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
