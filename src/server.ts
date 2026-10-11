import index from "./index.html";
import { isAddress } from "@solana/addresses";

export function createServer(runtime: string, scenarios: unknown, port: number, hostname = "127.0.0.1") {
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
      const action = /^\/api\/snapshots\/([a-f0-9]{64})\/actions\/revoke\/([^/]+)(\/verify)?$/.exec(
        url.pathname,
      );
      const receipt = /^\/api\/verifications\/revoke\/[a-f0-9]{64}$/.test(url.pathname);
      const scenariosPath = url.pathname === "/api/scenarios";
      if (
        (!match && !action && !receipt && !scenariosPath) ||
        (match?.[4] && !isAddress(match[4])) ||
        (action && !isAddress(action[2]!))
      )
        return new Response("Not found", { status: 404 });
      const method = action ? "POST" : "GET";
      if (request.method !== method)
        return new Response("Method not allowed", { status: 405, headers: { Allow: method } });
      if (scenariosPath) return Response.json(scenarios);
      // Cross-origin browser requests cannot supply this header without a CORS preflight.
      if (action && request.headers.get("X-Velon-Action") !== "revoke")
        return new Response("Action header required", { status: 403 });
      if (
        action?.[3] &&
        request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      )
        return new Response("JSON body required", { status: 415 });
      const body = action ? await request.arrayBuffer() : undefined;
      if (action && !action[3] && body!.byteLength)
        return new Response("Simulation requires an empty body", { status: 400 });
      try {
        const response = await fetch(new URL(url.pathname.slice(4), runtime), {
          method,
          body,
          headers: action?.[3] ? { "Content-Type": "application/json" } : undefined,
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
