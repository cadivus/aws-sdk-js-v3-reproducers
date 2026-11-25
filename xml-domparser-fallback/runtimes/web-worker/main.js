import { runAwsCalls } from "../../src/aws-calls.js";

const inWorker = (options) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./web-worker.bundle.js", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }) => {
      worker.terminate();
      resolve(data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(options);
  });

window.repro = {
  window: (options) => runAwsCalls(options),
  worker: inWorker,
};
