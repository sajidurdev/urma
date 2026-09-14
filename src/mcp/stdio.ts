import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { openUrma } from "../app.js";
import { buildMcpServer } from "./server.js";

export async function startStdioServer(): Promise<void> {
  const app = await openUrma();
  const handle = serveStdio(() =>
    buildMcpServer(app.evidence, app.store, app.blobs, app.config)
  );
  let closing = false;
  const reportShutdownError = (error: unknown) => {
    process.stderr.write(
      `Urma stdio shutdown failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  };
  async function shutdown() {
    if (closing) return;
    closing = true;
    process.stdin.off("end", onStdinClosed);
    process.stdin.off("close", onStdinClosed);
    await handle.close();
    app.close();
  }
  const onStdinClosed = () => {
    void shutdown().catch(reportShutdownError);
  };
  process.stdin.once("end", onStdinClosed);
  process.stdin.once("close", onStdinClosed);
  process.once("SIGINT", () => {
    void shutdown().catch(reportShutdownError);
  });
  process.once("SIGTERM", () => {
    void shutdown().catch(reportShutdownError);
  });
  process.once("beforeExit", () => {
    app.close();
  });
}
