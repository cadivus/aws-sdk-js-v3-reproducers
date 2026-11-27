import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASMTIME_VERSION = "51.0.0";
const STEPS = ["hmac", "get-random-values", "rsa-jwk", "ec-jwk", "jwt-rs256", "generate-key"];
const steps = process.argv.slice(2).length ? process.argv.slice(2) : STEPS;

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

const parseTrap = (stderr) => {
  const lines = stderr.split("\n");
  const frame = /^\s+\d+:\s+0x[0-9a-f]+ - /;
  const backtrace = lines.filter((l) => frame.test(l)).map((l) => l.replace(frame, "").trim());
  const trap = lines.find((l) => /wasm trap/.test(l)) ?? lines.find((l) => /^\s+\d+: /.test(l) && !frame.test(l)) ?? lines.find(Boolean);
  return { trap: trap?.replace(/^\s*\d+:\s*/, "").trim(), backtrace: backtrace.slice(0, 14) };
};

const wasm = path.join(ROOT, "dist/guest.wasm");
if (!existsSync(wasm)) throw new Error("dist/guest.wasm missing; run npm run build");
const toolchain = JSON.parse(await readFile(path.join(ROOT, "dist/toolchain.json"), "utf8"));
const wasmtime = await wasmtimeBin();
const wasmtimeVersion = execFileSync(wasmtime, ["--version"], { encoding: "utf8" }).trim();

const results = {};
for (const step of steps) {
  // One instance per step: a trap poisons the whole instance.
  const r = spawnSync(wasmtime, ["run", "-S", "http", "--invoke", `run("${step}")`, wasm], { encoding: "utf8", timeout: 120000 });
  const out = r.stdout.trim().replace(/^"|"$/g, "").replace(/\\"/g, '"');
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    parsed = undefined;
  }
  results[step] = r.status === 0 && parsed ? { exitCode: 0, ...parsed } : { exitCode: r.status, ok: false, ...parseTrap(r.stderr) };
  const res = results[step];
  console.log(`${step.padEnd(18)} exit=${res.exitCode} ${res.ok ? "ok    " : "FAILED"} ${res.result ?? res.error ?? res.trap}`);
  if (res.backtrace?.length) console.log(res.backtrace.slice(0, 8).map((f) => `${" ".repeat(20)}at ${f}`).join("\n"));
}

const file = path.join(ROOT, "results", `${toolchain.mode.split(" ")[0]}${toolchain.debugBuild ? "-debug" : ""}.json`);
await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, `${JSON.stringify({ toolchain, wasmtime: wasmtimeVersion, date: new Date().toISOString().slice(0, 10), steps: results }, null, 2)}\n`);
console.log(`wrote ${path.relative(ROOT, file)}`);
