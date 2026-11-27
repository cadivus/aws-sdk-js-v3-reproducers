import { build } from "esbuild";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createFixtures } from "./fixtures.mjs";
import { applyWorkaround } from "./workaround.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const PKG = path.join(ROOT, "node_modules/@bytecodealliance/componentize-js");

const debugBuild = process.argv.includes("--debug");
const mode = await readFile(path.join(ROOT, ".toolchain-mode"), "utf8").then((s) => s.trim(), () => "published");
const { version } = JSON.parse(await readFile(path.join(PKG, "package.json"), "utf8"));
console.log(`componentize-js ${version} (${mode})${debugBuild ? " debug build" : ""}`);

if (mode.startsWith("workaround")) await applyWorkaround(PKG);
const { componentize } = await import("@bytecodealliance/componentize-js");
const { _setPreopens } = await import("@bytecodealliance/preview2-shim/filesystem");

await mkdir(DIST, { recursive: true });
const bundlePath = path.join(DIST, "guest.bundle.js");
await build({
  entryPoints: [path.join(ROOT, "src/guest.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["browser"],
  define: { FIXTURES: JSON.stringify(createFixtures()) },
  outfile: bundlePath,
  logLevel: "warning",
});

// preview2-shim >= 0.30 no longer preopens "/" by default; componentize-js needs it to read the WIT.
_setPreopens({ "/": "/" });
const { component } = await componentize({ sourcePath: bundlePath, witPath: path.join(ROOT, "wit"), worldName: "guest", debugBuild });
const wasmPath = path.join(DIST, "guest.wasm");
await writeFile(wasmPath, component);
await writeFile(path.join(DIST, "toolchain.json"), JSON.stringify({ componentizeJs: version, mode, debugBuild }));
console.log(`wasm: ${path.relative(ROOT, wasmPath)} (${((await stat(wasmPath)).size / 1048576).toFixed(1)} MiB)`);
