#!/usr/bin/env bash
# Switch @bytecodealliance/componentize-js in node_modules between the broken toolchain, a workaround and the fix.
#
#   ./use-toolchain.sh published    componentize-js 0.23.0 as locked (jco 1.42.0 bundles it)
#   ./use-toolchain.sh latest       componentize-js 0.24.0 (latest release)
#   ./use-toolchain.sh workaround   0.23.0, build hides preview1 random_get from the splicer stub (scripts/workaround.mjs)
#   ./use-toolchain.sh fix          0.24.0 with the splicer rebuilt from patches/componentize-js-preview1-random-get.patch
#
# fix needs cargo with the wasm32-wasip1 target (rustup target add wasm32-wasip1). Options (environment):
#   CJS_FIX_DIR=/path/to/ComponentizeJS   use a local checkout that already contains the fix (no clone, no patch)
set -euo pipefail
cd "$(dirname "$0")"

mode="${1:-}"
latest="0.24.0"
patch="patches/componentize-js-preview1-random-get.patch"

case "$mode" in
  published|workaround)
    npm ci --no-audit --no-fund
    echo "$mode" > .toolchain-mode
    ;;
  latest)
    npm ci --no-audit --no-fund
    npm install --no-save --no-audit --no-fund "@bytecodealliance/componentize-js@$latest"
    echo "latest" > .toolchain-mode
    ;;
  fix)
    if [[ -n "${CJS_FIX_DIR:-}" ]]; then
      checkout="$CJS_FIX_DIR"
      label="$(git -C "$checkout" rev-parse --abbrev-ref HEAD)@$(git -C "$checkout" rev-parse --short=10 HEAD)"
    else
      checkout=".toolchain-fix/ComponentizeJS"
      if [[ ! -d "$checkout/.git" ]]; then
        git clone --quiet --depth 1 --branch "$latest" https://github.com/bytecodealliance/ComponentizeJS.git "$checkout"
      fi
      git -C "$checkout" checkout --quiet -- . && git -C "$checkout" clean -fdq
      git -C "$checkout" apply "$PWD/$patch"
      label="$latest+$(basename "$patch")"
    fi
    npm ci --no-audit --no-fund
    npm install --no-save --no-audit --no-fund "@bytecodealliance/componentize-js@$latest"
    (cd "$checkout" && cargo build --locked --lib --release --target wasm32-wasip1)
    out=".toolchain-fix/splicer"
    rm -rf "$out"
    npx jco new "$checkout/target/wasm32-wasip1/release/splicer_component.wasm" -o .toolchain-fix/splicer.wasm --wasi-reactor
    npx jco transpile -q --instantiation async --no-wasi-shim --name spidermonkey-embedding-splicer \
      .toolchain-fix/splicer.wasm -o "$out" -- -O1
    cp -R "$out/." node_modules/@bytecodealliance/componentize-js/lib/
    echo "fix $label" > .toolchain-mode
    ;;
  *)
    echo "usage: $0 published|latest|workaround|fix" >&2
    exit 2
    ;;
esac

version="$(node -p 'require("./node_modules/@bytecodealliance/componentize-js/package.json").version')"
echo "componentize-js $version: $(cat .toolchain-mode)"
echo "now run: npm run build && npm run repro"
