import { runAwsCalls } from "../../src/aws-calls.js";

self.onmessage = async ({ data }) => {
  try {
    self.postMessage(await runAwsCalls(data));
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};
