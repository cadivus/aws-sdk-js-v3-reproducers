import { JwtRsaVerifier } from "aws-jwt-verify";

// Injected by scripts/build.mjs (generated with node:crypto at build time).
const F = FIXTURES;
const subtle = crypto.subtle;
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const data = new TextEncoder().encode(F.data);
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const EC = { name: "ECDSA", namedCurve: "P-256" };

const steps = {
  hmac: async () => {
    const key = await subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return `${key.type} key, sig ${(await subtle.sign("HMAC", key, data)).byteLength} bytes`;
  },
  "get-random-values": async () => `${crypto.getRandomValues(new Uint8Array(16)).length} bytes`,
  "rsa-jwk": async () => {
    const key = await subtle.importKey("jwk", F.rsaJwk, RSA, false, ["verify"]);
    return `${key.type} key, verify ${await subtle.verify(RSA, key, b64(F.rsaSig), data)}`;
  },
  "ec-jwk": async () => {
    const key = await subtle.importKey("jwk", F.ecJwk, EC, false, ["verify"]);
    return `${key.type} key, verify ${await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64(F.ecSig), data)}`;
  },
  "jwt-rs256": async () => {
    const verifier = JwtRsaVerifier.create({ issuer: F.issuer, audience: F.audience, jwksUri: F.jwksUri });
    verifier.cacheJwks(F.jwks);
    return `sub ${(await verifier.verify(F.jwt)).sub}`;
  },
  "generate-key": async () => {
    const key = await subtle.generateKey({ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, false, ["sign"]);
    return key.publicKey.type;
  },
};

export async function run(step) {
  if (!steps[step]) return JSON.stringify({ ok: false, error: `unknown step ${step}; expected ${Object.keys(steps).join(", ")}` });
  try {
    return JSON.stringify({ ok: true, result: await steps[step]() });
  } catch (e) {
    return JSON.stringify({ ok: false, error: `${e?.name}: ${e?.message}` });
  }
}
