import { afterEach, expect, test } from "bun:test";
import { createServer } from "../src/server.ts";

const servers: { stop: (force?: boolean) => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test("proxy preserves raw native u64 and only exposes read paths", async () => {
  const body = '{"amount":18446744073709551615}';
  const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(body) });
  const server = createServer(String(upstream.url), [], 0);
  servers.push(upstream, server);
  const path = `${server.url}api/snapshots/${"a".repeat(64)}`;
  expect(await (await fetch(path)).text()).toBe(body);
  expect((await fetch(path, { method: "POST" })).status).toBe(405);
  expect((await fetch(`${server.url}api/arbitrary`)).status).toBe(404);
  expect((await fetch(`${path}?upstream=https://example.com`)).status).toBe(404);
  expect((await fetch(`${path}/authorizations/invalid`)).status).toBe(404);
});

test("provider failure is explicit and existing conflict status survives", async () => {
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(null, { status: 409 }),
  });
  const server = createServer(String(upstream.url), [], 0);
  servers.push(upstream, server);
  const path = `${server.url}api/scopes/${"a".repeat(64)}`;
  expect((await fetch(path)).status).toBe(409);
  upstream.stop(true);
  expect((await fetch(path)).status).toBe(502);
});

const revokePath = `/api/snapshots/${"a".repeat(64)}/actions/revoke/11111111111111111111111111111111`;
const actionHeaders = { "X-Velon-Action": "revoke" };

test("revoke simulation forwards only the canonical request and preserves evidence bytes", async () => {
  const body = '{"amount":18446744073709551615,"signing_transaction":"unchanged"}';
  const received: string[] = [];
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received.push(request.method, new URL(request.url).pathname, await request.text());
      expect(request.headers.get("Authorization")).toBeNull();
      return new Response(body);
    },
  });
  const server = createServer(String(upstream.url), [], 0);
  servers.push(upstream, server);
  const response = await fetch(new URL(revokePath, server.url), {
    method: "POST",
    headers: { ...actionHeaders, Authorization: "must-not-forward" },
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(body);
  expect(response.headers.get("Content-Type")).toBe("application/json");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(received).toEqual(["POST", revokePath.slice(4), ""]);
});

test("verification forwards signed bytes unchanged and retains pending, conflict and failure responses", async () => {
  const signed = '{ "signed_transaction" : "AQAB+/==" }';
  let upstreamStatus = 404;
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe(`${revokePath.slice(4)}/verify`);
      expect(request.method).toBe("POST");
      expect(request.headers.get("Content-Type")).toBe("application/json");
      expect(await request.text()).toBe(signed);
      return new Response('{"slot":18446744073709551615}', { status: upstreamStatus });
    },
  });
  const server = createServer(String(upstream.url), [], 0);
  servers.push(upstream, server);
  for (const status of [404, 409, 422, 500, 200]) {
    upstreamStatus = status;
    const response = await fetch(new URL(`${revokePath}/verify`, server.url), {
      method: "POST",
      headers: { ...actionHeaders, "Content-Type": "application/json; charset=utf-8" },
      body: signed,
    });
    expect(response.status).toBe(status);
    expect(await response.text()).toBe('{"slot":18446744073709551615}');
  }
});

test("action allowlist rejects invalid requests before contacting the runtime", async () => {
  let calls = 0;
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      calls++;
      return new Response("unexpected");
    },
  });
  const server = createServer(String(upstream.url), [], 0);
  servers.push(upstream, server);
  const post = { method: "POST", headers: actionHeaders };
  const cases: [string, RequestInit, number][] = [
    [revokePath, {}, 405],
    [revokePath, { method: "OPTIONS" }, 405],
    [revokePath, { method: "POST" }, 403],
    [revokePath, { ...post, body: "unexpected" }, 400],
    [`${revokePath}/verify`, { ...post, body: "{}" }, 415],
    [`${revokePath}?rpc=https://example.com`, post, 404],
    [`${revokePath}/send`, post, 404],
    [revokePath.replace("a".repeat(64), "A".repeat(64)), post, 404],
    [revokePath.replace("11111111111111111111111111111111", "invalid"), post, 404],
    ["/api/scenarios?unexpected=1", {}, 404],
  ];
  for (const [path, options, expected] of cases) {
    const response = await fetch(new URL(path, server.url), options);
    expect(response.status).toBe(expected);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  }
  const oversized = await fetch(new URL(`${revokePath}/verify`, server.url), {
    ...post,
    headers: { ...actionHeaders, "Content-Type": "application/json" },
    body: " ".repeat(4097),
  });
  expect(oversized.status).toBe(413);
  expect(calls).toBe(0);
});

test("retained verification is read-only and forwards the exact evidence path", async () => {
  const path = `/api/verifications/revoke/${"b".repeat(64)}`;
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      expect(new URL(request.url).pathname).toBe(path.slice(4));
      return new Response('{"finalized_slot":18446744073709551615}');
    },
  });
  const server = createServer(String(upstream.url), [], 0);
  servers.push(upstream, server);
  expect(await (await fetch(new URL(path, server.url))).text()).toBe(
    '{"finalized_slot":18446744073709551615}',
  );
  expect((await fetch(new URL(path, server.url), { method: "POST" })).status).toBe(405);
  for (const invalid of [`${path}?x=1`, `${path}/extra`, path.replace("b".repeat(64), "b".repeat(63))])
    expect((await fetch(new URL(invalid, server.url))).status).toBe(404);
});

test("action redirects and provider failures cannot become a success or a second request", async () => {
  let calls = 0;
  const upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      calls++;
      return new Response(null, { status: 307, headers: { Location: "/elsewhere" } });
    },
  });
  const server = createServer(String(upstream.url), [], 0);
  servers.push(upstream, server);
  const post = { method: "POST", headers: actionHeaders };
  expect((await fetch(new URL(revokePath, server.url), post)).status).toBe(502);
  expect(calls).toBe(1);
  upstream.stop(true);
  expect((await fetch(new URL(revokePath, server.url), post)).status).toBe(502);
});
