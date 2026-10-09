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
