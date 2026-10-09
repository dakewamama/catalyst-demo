import index from "./index.html";
import { isAddress } from "@solana/addresses";

export function createServer(runtime: string, scenarios: unknown, port: number, hostname = "127.0.0.1") {
  return Bun.serve({
    port,
    hostname,
    development: false,
    routes: { "/": index },
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET")
        return new Response("Read-only endpoint", { status: 405, headers: { Allow: "GET" } });
      if (url.pathname === "/api/scenarios") return Response.json(scenarios);
      const match =
        /^\/api\/(snapshots|scopes)\/([a-f0-9]{64})(?:\/(authorizations|effective|graph)\/([^/]+)|\/(coverage))?$/.exec(
          url.pathname,
        );
      if (!match || url.search || (match[4] && !isAddress(match[4])))
        return new Response("Not found", { status: 404 });
      try {
        const response = await fetch(new URL(url.pathname.slice(4), runtime), {
          signal: AbortSignal.timeout(5000),
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
