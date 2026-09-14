import path from "node:path";
import { loadConfig, type UrmaConfig } from "./config.js";
import { EvidenceService } from "./evidence/service.js";
import { BlobStore } from "./store/blob-store.js";
import { SqliteStore } from "./store/sqlite-store.js";
import { SafeProxy } from "./remote/egress.js";
import type { RemoteOperationContext } from "./remote/worker.js";

export async function openUrma(
  config: UrmaConfig = loadConfig(),
) {
  const store = await SqliteStore.open(path.join(config.dataDir, "urma.db"));
  const blobs = new BlobStore(path.join(config.dataDir, "blobs"));
  await blobs.initialize();
  const safeProxy = new SafeProxy();
  const context: RemoteOperationContext = { safeProxy };
  const evidence = new EvidenceService(config, store, blobs, context);
  let closed = false;
  return {
    config,
    store,
    blobs,
    evidence,
    remoteContext: context,
    close() {
      if (closed) return;
      closed = true;
      if ("close" in safeProxy && typeof safeProxy.close === "function") safeProxy.close();
      store.close();
    },
  };
}
