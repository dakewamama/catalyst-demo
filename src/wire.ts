import { getAddressDecoder } from "@solana/addresses";
import { parse, parseNumberAndBigInt, stringify } from "lossless-json";

export type Json = null | boolean | string | number | bigint | Json[] | { [key: string]: Json };
export type ObjectValue = { [key: string]: Json };

export const readJson = (value: string): Json =>
  parse(value, undefined, { parseNumber: parseNumberAndBigInt }) as Json;
export const writeJson = (value: Json, space?: number): string => stringify(value, undefined, space)!;

export function object(value: Json | undefined): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed object in runtime response.");
  return value;
}

export function array(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) throw new Error("Malformed array in runtime response.");
  return value;
}

export function text(value: Json | undefined): string {
  if (typeof value !== "string") throw new Error("Malformed text in runtime response.");
  return value;
}

export function integer(value: Json | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error("Malformed integer in runtime response.");
}

export function publicKey(value: Json | undefined): string {
  const bytes = array(value).map(integer);
  if (bytes.length !== 32 || bytes.some((byte) => byte < 0n || byte > 255n))
    throw new Error("Malformed public key.");
  return getAddressDecoder().decode(Uint8Array.from(bytes.map(Number)));
}

export function authorization(value: Json | undefined): ObjectValue {
  const result = object(value);
  if (result.schema_version !== "0.1")
    throw new Error("Unsupported ARM schema. Permission interpretation is unavailable.");
  text(result.id);
  object(result.principal);
  object(result.resource);
  object(result.constraints);
  object(result.usage);
  if (!["direct", "administrative", "derived"].includes(text(object(result.authority_kind).kind)))
    throw new Error("Unsupported authority kind.");
  object(result.lifecycle);
  object(result.evidence);
  object(result.native_context);
  principalLabel(result.principal);
  text(result.capability);
  return result;
}

export function grants(projection: Json | undefined): ObjectValue[] {
  const result = object(projection);
  if (result.status !== "compiled")
    throw new Error(`Permission interpretation is ${text(result.status)}: ${text(result.reason)}`);
  return array(result.authorizations).map(authorization);
}

export function principalLabel(value: Json | undefined): string {
  const principal = object(value);
  switch (principal.kind) {
    case "identity":
      return text(principal.value);
    case "any_of":
      return `Either ${array(principal.value).map(principalLabel).join(" or ")}`;
    case "all_of":
      return `Together: ${array(principal.value).map(principalLabel).join(" and ")}`;
    default:
      throw new Error("Unsupported principal expression.");
  }
}

export function permissionLabel(grant: ObjectValue): string {
  const capability = text(grant.capability).replaceAll("_", " ");
  const verb = capability[0]!.toUpperCase() + capability.slice(1);
  const usage = object(grant.usage);
  const constraints = object(grant.constraints);
  const leaves = constraints.kind === "all" ? array(constraints.value).map(object) : [constraints];
  const amounts = leaves.filter(
    (leaf) => leaf.kind === "constraint" && object(leaf.value).kind === "amount_at_most",
  );
  if (amounts.length !== 1 || leaves.some((leaf) => !["true", "constraint"].includes(text(leaf.kind))))
    return `${verb} under the recorded constraints`;
  const amount = integer(object(amounts[0]!.value).amount);
  if (amount < 0n || amount > 18446744073709551615n) throw new Error("Invalid native amount.");
  const period =
    usage.kind === "recurring"
      ? ` every ${integer(usage.period_seconds).toLocaleString("en-US")} seconds`
      : usage.kind === "cumulative"
        ? " in total"
        : "";
  return `${verb} up to ${amount.toLocaleString("en-US")} base units${period}${leaves.length > 1 ? ", subject to constraints" : ""}`;
}

export type Change = { kind: "added" | "removed" | "changed"; before?: ObjectValue; after?: ObjectValue };

export function semantic(grant: ObjectValue): ObjectValue {
  const { evidence: _, ...meaning } = grant;
  return meaning;
}

function keyed(projection: Json | undefined): Map<string, ObjectValue> {
  const result = new Map<string, ObjectValue>();
  for (const grant of grants(projection)) {
    const id = text(grant.id);
    if (result.has(id)) throw new Error("Ambiguous authorization identity. Comparison is unavailable.");
    result.set(id, grant);
  }
  return result;
}

export function compare(before: Json, after: Json): Change[] {
  const first = object(before);
  const last = object(after);
  const a = object(first.snapshot);
  const b = object(last.snapshot);
  const start = object(a.observation);
  const end = object(b.observation);
  if (
    start.cluster !== end.cluster ||
    start.origin !== end.origin ||
    writeJson(a.targets!) !== writeJson(b.targets!)
  )
    throw new Error("Cannot compare observations from different scopes.");
  if (integer(start.slot) >= integer(end.slot))
    throw new Error("Comparison requires an earlier and a later observed slot.");
  const previous = keyed(first.projection);
  const current = keyed(last.projection);
  const changes: Change[] = [];
  for (const [id, grant] of previous) {
    const next = current.get(id);
    if (!next) changes.push({ kind: "removed", before: grant });
    else if (writeJson(semantic(grant)) !== writeJson(semantic(next)))
      changes.push({ kind: "changed", before: grant, after: next });
  }
  for (const [id, grant] of current) if (!previous.has(id)) changes.push({ kind: "added", after: grant });
  return changes;
}
