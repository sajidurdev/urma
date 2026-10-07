import { assertRemoteTargetAllowed } from "../remote/egress.js";
import { ensureRemoteProxy, type RemoteOperationContext } from "../remote/worker.js";
import { UrmaError } from "../core/errors.js";

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value);
}

export function mediaInputKind(value: string): "local" | "remote" {
  if (/^https?:\/\//iu.test(value)) return "remote";
  if (!isWindowsDrivePath(value) && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    throw new UrmaError(
      "UNSUPPORTED_SOURCE",
      "Media subprocesses accept local paths or HTTP(S) through Urma's Safe Proxy; the supplied protocol is unsupported",
    );
  }
  return "local";
}

export async function remoteMediaInputArgs(
  value: string,
  context: RemoteOperationContext | null | undefined,
): Promise<string[]> {
  if (mediaInputKind(value) !== "remote") return [];
  assertRemoteTargetAllowed({ url: value, purpose: "input" });
  const proxyUrl = await ensureRemoteProxy(context);
  return [
    "-protocol_whitelist",
    "http,https,tcp,tls,httpproxy",
    "-http_proxy",
    proxyUrl,
  ];
}

export type SubprocessMediaInput = Readonly<{
  args: readonly string[];
  input: string;
  inputFile?: string | undefined;
}>;

/** Keep filesystem media on an inherited regular-file descriptor, never a reusable path. */
export async function subprocessMediaInput(
  value: string,
  context: RemoteOperationContext | null | undefined,
): Promise<SubprocessMediaInput> {
  if (mediaInputKind(value) === "remote") {
    return {
      args: await remoteMediaInputArgs(value, context),
      input: value,
    };
  }
  return {
    args: ["-protocol_whitelist", "fd"],
    input: "fd:",
    inputFile: value,
  };
}
