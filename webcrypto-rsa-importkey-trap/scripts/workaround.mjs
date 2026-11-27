import { pathToFileURL } from "node:url";
import path from "node:path";

const enc = (s) => new TextEncoder().encode(s);
// Import entry: module name "wasi_snapshot_preview1" (len 0x16) followed by field name "random_get" (len 0x0a).
const ORIGINAL = enc("\x16wasi_snapshot_preview1\x0arandom_get");
const HIDDEN = enc("\x16wasi_snapshot_preview1\x0arandom_geT");

const replaceOnce = (bin, from, to) => {
  const bytes = new Uint8Array(bin.buffer || bin, bin.byteOffset ?? 0, bin.byteLength);
  const at = Buffer.from(bytes).indexOf(Buffer.from(from));
  if (at < 0) throw new Error(`workaround: import ${new TextDecoder().decode(from.subarray(1))} not found`);
  const out = new Uint8Array(bytes);
  out.set(to, at);
  return out;
};

/**
 * Workaround for componentize-js <= 0.24: hide the preview1 random_get import from splicer.stubWasi
 * (which replaces it with `unreachable`) so the preview1 adapter wires it to wasi:random instead.
 * Patches the module-level splicer object used by componentize-js 0.23.
 */
export const applyWorkaround = async (packageDir) => {
  const { splicer } = await import(pathToFileURL(path.join(packageDir, "lib/spidermonkey-embedding-splicer.js")));
  if (!splicer?.stubWasi) throw new Error("workaround: splicer.stubWasi not found (needs componentize-js 0.23.x)");
  const stubWasi = splicer.stubWasi;
  splicer.stubWasi = (bin, ...rest) => replaceOnce(stubWasi(replaceOnce(bin, ORIGINAL, HIDDEN), ...rest), HIDDEN, ORIGINAL);
};
