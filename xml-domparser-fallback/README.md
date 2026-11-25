# xml-domparser-fallback

Reproducer for `ReferenceError: DOMParser is not defined` when AWS SDK for
JavaScript v3 deserializes XML responses in a JavaScript runtime that resolves
the SDK's browser build but has no `DOMParser`.

`@aws-sdk/xml-builder` maps its XML parser to `dist-es/xml-parser.browser.js`
through the `browser` and `react-native` fields in `package.json`. That file
calls `new DOMParser()`. The runtimes below resolve that build but don't define
`DOMParser`:

| Runtime | How it is run here | `DOMParser` |
| --- | --- | --- |
| Cloudflare workerd | `wrangler dev`, no `nodejs_compat` | undefined |
| Chromium, dedicated Web Worker | headless Chromium via `playwright-core`; the same page also runs the calls on the main thread as a control | undefined in the worker, defined on the main thread |
| WebAssembly component (ComponentizeJS / StarlingMonkey) | `wasmtime serve` | undefined |

The HTML spec declares `DOMParser` as `[Exposed=Window]`, so every worker
scope lacks it. That includes service workers such as Manifest V3 extension
background scripts, although this reproducer only runs a dedicated Worker.

Each runtime makes three read-only calls covering both XML protocols:

- STS `GetCallerIdentity` (awsQuery)
- S3 `ListBuckets` (restXml)
- S3 `ListObjectsV2` (restXml)

The calls go to a local stub with SigV4-signed requests. Its XML includes
`&amp; &lt; &quot; &apos;` and numeric character references. Real AWS is
optional.

Related: [aws/aws-sdk-js-v3#7375](https://github.com/aws/aws-sdk-js-v3/issues/7375)
(closed) and [#7426](https://github.com/aws/aws-sdk-js-v3/pull/7426) (merged).
#7426 moved `new DOMParser()` from module load into `parseXML`, so importing no
longer throws, but parsing still does.

## Versions

- `@aws-sdk/client-sts` and `@aws-sdk/client-s3` 3.1177.0, which pull in
  `@aws-sdk/xml-builder` 3.972.43
- wrangler 4.168.0
- Chromium 158 (headless)
- `@bytecodealliance/componentize-js` 0.23.0 and `@bytecodealliance/jco` 1.42.0
- wasmtime 39.0.1 (downloaded on first run)
- Node.js 22

## Run

```sh
./use-sdk.sh published      # npm ci: the published @aws-sdk/xml-builder
npm run build               # browser bundles + dist/wasm/guest.wasm
npm run repro               # all runtimes against the local stub
npm run repro -- --aws      # also real AWS (credentials from `aws configure export-credentials`)
npm run repro -- workerd    # a single runtime: workerd | web | wasm

./use-sdk.sh fix            # swap in @aws-sdk/xml-builder built from the fix branch
npm run build && npm run repro
```

`./use-sdk.sh fix` does the following:

1. Sparse-clones `packages-internal/xml-builder` from
   [`cadivus/aws-sdk-js-v3@fix/xml-parser-domparser-fallback`](https://github.com/cadivus/aws-sdk-js-v3/tree/fix/xml-parser-domparser-fallback).
2. Transpiles it with esbuild into the published layout (`dist-es`,
   `dist-cjs`).
3. Replaces the single `node_modules/@aws-sdk/xml-builder`.

Options:

- `SDK_FIX_DIR=/path/to/aws-sdk-js-v3` uses a local checkout instead of
  cloning.
- `SDK_FIX_REPO` and `SDK_FIX_BRANCH` override the defaults.

Chromium:

- `CHROME_PATH` selects the browser.
- Otherwise `/usr/bin/google-chrome` or `/usr/bin/chromium` is used.
- If neither exists, run `npx playwright-core install chromium` first.

The stub serves the test page under `/__repro/`, so the page, the worker and
the API calls are all same-origin. The page is only run against the stub.

## Results

Recorded on 2026-11-25 (linux-x64). Full output, including stack traces, is in
[`results/published.json`](results/published.json) and
[`results/fix.json`](results/fix.json). Real-AWS identifiers are redacted.

| Runtime | published 3.972.43 | fix branch |
| --- | --- | --- |
| stub / workerd | 3 × `ReferenceError: DOMParser is not defined` | 3 × PASS |
| stub / Chromium main thread | 3 × PASS | 3 × PASS |
| stub / Chromium dedicated Worker | 3 × `ReferenceError: DOMParser is not defined` | 3 × PASS |
| stub / wasm component | 3 × `ReferenceError: DOMParser is not defined` | 3 × PASS |
| real AWS / workerd | STS, ListBuckets: `ReferenceError` (ListObjectsV2 not reached) | 3 × PASS |
| real AWS / wasm component | STS, ListBuckets: `ReferenceError` (ListObjectsV2 not reached) | 3 × PASS |

"PASS" against the stub means the parsed values are exactly what the stub
sent. For example, the `ListObjectsV2` keys are
`tom & jerry <cartoons>.txt`, `café-é.png` and `quote-"apos-'.json`.

Published package, workerd:

```
[stub/workerd] DOMParser undefined
  FAIL sts:GetCallerIdentity: ReferenceError: DOMParser is not defined
  FAIL s3:ListBuckets: ReferenceError: DOMParser is not defined
  FAIL s3:ListObjectsV2: ReferenceError: DOMParser is not defined
```

```
ReferenceError: DOMParser is not defined
    at parseXML (.wrangler/tmp/dev-*/worker.js:10370:5)
    at XmlShapeDeserializer.parseXml (.wrangler/tmp/dev-*/worker.js:10603:21)
```

The SDK wraps the error as `ReferenceError: DOMParser is not defined\n
Deserialization error: to see the raw response, inspect the hidden field
{error}.$response on this object.`

## Layout

```
src/aws-calls.js                 the three SDK calls, shared by every runtime
runtimes/workerd/                module worker + wrangler.toml
runtimes/web-worker/             page, main-thread control and dedicated Worker
runtimes/wasm-component/         StarlingMonkey fetch-event guest + WIT (wasi:cli/environment, wasi:http 0.2.10)
scripts/stub-server.mjs          local STS/S3 XML stub (requires SigV4), serves /__repro/ static files
scripts/build.mjs                esbuild (platform browser, browser condition) + componentize
scripts/build-xml-builder.mjs    builds @aws-sdk/xml-builder from a source checkout
scripts/run.mjs                  runs the runtimes, prints a summary, writes results/<mode>.json
use-sdk.sh                       published | fix
```
