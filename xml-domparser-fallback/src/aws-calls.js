import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { ListBucketsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const describeError = (err) => ({
  name: err?.name ?? "Error",
  message: String(err?.message ?? err).split("\n")[0],
  stack: typeof err?.stack === "string" ? err.stack.split("\n").slice(0, 3) : undefined,
});

const call = async (name, fn) => {
  try {
    return { call: name, ok: true, result: await fn() };
  } catch (err) {
    return { call: name, ok: false, error: describeError(err) };
  }
};

/**
 * Runs STS GetCallerIdentity, S3 ListBuckets and S3 ListObjectsV2 (all read-only) and reports
 * per call whether the XML response was deserialized.
 *
 * @param {object} options
 * @param {string} [options.region] defaults to us-east-1
 * @param {{accessKeyId: string, secretAccessKey: string, sessionToken?: string}} options.credentials
 * @param {string} [options.endpoint] e.g. the local stub; omit for real AWS
 * @param {string} [options.bucket] bucket for ListObjectsV2; defaults to the first bucket from ListBuckets
 * @returns {Promise<{runtime: {hasDOMParser: boolean}, ok: boolean, results: object[]}>}
 */
export const runAwsCalls = async ({ region = "us-east-1", credentials, endpoint, bucket }) => {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw new Error("credentials.accessKeyId and credentials.secretAccessKey are required");
  }
  const config = { region, credentials, maxAttempts: 1, ...(endpoint ? { endpoint } : {}) };
  const sts = new STSClient(config);
  const s3 = new S3Client({ ...config, forcePathStyle: Boolean(endpoint), followRegionRedirects: true });

  const results = [];
  results.push(
    await call("sts:GetCallerIdentity", async () => {
      const { Account, Arn, UserId } = await sts.send(new GetCallerIdentityCommand({}));
      return { Account, Arn, UserId };
    })
  );

  let firstBucket;
  results.push(
    await call("s3:ListBuckets", async () => {
      const out = await s3.send(new ListBucketsCommand({ MaxBuckets: 5 }));
      firstBucket = out.Buckets?.[0]?.Name;
      return { Owner: out.Owner, Buckets: (out.Buckets ?? []).map((b) => b.Name) };
    })
  );

  const target = bucket || firstBucket;
  if (target) {
    results.push(
      await call("s3:ListObjectsV2", async () => {
        const out = await s3.send(new ListObjectsV2Command({ Bucket: target, MaxKeys: 5 }));
        return { Name: out.Name, KeyCount: out.KeyCount, Keys: (out.Contents ?? []).map((o) => o.Key) };
      })
    );
  } else {
    const listBucketsOk = results[1].ok;
    results.push({
      call: "s3:ListObjectsV2",
      ok: listBucketsOk,
      skipped: listBucketsOk ? "ListBuckets returned no buckets" : "needs a bucket name from ListBuckets",
    });
  }

  return {
    runtime: { hasDOMParser: typeof DOMParser !== "undefined" },
    ok: results.every((r) => r.ok),
    results,
  };
};
