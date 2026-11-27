# webcrypto-rsa-importkey-trap

Inside a WebAssembly component built with [ComponentizeJS](https://github.com/bytecodealliance/ComponentizeJS) (StarlingMonkey), importing any RSA or EC public key with `crypto.subtle.importKey` aborts the whole instance with `wasm trap: wasm 'unreachable' instruction executed`. The trap cannot be caught in JS, so libraries such as [aws-jwt-verify](https://github.com/awslabs/aws-jwt-verify) die on the first JWT verification. HMAC keys and `crypto.getRandomValues` work.

Cause: OpenSSL draws randomness while validating the imported public key (`EVP_PKEY_public_check`, Miller-Rabin / blinded EC inversion) via `RAND_priv_bytes_ex` → wasi-libc `arc4random_buf` → the WASI preview1 import `wasi_snapshot_preview1.random_get`. The ComponentizeJS splicer (`stub_wasi.rs`, `stub_preview1`) replaces that import with an `unreachable` body unconditionally, before the preview1 adapter would have mapped it to `wasi:random/random.get-random-bytes`. `getRandomValues` is unaffected because it calls `wasi:random` directly. Tracked upstream as [ComponentizeJS#334](https://github.com/bytecodealliance/ComponentizeJS/issues/334).

The fix (`patches/componentize-js-preview1-random-get.patch`) only stubs `random_get` when the `random` feature is disabled, i.e. together with the other `wasi:random` stubs.

## Versions

| | |
| --- | --- |
| `@bytecodealliance/componentize-js` | 0.23.0 (published, bundled by jco 1.42.0), 0.24.0 (latest) |
| `@bytecodealliance/jco` | 1.42.0 |
| `aws-jwt-verify` | 5.2.1 |
| wasmtime | 51.0.0 (downloaded to `.tools/` on first run, or set `WASMTIME`) |

No network access or AWS account is needed to run: keys, signatures, the JWT and its JWKS are generated locally with `node:crypto` at build time.

## Run

Requires Node.js 22. `fix` additionally needs cargo with the `wasm32-wasip1` target.

```sh
./use-toolchain.sh published     # or: latest | workaround | fix
npm run build                    # dist/guest.wasm; add -- --debug for symbolized backtraces
npm run repro                    # one wasmtime instance per step, writes results/<mode>.json
```

| Mode | Toolchain |
| --- | --- |
| `published` | componentize-js 0.23.0 as locked |
| `latest` | componentize-js 0.24.0 |
| `workaround` | 0.23.0; `scripts/workaround.mjs` renames the `random_get` import around `splicer.stubWasi` so the stub misses it and the preview1 adapter wires it to `wasi:random`. No rebuild of ComponentizeJS needed |
| `fix` | 0.24.0 with the splicer rebuilt from ComponentizeJS 0.24.0 plus the patch (`CJS_FIX_DIR=/path/to/ComponentizeJS` uses a local checkout instead) |

Steps (`src/guest.js`, exported as `run(step)`, invoked with `wasmtime run -S http --invoke 'run("<step>")'`):

| Step | What it does |
| --- | --- |
| `hmac` | `importKey("raw")` HMAC SHA-256 + `sign` |
| `get-random-values` | `crypto.getRandomValues` |
| `rsa-jwk` | `importKey("jwk")` RSA 2048 public key (RSASSA-PKCS1-v1_5) + `verify` |
| `ec-jwk` | `importKey("jwk")` EC P-256 public key (ECDSA) + `verify` |
| `jwt-rs256` | aws-jwt-verify `JwtRsaVerifier` with a cached local JWKS verifies an RS256 JWT |
| `generate-key` | `subtle.generateKey` (not implemented in StarlingMonkey, unrelated to the trap) |

## Results

Recorded 2026-11-27 with wasmtime 51.0.0 on Linux x86_64 (`results/*.json`).

| Step | published 0.23.0 | latest 0.24.0 | workaround (0.23.0) | fix (0.24.0 + patch) |
| --- | --- | --- | --- | --- |
| `hmac` | ok | ok | ok | ok |
| `get-random-values` | ok | ok | ok | ok |
| `rsa-jwk` | trap `unreachable` (exit 134) | trap `unreachable` (exit 134) | ok, verify true | ok, verify true |
| `ec-jwk` | trap `unreachable` (exit 134) | trap `unreachable` (exit 134) | ok, verify true | ok, verify true |
| `jwt-rs256` | trap `unreachable` (exit 134) | trap `unreachable` (exit 134) | ok | ok |
| `generate-key` | TypeError: subtle.generateKey is not a function | same | same | same |

Backtrace of `rsa-jwk` with a debug build (`results/published-debug.json`):

```
starling-raw.wasm!random_get              <- unreachable stub inserted by the splicer
starling-raw.wasm!arc4random_buf
starling-raw.wasm!RAND_priv_bytes_ex
starling-raw.wasm!bnrand
starling-raw.wasm!bnrand_range
starling-raw.wasm!BN_priv_rand_range_ex
starling-raw.wasm!ossl_bn_miller_rabin_is_prime
starling-raw.wasm!ossl_rsa_sp800_56b_check_public
starling-raw.wasm!ossl_rsa_validate_public
starling-raw.wasm!rsa_validate
starling-raw.wasm!evp_keymgmt_validate
starling-raw.wasm!try_provided_check
starling-raw.wasm!evp_pkey_public_check_combined
starling-raw.wasm!EVP_PKEY_public_check
```

`ec-jwk` takes the same path via `ossl_ec_key_public_check` → `EC_POINT_mul` → `ossl_ec_GFp_simple_field_inv` → `BN_priv_rand_range_ex`.

With the fix, the core module keeps `(import "wasi_snapshot_preview1" "random_get")`, which the preview1 adapter implements with `wasi:random/random.get-random-bytes` (`wasm-tools print dist/guest.wasm | grep random_get`).

## Layout

| Path | |
| --- | --- |
| `src/guest.js` | Component source, one export `run(step)` |
| `wit/world.wit` | Component world |
| `scripts/build.mjs` | esbuild bundle + `componentize()`; applies the workaround in `workaround` mode |
| `scripts/fixtures.mjs` | Generates keys, signatures, JWT and JWKS |
| `scripts/workaround.mjs` | `splicer.stubWasi` wrapper for componentize-js 0.23 |
| `scripts/run.mjs` | Runs each step on wasmtime, records exit code, result or trap and backtrace |
| `use-toolchain.sh` | Switches between the modes above |
| `patches/` | ComponentizeJS fix (splicer change + test) |
| `results/` | Recorded results per mode |
