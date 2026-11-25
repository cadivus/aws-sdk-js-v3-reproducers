import { build } from "esbuild";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const [srcPkgDir, outDir] = process.argv.slice(2);
if (!srcPkgDir || !outDir) {
  console.error("usage: node scripts/build-xml-builder.mjs <aws-sdk-js-v3>/packages-internal/xml-builder <outDir>");
  process.exit(2);
}

const pkg = JSON.parse(await readFile(path.join(srcPkgDir, "package.json"), "utf8"));
if (pkg.name !== "@aws-sdk/xml-builder") {
  console.error(`${srcPkgDir} is not @aws-sdk/xml-builder (found ${pkg.name})`);
  process.exit(1);
}

const srcDir = path.join(srcPkgDir, "src");
const sources = (await readdir(srcDir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".spec.ts") && !f.endsWith(".d.ts"));

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Same layout as the published package: unbundled ESM in dist-es (where the browser field remaps
// the parser module) and a single CJS file in dist-cjs. Type declarations are not needed at runtime.
await build({
  entryPoints: sources.map((f) => path.join(srcDir, f)),
  outdir: path.join(outDir, "dist-es"),
  format: "esm",
  platform: "neutral",
  target: "es2022",
  logLevel: "warning",
});
await build({
  entryPoints: [path.join(srcDir, "index.ts")],
  outfile: path.join(outDir, "dist-cjs", "index.js"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  packages: "external",
  logLevel: "warning",
});
for (const file of ["package.json", "README.md", "LICENSE"]) {
  await cp(path.join(srcPkgDir, file), path.join(outDir, file)).catch(() => {});
}
console.log(`built ${pkg.name}@${pkg.version} from ${srcPkgDir} -> ${outDir} (${sources.length} modules)`);
