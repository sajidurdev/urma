import { UrmaError } from "../core/errors.js";
import type { SafeProxy } from "./egress.js";

/** The supported local remote-network boundary. */
export type RemoteAcquisitionBoundary = "safe-proxy";

/**
 * A process-local remote operation session. The approved child binaries remain
 * trusted; this context only guarantees that supported network operations are
 * configured with Urma's destination-filtering Safe Proxy.
 */
export type RemoteOperationContext = Readonly<{
  safeProxy: Pick<SafeProxy, "start">;
}>;

export function isRemoteOperationContext(
  context: RemoteOperationContext | null | undefined,
): context is RemoteOperationContext {
  return Boolean(
    context &&
      typeof context === "object" &&
      context.safeProxy &&
      typeof context.safeProxy.start === "function",
  );
}

export function requireRemoteOperationContext(
  context: RemoteOperationContext | null | undefined,
): RemoteOperationContext {
  if (!isRemoteOperationContext(context)) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      "Remote source admission requires Urma's local Safe Proxy",
      {
        detail: {
          remoteAdmission: "safe-proxy-required",
          requiredBoundary: "loopback-safe-proxy",
        },
      },
    );
  }
  return context;
}

export async function ensureRemoteProxy(
  context: RemoteOperationContext | null | undefined,
): Promise<string> {
  const proxyUrl = await requireRemoteOperationContext(context).safeProxy.start();
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch (error) {
    throw new UrmaError("INTERNAL_ERROR", "Urma Safe Proxy returned an invalid endpoint", { cause: error });
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !/^\d+$/.test(parsed.port) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new UrmaError("INTERNAL_ERROR", "Urma Safe Proxy must expose an ephemeral loopback HTTP endpoint");
  }
  return proxyUrl;
}
