import { getEnvironment } from "wasi:cli/environment@0.2.10";
import { runAwsCalls } from "../../src/aws-calls.js";

// Read at request time: top-level code runs at build time (Wizer pre-initialization).
const handle = async (request) => {
  const env = Object.fromEntries(getEnvironment());
  const report = await runAwsCalls({
    region: env.AWS_REGION,
    endpoint: env.AWS_ENDPOINT_URL || undefined,
    bucket: new URL(request.url).searchParams.get("bucket") ?? undefined,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    },
  });
  return Response.json(report, { status: report.ok ? 200 : 500 });
};

addEventListener("fetch", (event) =>
  event.respondWith(handle(event.request).catch((err) => Response.json({ ok: false, error: String(err) }, { status: 500 })))
);
