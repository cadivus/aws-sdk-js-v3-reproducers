import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.join(ROOT, "dist", "web");
const STATIC_PREFIX = "/__repro/";
const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

export const STUB_ACCOUNT = "111122223333";
export const STUB_BUCKET = "stub-bucket";
export const STUB_KEYS = [
  { xml: "tom &amp; jerry &lt;cartoons&gt;.txt", decoded: "tom & jerry <cartoons>.txt" },
  { xml: "caf&#xE9;-&#233;.png", decoded: "café-é.png" },
  { xml: "quote-&quot;apos-&apos;.json", decoded: "quote-\"apos-'.json" },
];

const xml = (res, status, body) => {
  res.writeHead(status, {
    "content-type": "text/xml",
    "content-length": Buffer.byteLength(body),
    "x-amzn-requestid": "stub-request-id",
  });
  res.end(body);
};

const stsGetCallerIdentity = () => `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetCallerIdentityResult>
    <Arn>arn:aws:sts::${STUB_ACCOUNT}:assumed-role/Stub&amp;Role/session</Arn>
    <UserId>AROAEXAMPLEEXAMPLE:session</UserId>
    <Account>${STUB_ACCOUNT}</Account>
  </GetCallerIdentityResult>
  <ResponseMetadata><RequestId>stub-request-id</RequestId></ResponseMetadata>
</GetCallerIdentityResponse>`;

const s3ListBuckets = () => `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner><ID>stub-owner-id</ID><DisplayName>stub &amp; owner</DisplayName></Owner>
  <Buckets>
    <Bucket><Name>${STUB_BUCKET}</Name><CreationDate>2026-01-02T03:04:05.000Z</CreationDate></Bucket>
    <Bucket><Name>second-bucket</Name><CreationDate>2025-06-07T08:09:10.000Z</CreationDate></Bucket>
  </Buckets>
</ListAllMyBucketsResult>`;

const s3ListObjectsV2 = (bucket) => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${bucket}</Name>
  <Prefix></Prefix>
  <KeyCount>${STUB_KEYS.length}</KeyCount>
  <MaxKeys>5</MaxKeys>
  <IsTruncated>false</IsTruncated>
${STUB_KEYS.map(
  (k, i) =>
    `  <Contents><Key>${k.xml}</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified><ETag>&quot;etag${i}&quot;</ETag><Size>${i * 100}</Size><StorageClass>STANDARD</StorageClass></Contents>`
).join("\n")}
</ListBucketResult>`;

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const serveStatic = async (res, pathname) => {
  const name = path.basename(pathname.slice(STATIC_PREFIX.length)) || "index.html";
  const type = STATIC_TYPES[path.extname(name)];
  if (!type) return xml(res, 404, "<Error><Code>NotFound</Code></Error>");
  try {
    const body = await readFile(path.join(WEB_DIR, name));
    res.writeHead(200, { "content-type": type, "content-length": body.length });
    res.end(body);
  } catch {
    xml(res, 404, `<Error><Code>NotFound</Code><Message>${name}; run npm run build</Message></Error>`);
  }
};

/**
 * Local STS + S3 stub returning XML-protocol responses (awsQuery for STS, restXml for S3) with XML
 * entities and numeric character references. API requests must be SigV4-signed (403 otherwise).
 * Files under /__repro/ are served from dist/web so a browser page and its Web Worker are same-origin
 * with the stub.
 *
 * @returns {Promise<{url: string, requests: Array<{method: string, url: string, service: string}>, close: () => Promise<void>}>}
 */
export const startStub = async ({ port = 0, host = "127.0.0.1" } = {}) => {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname.startsWith(STATIC_PREFIX)) return await serveStatic(res, url.pathname);
      const auth = req.headers.authorization ?? "";
      const service = /Credential=[^/]+\/[^/]+\/[^/]+\/([^/]+)\//.exec(auth)?.[1] ?? "unsigned";
      const body = req.method === "POST" ? await readBody(req) : "";
      requests.push({ method: req.method, url: req.url, service });
      if (!auth.startsWith("AWS4-HMAC-SHA256 ")) {
        return xml(res, 403, "<Error><Code>MissingAuthenticationToken</Code><Message>request is not signed</Message></Error>");
      }
      if (service === "sts" && req.method === "POST" && new URLSearchParams(body).get("Action") === "GetCallerIdentity") {
        return xml(res, 200, stsGetCallerIdentity());
      }
      if (service === "s3" && req.method === "GET") {
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length === 0) return xml(res, 200, s3ListBuckets());
        if (segments.length === 1 && url.searchParams.get("list-type") === "2") return xml(res, 200, s3ListObjectsV2(segments[0]));
      }
      return xml(res, 400, `<Error><Code>StubUnsupported</Code><Message>${req.method} ${url.pathname}</Message></Error>`);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  await new Promise((resolve, reject) => server.listen(port, host, resolve).once("error", reject));
  const { port: actualPort } = server.address();
  return {
    url: `http://${host}:${actualPort}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const stub = await startStub({ port: Number(process.env.PORT ?? 4566) });
  console.log(`stub listening on ${stub.url}`);
}
