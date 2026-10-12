import index from "./index.html";
import { isAddress } from "@solana/addresses";
import type { Control } from "./control.ts";

export type Observe = (source: string) => Promise<Response>;

export function createServer(
  runtime: string,
  scenarios: unknown,
  port: number,
  hostname = "127.0.0.1",
  control: Control | null = null,
  observe?: Observe,
) {
  return Bun.serve({
    port,
    hostname,
    development: false,
    maxRequestBodySize: 4096,
    routes: { "/": index },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.search) return new Response("Not found", { status: 404 });
      const match =
        /^\/api\/(snapshots|scopes)\/([a-f0-9]{64})(?:\/(authorizations|effective|graph)\/([^/]+)|\/(coverage))?$/.exec(
          url.pathname,
        );
      // Simulation follows the scope: a retained snapshot leaves its finalized bank within a slot.
      const simulate = /^\/api\/scopes\/[a-f0-9]{64}\/actions\/revoke\/([^/]+)$/.exec(url.pathname);
      const verify = /^\/api\/snapshots\/[a-f0-9]{64}\/actions\/revoke\/([^/]+)\/verify$/.exec(url.pathname);
      const action = simulate ?? verify;
      const receipt = /^\/api\/verifications\/revoke\/[a-f0-9]{64}$/.test(url.pathname);
      const scenariosPath = url.pathname === "/api/scenarios";
      const controlPath = url.pathname === "/api/control";
      const observePath = observe && url.pathname === "/api/live/spl/observe";
      if (
        (!match && !action && !receipt && !scenariosPath && !controlPath && !observePath) ||
        (match?.[4] && !isAddress(match[4])) ||
        (action && !isAddress(action[1]!))
      )
        return new Response("Not found", { status: 404 });
      const method = action || observePath ? "POST" : "GET";
      if (request.method !== method)
        return new Response("Method not allowed", { status: 405, headers: { Allow: method } });
      if (scenariosPath) return Response.json(scenarios);
      if (controlPath) return Response.json(control, { headers: { "Cache-Control": "no-store" } });
      // Cross-origin browser requests cannot supply this header without a CORS preflight.
      if (
        request.method === "POST" &&
        request.headers.get("X-Velon-Action") !== (action ? "revoke" : "observe")
      )
        return new Response("Action header required", { status: 403 });
      if (
        (verify || observePath) &&
        request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      )
        return new Response("JSON body required", { status: 415 });
      if (observePath) {
        // Only a validated address leaves this handler; the collector builds everything else.
        let source: unknown;
        try {
          const input: unknown = JSON.parse(await request.text());
          if (input && typeof input === "object" && Object.keys(input).join() === "source")
            source = (input as { source: unknown }).source;
        } catch {
          /* Malformed JSON is rejected below. */
        }
        if (typeof source !== "string" || !isAddress(source))
          return new Response("Token account address required", { status: 400 });
        return observe(source);
      }
      const body = action ? await request.arrayBuffer() : undefined;
      if (simulate && body!.byteLength)
        return new Response("Simulation requires an empty body", { status: 400 });
      try {
        const response = await fetch(new URL(url.pathname.slice(4), runtime), {
          method,
          body,
          headers: verify ? { "Content-Type": "application/json" } : undefined,
          signal: AbortSignal.timeout(action ? 30000 : 5000),
          redirect: "error",
        });
        return new Response(response.body, {
          status: response.status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      } catch {
        return Response.json(
          { error: "The observation provider is unavailable. Try again." },
          { status: 502 },
        );
      }
    },
  });
}
