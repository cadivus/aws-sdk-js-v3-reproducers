import { runAwsCalls } from "../../src/aws-calls.js";

export default {
  async fetch(request, env) {
    const bucket = new URL(request.url).searchParams.get("bucket") ?? undefined;
    try {
      const report = await runAwsCalls({
        region: env.AWS_REGION,
        endpoint: env.AWS_ENDPOINT_URL || undefined,
        bucket,
        credentials: {
          accessKeyId: env.AWS_ACCESS_KEY_ID,
          secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
          ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
        },
      });
      return Response.json(report, { status: report.ok ? 200 : 500 });
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 });
    }
  },
};
