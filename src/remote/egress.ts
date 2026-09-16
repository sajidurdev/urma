import { lookup as dnsLookup } from "node:dns/promises";
import {
  Agent,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP, connect as netConnect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { UrmaError } from "../core/errors.js";

export type RemoteTargetPurpose =
  | "input"
  | "redirect"
  | "manifest"
  | "fragment"
  | "caption"
  | "storyboard";

export type RemoteTarget = Readonly<{
  url: string;
  purpose: RemoteTargetPurpose;
}>;

export type SafeProxyLog = Readonly<{
  kind: "http" | "connect";
  method: string;
  origin: string;
  address: string | null;
  port: number | null;
  outcome: "connected" | "rejected" | "failed";
}>;

export type LookupAddress = Readonly<{
  address: string;
  family: 4 | 6;
}>;

export type SafeProxyOptions = Readonly<{
  connectionTimeoutMs?: number;
  maxConnections?: number;
  maxHeadersBytes?: number;
  lookup?: (hostname: string) => Promise<readonly LookupAddress[]>;
  dial?: (address: string, port: number, family: 4 | 6) => Socket;
  onLog?: (entry: SafeProxyLog) => void;
}>;

type ValidatedTarget = Readonly<{
  parsed: URL;
  address: string;
  family: 4 | 6;
  port: number;
}>;

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_HEADERS_BYTES = 64 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function reject(message: string): never {
  throw new UrmaError("UNSUPPORTED_SOURCE", message, {
    detail: { remoteAdmission: "rejected" },
  });
}

function ipv4Octets(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) {
    return null;
  }
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return null;
  return numbers as [number, number, number, number];
}

function inIpv4(
  value: [number, number, number, number],
  prefix: [number, number, number, number],
  mask: [number, number, number, number],
): boolean {
  return value.every((part, index) => (part & mask[index]!) === prefix[index]);
}

function ipv4IsForbidden(value: string): boolean {
  const octets = ipv4Octets(value);
  if (!octets) return true;
  const ranges: Array<{
    prefix: [number, number, number, number];
    mask: [number, number, number, number];
  }> = [
    { prefix: [0, 0, 0, 0], mask: [255, 0, 0, 0] }, // unspecified/current network
    { prefix: [10, 0, 0, 0], mask: [255, 0, 0, 0] }, // RFC 1918
    { prefix: [100, 64, 0, 0], mask: [255, 192, 0, 0] }, // carrier-grade NAT
    { prefix: [127, 0, 0, 0], mask: [255, 0, 0, 0] }, // loopback
    { prefix: [169, 254, 0, 0], mask: [255, 255, 0, 0] }, // link-local/metadata
    { prefix: [172, 16, 0, 0], mask: [255, 240, 0, 0] }, // RFC 1918
    { prefix: [192, 0, 0, 0], mask: [255, 255, 255, 0] }, // IETF protocol assignments
    { prefix: [192, 0, 2, 0], mask: [255, 255, 255, 0] }, // documentation
    { prefix: [192, 88, 99, 0], mask: [255, 255, 255, 0] }, // 6to4 relay anycast
    { prefix: [192, 168, 0, 0], mask: [255, 255, 0, 0] }, // RFC 1918
    { prefix: [198, 18, 0, 0], mask: [255, 254, 0, 0] }, // benchmark
    { prefix: [198, 51, 100, 0], mask: [255, 255, 255, 0] }, // documentation
    { prefix: [203, 0, 113, 0], mask: [255, 255, 255, 0] }, // documentation
    { prefix: [224, 0, 0, 0], mask: [224, 0, 0, 0] }, // multicast/reserved
    { prefix: [240, 0, 0, 0], mask: [240, 0, 0, 0] }, // reserved/future use
  ];
  if (octets[0] === 168 && octets[1] === 63 && octets[2] === 129 && octets[3] === 16) {
    return true; // Azure platform metadata endpoint
  }
  return ranges.some((range) => inIpv4(octets, range.prefix, range.mask));
}

function ipv6Words(value: string): number[] | null {
  if (value.includes("%")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const values = part.split(":");
    const output: number[] = [];
    for (const item of values) {
      if (!/^[0-9a-f]{1,4}$/iu.test(item)) return null;
      output.push(Number.parseInt(item, 16));
    }
    return output;
  };
  const left = parse(halves[0] ?? "");
  const right = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!left || !right || left.length + right.length > 8) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing === 0)) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function ipv6InPrefix(words: readonly number[], prefix: readonly number[], bits: number): boolean {
  let remaining = bits;
  for (let index = 0; remaining > 0; index += 1) {
    const width = Math.min(16, remaining);
    const mask = width === 16 ? 0xffff : (0xffff << (16 - width)) & 0xffff;
    if (((words[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false;
    remaining -= width;
  }
  return true;
}

function ipv6IsForbidden(value: string): boolean {
  const words = ipv6Words(value);
  if (!words) return true;
  const allZero = words.every((word) => word === 0);
  if (allZero || words.every((word, index) => index < 7 ? word === 0 : word === 1)) return true;
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (mapped) {
    const mappedIpv4 = `${words[6]! >> 8}.${words[6]! & 0xff}.${words[7]! >> 8}.${words[7]! & 0xff}`;
    return ipv4IsForbidden(mappedIpv4);
  }
  if (ipv6InPrefix(words, [0xfc00], 7)) return true; // ULA
  if (ipv6InPrefix(words, [0xfe80], 10)) return true; // link-local
  if (ipv6InPrefix(words, [0xff00], 8)) return true; // multicast
  if (ipv6InPrefix(words, [0, 0, 0, 0, 0, 0], 96)) return true; // deprecated IPv4-compatible
  if (ipv6InPrefix(words, [0x2001, 0x0db8], 32)) return true; // documentation
  if (ipv6InPrefix(words, [0x2001, 0x0000], 32)) return true; // protocol assignments
  if (ipv6InPrefix(words, [0x2001, 0x0002], 48)) return true; // benchmarking
  if (ipv6InPrefix(words, [0x2001, 0x0010], 28)) return true; // ORCHID
  if (ipv6InPrefix(words, [0x2001, 0x0020], 28)) return true; // ORCHIDv2
  if (ipv6InPrefix(words, [0x3fff], 20)) return true; // documentation
  if (ipv6InPrefix(words, [0x100], 64)) return true; // discard-only prefix
  return false;
}

/** Validate a literal address after Safe Proxy DNS resolution */
export function assertResolvedRemoteAddressAllowed(address: string): void {
  const version = isIP(address);
  if (version === 4 && !ipv4IsForbidden(address)) return;
  if (version === 6 && !ipv6IsForbidden(address)) return;
  reject(`Remote target address ${JSON.stringify(address)} is private, reserved, local, or otherwise disallowed`);
}

function hostnameIsForbidden(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, "");
  return normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "local" ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".onion") ||
    normalized.endsWith(".i2p") ||
    normalized.endsWith(".home.arpa");
}

/** Validate URL syntax before opening a proxy connection */
export function assertRemoteTargetAllowed(target: RemoteTarget): URL {
  let parsed: URL;
  try {
    parsed = new URL(target.url);
  } catch {
    reject(`Remote ${target.purpose} target is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    reject(`Remote ${target.purpose} target must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) {
    reject(`Remote ${target.purpose} target must not contain userinfo`);
  }
  if (hostnameIsForbidden(parsed.hostname)) {
    reject(`Remote ${target.purpose} target uses a local or non-public hostname`);
  }
  const defaultPort = parsed.protocol === "https:" ? "443" : "80";
  if (parsed.port !== "" && parsed.port !== defaultPort) {
    reject(`Remote ${target.purpose} target uses a disallowed port`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
  const version = isIP(hostname);
  if (version === 4 && ipv4IsForbidden(hostname)) {
    reject(`Remote ${target.purpose} target uses a private or reserved IPv4 address`);
  }
  if (version === 6 && ipv6IsForbidden(hostname)) {
    reject(`Remote ${target.purpose} target uses a private or reserved IPv6 address`);
  }
  return parsed;
}

export function assertRedirectTargetAllowed(url: string): URL {
  return assertRemoteTargetAllowed({ url, purpose: "redirect" });
}

export function assertSubresourceTargetAllowed(
  url: string,
  purpose: Exclude<RemoteTargetPurpose, "input" | "redirect">,
): URL {
  return assertRemoteTargetAllowed({ url, purpose });
}

/** Keep proxy variables out of child environments */
export function assertNoProxyEnvironment(environment: NodeJS.ProcessEnv): void {
  const proxyNames = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ];
  if (proxyNames.some((name) => environment[name] !== undefined)) {
    reject("Remote child environment must not contain proxy bypass or proxy configuration");
  }
}

async function defaultLookup(hostname: string): Promise<readonly LookupAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((item) => ({
    address: item.address,
    family: item.family === 6 ? 6 : 4,
  }));
}

function defaultDial(address: string, port: number, family: 4 | 6): Socket {
  return netConnect({ host: address, port, family, noDelay: true });
}

function publicOrigin(url: URL): string {
  return url.origin;
}

function forwardedRequestHeaders(headers: IncomingHttpHeaders, host: string): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    output[name] = value;
  }
  output.host = host;
  return output;
}

function responseHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    output[name] = value;
  }
  return output;
}

function sendProxyError(response: ServerResponse, status: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { connection: "close", "content-length": "0" });
  response.end();
}

function waitForConnect(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error("Safe Proxy upstream connection timed out"));
      socket.destroy();
    }, timeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectPromise(error);
      else resolve();
    };
    const onConnect = () => finish();
    const onError = (error: Error) => finish(error);
    const onTimeout = () => finish(new Error("Safe Proxy upstream connection timed out"));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
    if (socket.readyState === "open") finish();
  });
}

export class SafeProxy {
  readonly #options: Required<Pick<SafeProxyOptions, "connectionTimeoutMs" | "maxConnections" | "maxHeadersBytes">> & SafeProxyOptions;
  #server: Server | null = null;
  #startPromise: Promise<string> | null = null;
  #proxyUrl: string | null = null;
  #closed = false;
  readonly #sockets = new Set<Socket>();
  readonly #logs: SafeProxyLog[] = [];

  constructor(options: SafeProxyOptions = {}) {
    const connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    const maxHeadersBytes = options.maxHeadersBytes ?? DEFAULT_MAX_HEADERS_BYTES;
    if (!Number.isSafeInteger(connectionTimeoutMs) || connectionTimeoutMs < 1) {
      throw new RangeError("Safe Proxy connectionTimeoutMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxConnections) || maxConnections < 1) {
      throw new RangeError("Safe Proxy maxConnections must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxHeadersBytes) || maxHeadersBytes < 1024) {
      throw new RangeError("Safe Proxy maxHeadersBytes must be at least 1024 bytes");
    }
    this.#options = {
      ...options,
      connectionTimeoutMs,
      maxConnections,
      maxHeadersBytes,
    };
  }

  get proxyUrl(): string | null {
    return this.#proxyUrl;
  }

  get logs(): readonly SafeProxyLog[] {
    return [...this.#logs];
  }

  async start(): Promise<string> {
    if (this.#closed) throw new UrmaError("CANCELLED", "Safe Proxy is closed");
    if (this.#proxyUrl) return this.#proxyUrl;
    if (this.#startPromise) return await this.#startPromise;
    this.#startPromise = new Promise<string>((resolve, rejectPromise) => {
      const server = createServer(
        { maxHeaderSize: this.#options.maxHeadersBytes },
        (request, response) => {
          void this.#handleHttp(request, response);
        },
      );
      server.maxConnections = this.#options.maxConnections;
      server.headersTimeout = this.#options.connectionTimeoutMs;
      // A CONNECT tunnel can outlive the HTTP request body
      // Bound it by the owning subprocess/session deadline
      server.requestTimeout = 0;
      server.keepAliveTimeout = 5_000;
      server.on("connect", (request, client, head) => {
        void this.#handleConnect(request, client, head);
      });
      server.on("connection", (socket) => {
        this.#sockets.add(socket);
        socket.setNoDelay(true);
        socket.once("close", () => this.#sockets.delete(socket));
        if (this.#sockets.size > this.#options.maxConnections) socket.destroy();
      });
      server.on("clientError", (_error, socket) => socket.destroy());
      server.once("error", (error) => {
        if (this.#server === server) this.#server = null;
        rejectPromise(error);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          rejectPromise(new Error("Safe Proxy did not expose a loopback address"));
          return;
        }
        this.#server = server;
        this.#proxyUrl = `http://127.0.0.1:${address.port}`;
        resolve(this.#proxyUrl);
      });
    });
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  close(): void {
    this.#closed = true;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = null;
    this.#proxyUrl = null;
    server?.close();
  }

  async #resolveTarget(url: string, purpose: RemoteTargetPurpose): Promise<ValidatedTarget> {
    const parsed = assertRemoteTargetAllowed({ url, purpose });
    const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
    const literalFamily = isIP(hostname);
    let addresses: readonly LookupAddress[];
    if (literalFamily === 4 || literalFamily === 6) {
      addresses = [{ address: hostname, family: literalFamily }];
    } else {
      let resolved: readonly LookupAddress[];
      try {
        resolved = await (this.#options.lookup ?? defaultLookup)(hostname);
      } catch (error) {
        throw new UrmaError(
          "SOURCE_UNAVAILABLE",
          "Safe Proxy DNS resolution failed for the remote destination",
          { retryable: true, cause: error },
        );
      }
      if (resolved.length === 0) {
        throw new UrmaError(
          "SOURCE_UNAVAILABLE",
          "Safe Proxy DNS resolution returned no addresses for the remote destination",
          { retryable: true },
        );
      }
      addresses = resolved;
    }
    const unique = new Map<string, LookupAddress>();
    for (const candidate of addresses) {
      const family = isIP(candidate.address);
      if (family !== 4 && family !== 6) {
        reject("Safe Proxy DNS returned an invalid address family");
      }
      if (candidate.family !== family) {
        reject("Safe Proxy DNS returned an address/family mismatch");
      }
      assertResolvedRemoteAddressAllowed(candidate.address);
      unique.set(`${family}:${candidate.address}`, {
        address: candidate.address,
        family,
      });
    }
    const selected = [...unique.values()][0];
    if (!selected) throw new Error("Safe Proxy selected no validated address");
    const defaultPort = parsed.protocol === "https:" ? 443 : 80;
    return {
      parsed,
      address: selected.address,
      family: selected.family,
      port: Number(parsed.port || defaultPort),
    };
  }

  #dial(address: string, port: number, family: 4 | 6): Socket {
    const socket = (this.#options.dial ?? defaultDial)(address, port, family);
    socket.setTimeout(this.#options.connectionTimeoutMs, () => socket.destroy());
    socket.once("connect", () => socket.setTimeout(0));
    return socket;
  }

  #record(entry: SafeProxyLog): void {
    if (this.#logs.length >= 5_000) this.#logs.shift();
    this.#logs.push(entry);
    this.#options.onLog?.(entry);
  }

  async #handleHttp(
    request: import("node:http").IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const rawUrl = request.url;
    if (!rawUrl || !/^https?:\/\//iu.test(rawUrl)) {
      sendProxyError(response, 400);
      return;
    }
    let parsed: URL;
    try {
      parsed = assertRemoteTargetAllowed({ url: rawUrl, purpose: "input" });
    } catch {
      this.#record({
        kind: "http",
        method: request.method ?? "GET",
        origin: "unknown",
        address: null,
        port: null,
        outcome: "rejected",
      });
      sendProxyError(response, 403);
      return;
    }
    let target: ValidatedTarget;
    try {
      target = await this.#resolveTarget(rawUrl, "input");
    } catch {
      this.#record({
        kind: "http",
        method: request.method ?? "GET",
        origin: publicOrigin(parsed),
        address: null,
        port: null,
        outcome: "rejected",
      });
      sendProxyError(response, 403);
      return;
    }
    const agent = new Agent({
      keepAlive: false,
      maxSockets: 1,
    });
    agent.createConnection = () => this.#dial(target.address, target.port, target.family);
    const outgoing = httpRequest({
      host: target.address,
      port: target.port,
      method: request.method,
      path: `${target.parsed.pathname}${target.parsed.search}`,
      headers: forwardedRequestHeaders(request.headers, target.parsed.host),
      agent,
    }, (incoming) => {
      this.#record({
        kind: "http",
        method: request.method ?? "GET",
        origin: publicOrigin(target.parsed),
        address: target.address,
        port: target.port,
        outcome: "connected",
      });
      response.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, responseHeaders(incoming.headers));
      incoming.pipe(response);
      incoming.once("end", () => agent.destroy());
    });
    outgoing.once("error", () => {
      agent.destroy();
      this.#record({
        kind: "http",
        method: request.method ?? "GET",
        origin: publicOrigin(target.parsed),
        address: target.address,
        port: target.port,
        outcome: "failed",
      });
      sendProxyError(response, 502);
    });
    request.once("aborted", () => outgoing.destroy());
    request.pipe(outgoing);
  }

  async #handleConnect(
    request: import("node:http").IncomingMessage,
    client: Duplex,
    head: Buffer,
  ): Promise<void> {
    const authority = request.url ?? "";
    let parsed: URL;
    let portText: string;
    try {
      if (authority.startsWith("[")) {
        const close = authority.indexOf("]");
        if (close < 0 || authority[close + 1] !== ":") throw new Error("invalid authority");
        portText = authority.slice(close + 2);
      } else {
        const separator = authority.lastIndexOf(":");
        if (separator < 1) throw new Error("invalid authority");
        portText = authority.slice(separator + 1);
      }
      if (portText !== "443" || !/^\d{1,5}$/u.test(portText)) throw new Error("disallowed port");
      parsed = assertRemoteTargetAllowed({ url: `https://${authority}/`, purpose: "input" });
      if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("invalid authority");
    } catch {
      this.#record({
        kind: "connect",
        method: "CONNECT",
        origin: "unknown",
        address: null,
        port: null,
        outcome: "rejected",
      });
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    let target: ValidatedTarget;
    try {
      target = await this.#resolveTarget(`https://${authority}/`, "input");
    } catch {
      this.#record({
        kind: "connect",
        method: "CONNECT",
        origin: publicOrigin(parsed),
        address: null,
        port: 443,
        outcome: "rejected",
      });
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = this.#dial(target.address, 443, target.family);
    try {
      await waitForConnect(upstream, this.#options.connectionTimeoutMs);
    } catch {
      upstream.destroy();
      this.#record({
        kind: "connect",
        method: "CONNECT",
        origin: publicOrigin(parsed),
        address: target.address,
        port: 443,
        outcome: "failed",
      });
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    this.#record({
      kind: "connect",
      method: "CONNECT",
      origin: publicOrigin(parsed),
      address: target.address,
      port: 443,
      outcome: "connected",
    });
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    client.once("error", closeBoth);
    upstream.once("error", closeBoth);
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  }
}
