import { resolve } from "node:path";
import { mkdir, unlink } from "node:fs/promises";
import { getAddressEncoder, isAddress, type Address } from "@solana/addresses";
import { array, grants, object, publicKey, readJson, text, type Json } from "../src/wire.ts";
import { DEVNET_GENESIS, type Control } from "../src/control.ts";
import type { Observe } from "../src/server.ts";

const CATALOGER_REVISION = "37732273c0bf8f921155de11e7949d3888852aa6";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const root = resolve(import.meta.dir, "..");
const cataloger = resolve(process.env.CATALOGER_DIR ?? `${root}/../cataloger`);
const dataDir = `${root}/.data`;
await mkdir(dataDir, { recursive: true });
if (!(await Bun.file(`${cataloger}/Cargo.toml`).exists()))
  throw new Error("Cataloger checkout not found. Set CATALOGER_DIR as described in README.");

function command(args: string[], env = process.env): string {
  const result = Bun.spawnSync(args, { cwd: cataloger, env, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`Command failed: ${args[0]} ${args[1]}`);
  return result.stdout.toString();
}

if (command(["git", "rev-parse", "HEAD"]).trim() !== CATALOGER_REVISION)
  throw new Error(`Cataloger must be checked out at ${CATALOGER_REVISION}. See README.`);
command(["git", "diff", "--quiet", "HEAD"]);
command(["cargo", "build", "--locked", "-p", "catalyst-indexer", "--bin", "authorization-api"]);
const binary = `${resolve(cataloger, process.env.CARGO_TARGET_DIR ?? "target")}/debug/authorization-api`;
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? `sqlite://${dataDir}/observations-${CATALOGER_REVISION}.db`,
};
const fixtures = `${cataloger}/services/catalyst-indexer/tests/fixtures`;
const definitions = [
  { name: "Subscriptions", files: ["owner-pull-60.json", "revoke-cancelled-after.json"] },
  { name: "SPL delegate", files: ["spl-snapshot.json"] },
];
const scenarios = definitions.map(({ name, files }) => {
  const records = files.map((file) =>
    object(readJson(command([binary, "import", `${fixtures}/catalog.json`, `${fixtures}/${file}`], env))),
  );
  for (const record of records) command([binary, "replay", text(record.id)], env);
  const latest = object(readJson(command([binary, "latest", text(records.at(-1)!.id)], env)));
  const first = records[0]!;
  const permissions = grants(first.projection);
  const target = object(array(object(first.snapshot).targets)[0]);
  const source = publicKey(target.source);
  const direct = permissions.find(
    (grant) => object(grant.resource).id === source && object(grant.subject).kind === "identity",
  );
  if (!direct) throw new Error("Native fixture has no observed source owner.");
  const owner = text(object(direct.subject).value);
  const derived = permissions.find((grant) => object(grant.authority_kind).kind === "derived");
  const merchant = derived ? text(object(array(object(derived.principal).value)[0]).value) : null;
  const examples = [
    { label: "Source account", address: source },
    { label: "Owner", address: owner },
  ];
  if (merchant) examples.push({ label: "Merchant", address: merchant });
  const snapshots = records.map((record) => ({
    id: text(record.id),
    slot: String(object(object(record.snapshot).observation).slot),
  }));
  return { name, scope: text(latest.scope_id), live: false, snapshots, examples };
});

async function rpc(method: string, params: Json[] = []): Promise<Json> {
  const response = await fetch(process.env.RPC_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const reply = object(readJson(await response.text()));
  if (reply.result === undefined) throw new Error(`RPC ${method} failed.`);
  return reply.result;
}

async function run(args: string[]): Promise<string> {
  const child = Bun.spawn(args, { cwd: cataloger, env, stdout: "pipe", stderr: "inherit" });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`Command failed: ${args[1]}`);
  return output;
}

let control: Control | null = null;
let observe: Observe | undefined;
if (process.env.RPC_URL) {
  if (!process.env.PUBLIC_RPC_URL || !process.env.LIVE_CATALOG)
    throw new Error("Live control requires RPC_URL, PUBLIC_RPC_URL and LIVE_CATALOG.");
  const network = process.env.LIVE_NETWORK ?? "devnet";
  if (network !== "devnet" && network !== "localnet") throw new Error("Unsupported live network.");
  const rpcUrl = new URL(process.env.PUBLIC_RPC_URL);
  if (!["http:", "https:"].includes(rpcUrl.protocol) || rpcUrl.username || rpcUrl.password)
    throw new Error("PUBLIC_RPC_URL must be a browser-safe HTTP endpoint.");
  const cluster = text(await rpc("getGenesisHash"));
  if (cluster === MAINNET_GENESIS || (network === "devnet") !== (cluster === DEVNET_GENESIS))
    throw new Error(`LIVE_NETWORK=${network} does not describe the cluster behind RPC_URL (${cluster}).`);
  const catalog = resolve(process.env.LIVE_CATALOG);
  const verified = array(readJson(await Bun.file(catalog).text()))
    .map(object)
    .some(
      (version) =>
        version.cluster === cluster &&
        object(version.adapter).protocol === "spl-token" &&
        version.executable != null &&
        object(version.executable).runtime != null,
    );
  if (!verified)
    throw new Error(`LIVE_CATALOG has no SPL Token deployment with runtime evidence for cluster ${cluster}.`);
  control = { rpcUrl: rpcUrl.href, network, cluster };
  const bytes = (address: string) => Array.from(getAddressEncoder().encode(address as Address));
  observe = async (source) => {
    try {
      // Discovery only names witness accounts; Cataloger reads and decodes the finalized batch itself.
      const info = object(
        await rpc("getAccountInfo", [source, { encoding: "jsonParsed", commitment: "finalized" }]),
      );
      const witnesses: string[] = [];
      const data = info.value === null ? null : object(info.value).data;
      if (data !== null && !Array.isArray(data) && object(data).program === "spl-token") {
        const token = object(object(object(data).parsed).info);
        for (const key of [token.owner, token.delegate])
          if (typeof key === "string" && isAddress(key)) witnesses.push(key);
      }
      const scope = `${dataDir}/scope-${crypto.randomUUID()}.json`;
      await Bun.write(
        scope,
        JSON.stringify({
          cluster,
          accounts: witnesses.map(bytes),
          targets: [{ kind: "spl_delegate", source: bytes(source) }],
          min_context_slot: null,
        }),
      );
      let record: string;
      try {
        record = await run([binary, "observe", catalog, scope]);
      } finally {
        await unlink(scope);
      }
      return new Response(await run([binary, "latest", text(object(readJson(record)).id)]), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch {
      return Response.json({ error: "Live observation failed. Check the token account." }, { status: 502 });
    }
  };
  const example = process.env.LIVE_SOURCE;
  if (example && !isAddress(example)) throw new Error("LIVE_SOURCE must be a token account address.");
  scenarios.push({
    name: network === "devnet" ? "Devnet SPL token account" : "Local validator SPL token account",
    scope: "",
    live: true,
    snapshots: [],
    examples: example ? [{ label: "Demo token account", address: example }] : [],
  });
}

const runtimePort = Number(process.env.RUNTIME_PORT ?? 8890);
const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
const runtime = Bun.spawn([binary, "serve", `127.0.0.1:${runtimePort}`], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});
let server: ReturnType<typeof Bun.serve> | undefined;
async function shutdown() {
  server?.stop(true);
  runtime.kill("SIGINT");
  await runtime.exited;
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (runtime.exitCode !== null) throw new Error("Observation API exited before startup.");
    try {
      ready = (await fetch(`${runtimeUrl}/scopes/${scenarios[0]!.scope}`)).ok;
      if (ready) break;
    } catch {
      /* The API may still be binding its socket. */
    }
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Observation API did not start.");
  // Bun's generated HTML manifest resolves asset paths from the working directory.
  if (process.argv.includes("--production")) process.chdir(`${root}/dist`);
  const { createServer } = await import(
    process.argv.includes("--production") ? "../dist/server.js" : "../src/server.ts"
  );
  server = createServer(
    runtimeUrl,
    scenarios,
    Number(process.env.PORT ?? 3000),
    process.env.HOST ?? "127.0.0.1",
    control,
    observe,
  );
  console.log(`Catalyst demo: ${server!.url}`);
  const exitCode = await runtime.exited;
  server?.stop(true);
  process.exitCode = exitCode;
} catch (error) {
  await shutdown();
  throw error;
}
