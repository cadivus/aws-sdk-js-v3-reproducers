import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { startStub, STUB_BUCKET, STUB_KEYS } from "./stub-server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASMTIME_VERSION = "39.0.1";
const STUB_CREDENTIALS = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
const RUNTIMES = ["workerd", "web", "wasm"];

const args = process.argv.slice(2);
const withAws = args.includes("--aws");
const selected = args.filter((a) => !a.startsWith("--"));
const runtimes = selected.length ? selected : RUNTIMES;
if (runtimes.some((r) => !RUNTIMES.includes(r))) {
  console.error(`usage: node scripts/run.mjs [${RUNTIMES.join("|")} ...] [--aws]`);
  process.exit(2);
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const waitFor = async (pattern, getLog, child, name, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} exited with code ${child.exitCode}:\n${getLog()}`);
    if (pattern.test(getLog())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${name} not ready within ${timeoutMs} ms:\n${getLog()}`);
};

const stop = async (child) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
};

const getJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
};

const serve = async ({ name, command, commandArgs, env, ready }) => {
  const child = spawn(command, commandArgs, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    await waitFor(ready, () => log, child, name);
  } catch (err) {
    await stop(child);
    throw err;
  }
  return child;
};

const envVars = (target) => ({
  AWS_REGION: target.region,
  AWS_ACCESS_KEY_ID: target.credentials.accessKeyId,
  AWS_SECRET_ACCESS_KEY: target.credentials.secretAccessKey,
  ...(target.credentials.sessionToken ? { AWS_SESSION_TOKEN: target.credentials.sessionToken } : {}),
  ...(target.endpoint ? { AWS_ENDPOINT_URL: target.endpoint } : {}),
});

const query = (target) => (target.bucket ? `?bucket=${encodeURIComponent(target.bucket)}` : "");

const runWorkerd = async (target) => {
  const dir = await mkdtemp(path.join(tmpdir(), "xml-repro-"));
  const envFile = path.join(dir, ".env");
  await writeFile(envFile, Object.entries(envVars(target)).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  await chmod(envFile, 0o600);
  const port = await freePort();
  const child = await serve({
    name: "wrangler dev",
    command: path.join(ROOT, "node_modules/.bin/wrangler"),
    commandArgs: ["dev", "--config", "runtimes/workerd/wrangler.toml", "--ip", "127.0.0.1", "--port", String(port), "--env-file", envFile, "--show-interactive-dev-session=false"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    ready: /Ready on http/,
  }).finally(() => rm(dir, { recursive: true, force: true }));
  try {
    return await getJson(`http://127.0.0.1:${port}/${query(target)}`);
  } finally {
    await stop(child);
  }
};

const chromePath = () =>
  [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && existsSync(p));

const runWeb = async (target) => {
  if (target.endpoint === undefined) return { skipped: "browser page is only run against the stub (same-origin, no CORS setup)" };
  const { chromium } = await import("playwright-core");
  const executablePath = chromePath();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const page = await browser.newPage();
    await page.goto(`${target.endpoint}/__repro/index.html`);
    await page.waitForFunction(() => window.repro !== undefined, null, { timeout: 30000 });
    const options = { region: target.region, endpoint: target.endpoint, credentials: target.credentials, bucket: target.bucket };
    return {
      browser: `Chromium ${browser.version()}`,
      window: await page.evaluate((o) => window.repro.window(o), options),
      worker: await page.evaluate((o) => window.repro.worker(o), options),
    };
  } finally {
    await browser.close();
  }
};

const wasmtimeBin = async () => {
  if (process.env.WASMTIME) return process.env.WASMTIME;
  const name = `wasmtime-v${WASMTIME_VERSION}-x86_64-linux`;
  const bin = path.join(ROOT, ".tools", name, "wasmtime");
  if (existsSync(bin)) return bin;
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(`install wasmtime ${WASMTIME_VERSION} and set WASMTIME=/path/to/wasmtime`);
  }
  const url = `https://github.com/bytecodealliance/wasmtime/releases/download/v${WASMTIME_VERSION}/${name}.tar.xz`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wasmtime download failed: HTTP ${res.status}`);
  await mkdir(path.join(ROOT, ".tools"), { recursive: true });
  const archive = path.join(ROOT, ".tools", `${name}.tar.xz`);
  await writeFile(archive, Buffer.from(await res.arrayBuffer()));
  execFileSync("tar", ["-xJf", archive, "-C", path.join(ROOT, ".tools")]);
  await rm(archive);
  return bin;
};

const runWasm = async (target) => {
  const wasm = path.join(ROOT, "dist/wasm/guest.wasm");
  if (!existsSync(wasm)) throw new Error("dist/wasm/guest.wasm missing; run npm run build");
  const vars = envVars(target);
  const port = await freePort();
  const child = await serve({
    name: "wasmtime serve",
    command: await wasmtimeBin(),
    commandArgs: ["serve", "-S", "cli=y", "--addr", `127.0.0.1:${port}`, ...Object.keys(vars).flatMap((k) => ["--env", k]), wasm],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...vars },
    ready: /Serving HTTP on/,
  });
  try {
    return await getJson(`http://127.0.0.1:${port}/${query(target)}`);
  } finally {
    await stop(child);
  }
};

const hostAwsCredentials = () => {
  try {
    const out = execFileSync("aws", ["configure", "export-credentials", "--format", "process"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    const c = JSON.parse(out);
    return c.AccessKeyId && c.SecretAccessKey ? { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken } : null;
  } catch {
    return null;
  }
};

const REDACT = {
  "sts:GetCallerIdentity": () => ({ Account: "<redacted>", Arn: "<redacted>", UserId: "<redacted>" }),
  "s3:ListBuckets": (r) => ({ Owner: "<redacted>", Buckets: `<${r.Buckets.length} redacted>` }),
  "s3:ListObjectsV2": (r) => ({ Name: "<redacted>", KeyCount: r.KeyCount, Keys: `<${r.Keys.length} redacted>` }),
};
const redact = (report) =>
  report?.results ? { ...report, results: report.results.map((r) => (r.ok && r.result ? { ...r, result: REDACT[r.call](r.result) } : r)) } : report;

const expectedStub = {
  "sts:GetCallerIdentity": (r) => r.Arn === "arn:aws:sts::111122223333:assumed-role/Stub&Role/session",
  "s3:ListBuckets": (r) => r.Owner?.DisplayName === "stub & owner" && r.Buckets?.join() === `${STUB_BUCKET},second-bucket`,
  "s3:ListObjectsV2": (r) => JSON.stringify(r.Keys) === JSON.stringify(STUB_KEYS.map((k) => k.decoded)),
};

const summarize = (label, report, checkStub) => {
  if (report?.skipped) return console.log(`[${label}] skipped: ${report.skipped}`);
  if (!report?.results) return console.log(`[${label}] ERROR ${report?.error ?? JSON.stringify(report)}`);
  console.log(`[${label}] DOMParser ${report.runtime.hasDOMParser ? "defined" : "undefined"}`);
  for (const r of report.results) {
    if (r.skipped) console.log(`  SKIP ${r.call}: ${r.skipped}`);
    else if (!r.ok) console.log(`  FAIL ${r.call}: ${r.error.name}: ${r.error.message}`);
    else if (checkStub && !expectedStub[r.call](r.result)) console.log(`  WRONG ${r.call}: ${JSON.stringify(r.result)}`);
    else console.log(`  PASS ${r.call}${checkStub ? ` ${JSON.stringify(r.result)}` : ""}`);
  }
};

const mode = (await readFile(path.join(ROOT, ".sdk-mode"), "utf8").catch(() => "published")).trim();
const xmlBuilderVersion = JSON.parse(await readFile(path.join(ROOT, "node_modules/@aws-sdk/xml-builder/package.json"), "utf8")).version;
console.log(`@aws-sdk/xml-builder ${xmlBuilderVersion} (${mode})`);

const stub = await startStub();
const targets = [{ name: "stub", region: "us-east-1", endpoint: stub.url, credentials: STUB_CREDENTIALS, bucket: STUB_BUCKET }];
if (withAws) {
  const credentials = hostAwsCredentials();
  if (credentials) targets.push({ name: "aws", region: process.env.AWS_REGION ?? "us-east-1", credentials });
  else console.log("[aws] no credentials from `aws configure export-credentials`; skipping real AWS");
}

const runners = { workerd: runWorkerd, web: runWeb, wasm: runWasm };
const results = { xmlBuilder: `${xmlBuilderVersion} (${mode})`, date: new Date().toISOString().slice(0, 10), runs: {} };
try {
  for (const target of targets) {
    for (const runtime of runtimes) {
      const label = `${target.name}/${runtime}`;
      let report;
      try {
        report = await runners[runtime](target);
      } catch (err) {
        report = { error: err.message.split("\n")[0] };
      }
      const isStub = target.name === "stub";
      if (runtime === "web" && !report.skipped && !report.error) {
        summarize(`${label} (window)`, report.window, isStub);
        summarize(`${label} (dedicated Worker)`, report.worker, isStub);
      } else {
        summarize(label, report, isStub);
      }
      results.runs[label] = isStub ? report : redact(report);
    }
  }
} finally {
  await stub.close();
}

await mkdir(path.join(ROOT, "results"), { recursive: true });
const outFile = path.join(ROOT, "results", `${mode.split(" ")[0]}.json`);
await writeFile(outFile, JSON.stringify(results, null, 2).replaceAll(ROOT, ".").replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>") + "\n");
console.log(`wrote ${path.relative(ROOT, outFile)}`);
