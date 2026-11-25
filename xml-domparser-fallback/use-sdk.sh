#!/usr/bin/env bash
# Switch @aws-sdk/xml-builder in node_modules between the published package and the fix branch.
#
#   ./use-sdk.sh published   npm ci (exact versions from package-lock.json)
#   ./use-sdk.sh fix         npm ci, then replace @aws-sdk/xml-builder with a build of the fix branch
#
# fix options (environment):
#   SDK_FIX_DIR=/path/to/aws-sdk-js-v3   use a local checkout instead of cloning
#   SDK_FIX_REPO=<git url>               default https://github.com/cadivus/aws-sdk-js-v3.git
#   SDK_FIX_BRANCH=<branch>              default fix/xml-parser-domparser-fallback
set -euo pipefail
cd "$(dirname "$0")"

mode="${1:-}"
repo="${SDK_FIX_REPO:-https://github.com/cadivus/aws-sdk-js-v3.git}"
branch="${SDK_FIX_BRANCH:-fix/xml-parser-domparser-fallback}"

xml_builder_dir() {
  node -e 'const {createRequire}=require("module");const path=require("path");
    const core=createRequire(path.resolve("package.json")).resolve("@aws-sdk/core/package.json");
    console.log(path.dirname(createRequire(core).resolve("@aws-sdk/xml-builder/package.json")))'
}

case "$mode" in
  published)
    npm ci --no-audit --no-fund
    echo "published" > .sdk-mode
    ;;
  fix)
    if [[ -n "${SDK_FIX_DIR:-}" ]]; then
      checkout="$SDK_FIX_DIR"
    else
      checkout=".sdk-fix/aws-sdk-js-v3"
      if [[ ! -d "$checkout/.git" ]]; then
        git clone --quiet --depth 1 --filter=blob:none --sparse --branch "$branch" "$repo" "$checkout"
        git -C "$checkout" sparse-checkout set packages-internal/xml-builder
      else
        git -C "$checkout" fetch --quiet --depth 1 origin "$branch"
        git -C "$checkout" checkout --quiet --detach FETCH_HEAD
      fi
    fi
    sha="$(git -C "$checkout" rev-parse --short=10 HEAD)"
    npm ci --no-audit --no-fund
    node scripts/build-xml-builder.mjs "$checkout/packages-internal/xml-builder" .sdk-fix/xml-builder
    target="$(xml_builder_dir)"
    rm -rf "$target"
    cp -R .sdk-fix/xml-builder "$target"
    echo "fix $branch@$sha" > .sdk-mode
    ;;
  *)
    echo "usage: $0 published|fix" >&2
    exit 2
    ;;
esac

count="$(find node_modules -path '*/@aws-sdk/xml-builder/package.json' | wc -l)"
if [[ "$count" != "1" ]]; then
  echo "expected exactly one @aws-sdk/xml-builder in node_modules, found $count" >&2
  exit 1
fi
echo "@aws-sdk/xml-builder: $(cat .sdk-mode) ($(xml_builder_dir))"
echo "now run: npm run build && npm run repro"
