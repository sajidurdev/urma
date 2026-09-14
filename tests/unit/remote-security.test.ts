import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import test from "node:test";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import { once } from "node:events";
import {
  assertRedirectTargetAllowed,
  assertRemoteTargetAllowed,
  assertResolvedRemoteAddressAllowed,
  assertSubresourceTargetAllowed,
  SafeProxy,
} from "../../src/remote/egress.js";
import {
  isRemoteOperationContext,
  requireRemoteOperationContext,
} from "../../src/remote/worker.js";

type HttpResponse = Readonly<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}>;

async function listenHttp(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, port: address.port };
}

async function listenTcp(
  handler: (socket: Socket) => void,
): Promise<{ server: ReturnType<typeof createTcpServer>; port: number }> {
  const server = createTcpServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return { server, port: address.port };
}

function requestThroughProxy(proxyUrl: string, target: string): Promise<HttpResponse> {
  const proxy = new URL(proxyUrl);
  const destination = new URL(target);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        path: target,
        method: "GET",
        headers: { host: destination.host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("remote URL admission accepts only HTTP(S) public default-port targets", () => {
  assert.equal(
    assertRemoteTargetAllowed({
      url: "https://cdn.example.test/video.mp4",
      purpose: "input",
    }).hostname,
    "cdn.example.test",
  );
  assert.equal(
    assertSubresourceTargetAllowed(
      "https://cdn.example.test/fragment-1.ts",
      "fragment",
    ).protocol,
    "https:",
  );
  for (const url of [
    "ftp://cdn.example.test/a",
    "file:///etc/passwd",
    "https://user:pass@cdn.example.test/a",
    "https://cdn.example.test:8443/a",
    "http://localhost/video",
    "http://video.local/internal",
    "http://video.internal/video",
  ]) {
    assert.throws(() => assertRemoteTargetAllowed({ url, purpose: "input" }), url);
  }
});

test("remote address admission rejects private, reserved, metadata, and awkward mapped forms", () => {
  for (const url of [
    "http://127.0.0.1/video",
    "http://127.1/video",
    "http://2130706433/video",
    "http://0x7f000001/video",
    "http://10.0.0.8/video",
    "http://100.64.0.1/video",
    "http://172.16.0.4/video",
    "http://192.168.1.5/video",
    "http://0.0.0.0/video",
    "http://169.254.169.254/latest/meta-data",
    "http://168.63.129.16/metadata",
    "http://[::1]/video",
    "http://[::]/video",
    "http://[::ffff:127.0.0.1]/video",
    "http://[::ffff:192.168.1.1]/video",
    "http://[::192.0.2.1]/video",
    "http://[fc00::1]/video",
    "http://[fe80::1]/video",
    "http://[ff02::1]/video",
    "http://[2001:db8::1]/video",
    "http://[2001:2::1]/video",
    "http://[2001:10::1]/video",
    "http://[3fff::1]/video",
    "http://[100::1]/video",
  ]) {
    assert.throws(
      () => assertRemoteTargetAllowed({ url, purpose: "input" }),
      url,
    );
  }
  for (const address of [
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "::1",
    "::",
    "::ffff:10.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ]) {
    assert.throws(() => assertResolvedRemoteAddressAllowed(address), address);
  }
  assert.doesNotThrow(() => assertResolvedRemoteAddressAllowed("93.184.216.34"));
  assert.doesNotThrow(() => assertResolvedRemoteAddressAllowed("2001:4860:4860::8888"));
});

test("Safe Proxy forwards HTTP to the exact validated public address", async (t) => {
  let receivedHost = "";
  const fixture = await listenHttp((request, response) => {
    receivedHost = request.headers.host ?? "";
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("safe-proxy-ok");
  });
  t.after(() => fixture.server.close());
  const dialed: string[] = [];
  const proxy = new SafeProxy({
    lookup: async (hostname) => {
      assert.equal(hostname, "public.example.test");
      return [{ address: "93.184.216.34", family: 4 }];
    },
    dial: (address) => {
      dialed.push(address);
      return connect({ host: "127.0.0.1", port: fixture.port, family: 4 });
    },
  });
  t.after(() => proxy.close());
  const proxyUrl = await proxy.start();
  const response = await requestThroughProxy(proxyUrl, "http://public.example.test/video.mp4");
  assert.equal(response.status, 200);
  assert.equal(response.body, "safe-proxy-ok");
  assert.equal(receivedHost, "public.example.test");
  assert.deepEqual(dialed, ["93.184.216.34"]);
  assert.equal(proxy.logs.at(-1)?.outcome, "connected");
  assert.equal(proxy.logs.at(-1)?.address, "93.184.216.34");
});

test("Safe Proxy supports HTTPS CONNECT without terminating TLS", async (t) => {
  const fixture = await listenTcp((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
  });
  t.after(() => fixture.server.close());
  const proxy = new SafeProxy({
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    dial: () => connect({ host: "127.0.0.1", port: fixture.port, family: 4 }),
  });
  t.after(() => proxy.close());
  const proxyUrl = await proxy.start();
  const proxyEndpoint = new URL(proxyUrl);
  const client = connect(Number(proxyEndpoint.port), "127.0.0.1");
  t.after(() => client.destroy());
  await once(client, "connect");
  client.write("CONNECT public.example.test:443 HTTP/1.1\r\nHost: public.example.test:443\r\n\r\n");
  const connected = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      const value = Buffer.concat(chunks);
      if (value.includes(Buffer.from("\r\n\r\n"))) {
        client.off("data", onData);
        resolve(value);
      }
    };
    client.on("data", onData);
    client.once("error", reject);
  });
  assert.match(connected.toString("utf8"), /^HTTP\/1\.1 200 Connection Established/mu);
  client.write("tunnel-ok");
  const echoed = await new Promise<Buffer>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      if (chunk.includes(Buffer.from("tunnel-ok"))) {
        client.off("data", onData);
        resolve(chunk);
      }
    };
    client.on("data", onData);
    client.once("error", reject);
  });
  assert.equal(echoed.toString("utf8"), "tunnel-ok");
  assert.equal(proxy.logs.at(-1)?.kind, "connect");
  assert.equal(proxy.logs.at(-1)?.address, "93.184.216.34");
});

test("Safe Proxy keeps an established CONNECT tunnel alive beyond the connect timeout", async (t) => {
  const fixture = await listenTcp((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
  });
  t.after(() => fixture.server.close());
  const proxy = new SafeProxy({
    connectionTimeoutMs: 50,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    dial: () => connect({ host: "127.0.0.1", port: fixture.port, family: 4 }),
  });
  t.after(() => proxy.close());
  const endpoint = new URL(await proxy.start());
  const client = connect(Number(endpoint.port), "127.0.0.1");
  t.after(() => client.destroy());
  await once(client, "connect");
  client.write("CONNECT public.example.test:443 HTTP/1.1\r\nHost: public.example.test:443\r\n\r\n");
  await new Promise<void>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).includes(Buffer.from("\r\n\r\n"))) {
        client.off("data", onData);
        resolve();
      }
    };
    client.on("data", onData);
    client.once("error", reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const echoed = new Promise<Buffer>((resolve, reject) => {
    client.once("data", resolve);
    client.once("error", reject);
  });
  client.write("late-tunnel-data");
  assert.equal((await echoed).toString("utf8"), "late-tunnel-data");
});

test("Safe Proxy rejects mixed public/private DNS answers before dialing", async (t) => {
  let dialCount = 0;
  const proxy = new SafeProxy({
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.10", family: 4 },
    ],
    dial: () => {
      dialCount += 1;
      return connect({ host: "127.0.0.1", port: 1 });
    },
  });
  t.after(() => proxy.close());
  const response = await requestThroughProxy(
    await proxy.start(),
    "http://mixed.example.test/video.mp4",
  );
  assert.equal(response.status, 403);
  assert.equal(dialCount, 0);
  assert.equal(proxy.logs.at(-1)?.outcome, "rejected");
});

test("Safe Proxy rejects DNS address and family mismatches before dialing", async (t) => {
  let dialCount = 0;
  const proxy = new SafeProxy({
    lookup: async () => [{ address: "2001:4860:4860::8888", family: 4 }],
    dial: () => {
      dialCount += 1;
      return connect({ host: "127.0.0.1", port: 1 });
    },
  });
  t.after(() => proxy.close());
  const response = await requestThroughProxy(
    await proxy.start(),
    "http://mismatched.example.test/video.mp4",
  );
  assert.equal(response.status, 403);
  assert.equal(dialCount, 0);
});

test("Safe Proxy resolves and pins each connection independently", async (t) => {
  const fixture = await listenHttp((_request, response) => response.end("ok"));
  t.after(() => fixture.server.close());
  const answers = ["93.184.216.34", "151.101.1.69"];
  let lookupCount = 0;
  const dialed: string[] = [];
  const proxy = new SafeProxy({
    lookup: async () => [{ address: answers[lookupCount++]!, family: 4 }],
    dial: (address) => {
      dialed.push(address);
      return connect({ host: "127.0.0.1", port: fixture.port, family: 4 });
    },
  });
  t.after(() => proxy.close());
  const proxyUrl = await proxy.start();
  assert.equal((await requestThroughProxy(proxyUrl, "http://rebinding.example.test/a")).body, "ok");
  assert.equal((await requestThroughProxy(proxyUrl, "http://rebinding.example.test/b")).body, "ok");
  assert.deepEqual(dialed, answers);
});

test("redirect and subresource destinations are independently revalidated", async (t) => {
  const fixture = await listenHttp((_request, response) => {
    response.writeHead(302, { location: "http://169.254.169.254/metadata" });
    response.end();
  });
  t.after(() => fixture.server.close());
  const proxy = new SafeProxy({
    lookup: async (hostname) => {
      if (hostname === "public.example.test") return [{ address: "93.184.216.34", family: 4 }];
      throw new Error(`unexpected DNS lookup for ${hostname}`);
    },
    dial: () => connect({ host: "127.0.0.1", port: fixture.port, family: 4 }),
  });
  t.after(() => proxy.close());
  const proxyUrl = await proxy.start();
  const first = await requestThroughProxy(proxyUrl, "http://public.example.test/manifest.m3u8");
  assert.equal(first.status, 302);
  const forbidden = await requestThroughProxy(proxyUrl, "http://169.254.169.254/segment.ts");
  assert.equal(forbidden.status, 403);
  assert.equal(proxy.logs.at(-1)?.outcome, "rejected");
  assert.doesNotThrow(() => assertRedirectTargetAllowed("https://public.example.test/next"));
  assert.throws(() => assertRedirectTargetAllowed("http://169.254.169.254/metadata"));
  assert.throws(() => assertSubresourceTargetAllowed("http://169.254.169.254/caption.vtt", "caption"));
  assert.throws(() => assertSubresourceTargetAllowed("http://169.254.169.254/storyboard.mhtml", "storyboard"));
});

test("remote operation context is required instead of an unverified worker claim", () => {
  assert.equal(isRemoteOperationContext(null), false);
  assert.throws(
    () => requireRemoteOperationContext(null),
    /local Safe Proxy/u,
  );
});
