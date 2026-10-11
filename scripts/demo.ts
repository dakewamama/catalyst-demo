import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { array, grants, object, publicKey, readJson, text } from "../src/wire.ts";
import { DEVNET_GENESIS, type Control } from "../src/control.ts";

const CATALOGER_REVISION = "b5c3c4adfe607acaf40d611a34e7265c34f93898";
const root = resolve(import.meta.dir, "..");
const cataloger = resolve(process.env.CATALOGER_DIR ?? `${root}/../cataloger`);
const data = `${root}/.data`;
await mkdir(data, { recursive: true });
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
  DATABASE_URL: process.env.DATABASE_URL ?? `sqlite://${data}/observations-${CATALOGER_REVISION}.db`,
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
  return { name, scope: text(latest.scope_id), snapshots, examples };
});

let control: Control | null = null;
if (process.env.LIVE_SNAPSHOT_ID) {
  const id = process.env.LIVE_SNAPSHOT_ID;
  if (!/^[a-f0-9]{64}$/.test(id) || !process.env.RPC_URL || !process.env.PUBLIC_RPC_URL)
    throw new Error("Live control requires LIVE_SNAPSHOT_ID, RPC_URL and PUBLIC_RPC_URL.");
  const network = process.env.LIVE_NETWORK ?? "devnet";
  if (network !== "devnet" && network !== "localnet") throw new Error("Unsupported live network.");
  const rpcUrl = new URL(process.env.PUBLIC_RPC_URL);
  if (!["http:", "https:"].includes(rpcUrl.protocol) || rpcUrl.username || rpcUrl.password)
    throw new Error("PUBLIC_RPC_URL must be a browser-safe HTTP endpoint.");
  const latest = object(readJson(command([binary, "latest", id], env)));
  const record = object(latest.record);
  const snapshot = object(record.snapshot);
  const observation = object(snapshot.observation);
  const targets = array(snapshot.targets);
  if (
    observation.origin !== "finalized" ||
    targets.length !== 1 ||
    object(targets[0]).kind !== "spl_delegate" ||
    (network === "devnet" && observation.cluster !== DEVNET_GENESIS)
  )
    throw new Error("Live control requires a finalized singleton SPL scope on the selected network.");
  control = { scope: text(latest.scope_id), rpcUrl: rpcUrl.href, network };
  scenarios.push({
    name: network === "devnet" ? "Devnet SPL delegate" : "Local validator SPL delegate",
    scope: control.scope,
    snapshots: [{ id: text(record.id), slot: String(observation.slot) }],
    examples: [{ label: "Source account", address: publicKey(object(targets[0]).source) }],
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
  );
  console.log(`Catalyst demo: ${server!.url}`);
  const exitCode = await runtime.exited;
  server?.stop(true);
  process.exitCode = exitCode;
} catch (error) {
  await shutdown();
  throw error;
}
