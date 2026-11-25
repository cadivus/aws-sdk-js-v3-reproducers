import { build } from "esbuild";
import { mkdir, readFile, stat, writeFile, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["web", "wasm"];

const browserBuild = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["browser"],
  mainFields: ["browser", "module", "main"],
  metafile: true,
  logLevel: "warning",
};

const xmlBuilderDir = () => {
  const requireFromCore = createRequire(createRequire(path.join(ROOT, "package.json")).resolve("@aws-sdk/core/package.json"));
  return path.dirname(requireFromCore.resolve("@aws-sdk/xml-builder/package.json"));
};

const xmlParserModules = (metafile) =>
  Object.keys(metafile.inputs)
    .filter((p) => p.includes("xml-builder/dist-es/"))
    .map((p) => p.slice(p.indexOf("xml-builder/")));

const buildWeb = async () => {
  const outdir = path.join(DIST, "web");
  await mkdir(outdir, { recursive: true });
  const { metafile } = await build({
    ...browserBuild,
    entryPoints: {
      "main.bundle": path.join(ROOT, "runtimes/web-worker/main.js"),
      "web-worker.bundle": path.join(ROOT, "runtimes/web-worker/worker.js"),
    },
    outdir,
  });
  await copyFile(path.join(ROOT, "runtimes/web-worker/index.html"), path.join(outdir, "index.html"));
  return xmlParserModules(metafile);
};

const buildWasm = async () => {
  const { componentize } = await import("@bytecodealliance/componentize-js");
  const { _setPreopens } = await import("@bytecodealliance/preview2-shim/filesystem");
  const outdir = path.join(DIST, "wasm");
  await mkdir(outdir, { recursive: true });
  const bundlePath = path.join(outdir, "guest.bundle.js");
  const { metafile } = await build({
    ...browserBuild,
    entryPoints: [path.join(ROOT, "runtimes/wasm-component/guest.js")],
    external: ["wasi:*"],
    outfile: bundlePath,
  });
  // preview2-shim >= 0.30 no longer preopens "/" by default; componentize-js needs it to read the WIT.
  _setPreopens({ "/": "/" });
  const { component } = await componentize({
    sourcePath: bundlePath,
    witPath: path.join(ROOT, "runtimes/wasm-component/wit"),
    worldName: "guest",
  });
  const wasmPath = path.join(outdir, "guest.wasm");
  await writeFile(wasmPath, component);
  console.log(`wasm: ${path.relative(ROOT, wasmPath)} (${((await stat(wasmPath)).size / 1048576).toFixed(1)} MiB)`);
  return xmlParserModules(metafile);
};

const builders = { web: buildWeb, wasm: buildWasm };
const unknown = targets.filter((t) => !builders[t]);
if (unknown.length) {
  console.error(`unknown target(s): ${unknown.join(", ")}; expected ${Object.keys(builders).join(", ")}`);
  process.exit(2);
}

const pkgDir = xmlBuilderDir();
const { version } = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
const mode = await readFile(path.join(ROOT, ".sdk-mode"), "utf8").then((s) => s.trim(), () => "published");
console.log(`@aws-sdk/xml-builder ${version} (${mode}) from ${path.relative(ROOT, pkgDir)}`);
for (const target of targets) {
  const modules = await builders[target]();
  console.log(`${target}: xml-builder modules bundled: ${modules.join(", ")}`);
}
