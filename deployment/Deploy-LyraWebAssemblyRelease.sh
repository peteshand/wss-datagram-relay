#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 --bucket <private-bucket> --run <build-id> --web-root <nginx-root> [--prefix lyra/releases]" >&2
  exit 2
}

bucket=''
prefix=''
run=''
web_root=''
while (($#)); do
  case "$1" in
    --bucket) bucket=${2:?}; shift 2 ;;
    --prefix) prefix=${2:?}; shift 2 ;;
    --run) run=${2:?}; shift 2 ;;
    --web-root) web_root=${2:?}; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$bucket" && -n "$run" && -n "$web_root" ]] || usage
[[ "$run" =~ ^[a-f0-9]{32}$ ]] || { echo 'Invalid build run identifier.' >&2; exit 1; }
prefix=${prefix:-lyra/releases}
command -v aws >/dev/null || { echo 'AWS CLI is required.' >&2; exit 1; }
command -v node >/dev/null || { echo 'Node.js is required.' >&2; exit 1; }
command -v unzip >/dev/null || { echo 'unzip is required.' >&2; exit 1; }
command -v sha256sum >/dev/null || { echo 'sha256sum is required.' >&2; exit 1; }

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
releases_dir="$web_root/lyra-releases"
stage="$releases_dir/.incoming-$(date +%s)-$$"
payload="$stage/payload"
mkdir -p "$releases_dir"
trap 'rm -rf -- "$stage"' EXIT

release_prefix="${prefix#/}/$run"
zip_name="LyraWebAssembly-$run.zip"
metadata_name="LyraWebAssembly-$run.json"
aws s3 cp "s3://$bucket/$release_prefix/$zip_name" "$stage.zip" --only-show-errors
aws s3 cp "s3://$bucket/$release_prefix/$metadata_name" "$stage.json" --only-show-errors
expected_sha=$(node -e 'const fs=require("node:fs"); const m=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (!/^[a-f0-9]{32}$/.test(m.run)||m.run!==process.argv[2]||!/^[a-f0-9]{64}$/.test(m.sha256)) process.exit(2); console.log(m.sha256)' "$stage.json" "$run")
actual_sha=$(sha256sum "$stage.zip" | awk '{print $1}')
[[ "$expected_sha" == "$actual_sha" ]] || { echo 'Downloaded ZIP hash does not match release metadata.' >&2; exit 1; }
mkdir -p "$payload"
unzip -q "$stage.zip" -d "$payload"
node "$script_dir/scripts/verify-webassembly-manifest.cjs" "$payload/WebAssemblyBuild.json"

[[ ! -e "$releases_dir/$run" ]] || { echo "Release already exists: $run" >&2; exit 1; }
cp -- "$payload/LyraStarterGame.html" "$payload/index.html"
cp -- "$payload/WebAssemblyBuild.json" "$payload/__webgpu_build.json"
find "$payload" -type d -exec chmod 0755 {} +
find "$payload" -type f -exec chmod 0644 {} +
mv -- "$payload" "$releases_dir/$run"
ln -sfn "lyra-releases/$run" "$web_root/.lyra-next"
mv -Tf -- "$web_root/.lyra-next" "$web_root/lyra"
trap - EXIT

echo "Promoted build $run"
echo "Open: https://peteshand.net/lyra/index.html"
