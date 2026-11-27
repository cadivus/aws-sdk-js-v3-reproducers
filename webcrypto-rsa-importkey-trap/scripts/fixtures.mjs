import { createSign, generateKeyPairSync, sign } from "node:crypto";

const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** Fresh RSA 2048 / EC P-256 keys, signatures over `data` and an RS256 JWT with its JWKS. */
export const createFixtures = () => {
  const data = "webcrypto-rsa-importkey-trap";
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rsaJwk = rsa.publicKey.export({ format: "jwk" });
  const ecJwk = ec.publicKey.export({ format: "jwk" });
  const issuer = "https://issuer.example.invalid";
  const kid = "reproducer-rsa";
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url({ alg: "RS256", kid, typ: "JWT" })}.${b64url({ iss: issuer, aud: "reproducer", sub: "user-1", iat: now, exp: now + 365 * 86400 })}`;
  const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(rsa.privateKey).toString("base64url")}`;
  return {
    data,
    rsaJwk,
    rsaSig: sign("sha256", Buffer.from(data), rsa.privateKey).toString("base64"),
    ecJwk,
    ecSig: sign("sha256", Buffer.from(data), { key: ec.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64"),
    issuer,
    audience: "reproducer",
    jwksUri: `${issuer}/.well-known/jwks.json`,
    jwks: { keys: [{ ...rsaJwk, kid, alg: "RS256", use: "sig" }] },
    jwt,
  };
};
