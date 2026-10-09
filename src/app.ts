import { isAddress } from "@solana/addresses";
import {
  array,
  authorization,
  compare,
  grants,
  integer,
  object,
  permissionLabel,
  principalLabel,
  readJson,
  text,
  writeJson,
  type Json,
  type ObjectValue,
} from "./wire.ts";

type Scenario = {
  name: string;
  scope: string;
  snapshots: { id: string; slot: string }[];
  examples: { label: string; address: string }[];
};
const form = document.querySelector<HTMLFormElement>("#scan-form")!;
const input = document.querySelector<HTMLInputElement>("#address")!;
const select = document.querySelector<HTMLSelectElement>("#scenario")!;
const scanButton = document.querySelector<HTMLButtonElement>("#scan")!;
const results = document.querySelector<HTMLElement>("#results")!;
const detail = document.querySelector<HTMLElement>("#detail")!;
const diff = document.querySelector<HTMLElement>("#diff")!;
const notice = document.querySelector<HTMLElement>("#notice")!;
let scenarios: Scenario[] = [];
let request: AbortController | undefined;
let mode: "scan" | "diff" = "scan";

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  content = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.textContent = content;
  result.className = className;
  return result;
}

async function get(path: string, signal?: AbortSignal): Promise<Json> {
  const response = await fetch(`/api/${path}`, { signal });
  if (!response.ok) {
    if (response.status === 409)
      throw new Error("Conflicting observations at the same slot. No current permission can be shown.");
    if (response.status === 404) throw new Error("No observation is available for this scope.");
    throw new Error("The observation provider is unavailable. Try scanning again.");
  }
  return readJson(await response.text());
}

function status(message: string, error = false) {
  notice.replaceChildren(node("p", message, error ? "error" : "notice"));
}

function raw(title: string, value: Json): HTMLDetailsElement {
  const section = node("details");
  section.append(node("summary", title), node("pre", writeJson(value, 2)));
  return section;
}

function field(title: string, value: string): HTMLElement {
  const row = node("div", "", "field");
  row.append(node("dt", title), node("dd", value));
  return row;
}

function metadata(view: ObjectValue): HTMLElement {
  const observation = object(view.observation);
  const coverage = object(view.coverage);
  const block = node("section", "", "state-meta");
  block.append(
    node(
      "p",
      `${text(observation.origin)} evidence · slot ${integer(observation.slot)} · ${coverage.complete === true ? "Reported complete coverage" : "Partial coverage"}`,
      "eyebrow",
    ),
  );
  block.append(
    node(
      "p",
      "Results describe this observation only. An empty result does not establish that the address has no other permissions.",
      "muted",
    ),
  );
  block.append(
    raw("State and adapter provenance", {
      state_version: view.state_version!,
      observation,
      coverage,
      versions: view.versions!,
      sdk_revision: view.sdk_revision!,
      arm_schema_version: view.arm_schema_version!,
    }),
  );
  return block;
}

function showDetail(grant: ObjectValue, view: ObjectValue, availability: string) {
  results.hidden = true;
  detail.hidden = false;
  detail.replaceChildren();
  const back = node("button", "← Back to permissions", "link-button");
  back.onclick = () => {
    detail.hidden = true;
    results.hidden = false;
  };
  detail.append(
    back,
    node("p", `${text(object(grant.authority_kind).kind)} authority · ${availability}`, "eyebrow"),
  );
  detail.append(node("h2", permissionLabel(grant)), node("p", principalLabel(grant.principal), "address"));
  const facts = node("dl", "", "facts");
  const usage = object(grant.usage);
  facts.append(
    field("Resource", text(object(grant.resource).id)),
    field("Enforcement", text(grant.enforcement)),
    field("Observability", text(grant.observability)),
    field("Lifecycle", text(object(grant.lifecycle).kind)),
    field("Usage", text(usage.kind)),
  );
  if (usage.remaining !== undefined)
    facts.append(
      field(
        "Remaining at observation",
        usage.remaining === null
          ? "Unknown"
          : `${integer(usage.remaining).toLocaleString("en-US")} base units`,
      ),
    );
  detail.append(facts);
  if (object(grant.principal).kind !== "identity")
    detail.append(
      node(
        "p",
        "These principals share one permission and one allowance. The budget is not duplicated for each signer.",
        "notice",
      ),
    );
  if (object(grant.authority_kind).kind === "derived")
    detail.append(
      node(
        "p",
        "This authority depends on its parent grant. Generic availability remains unknown until those dependencies are resolved.",
        "notice",
      ),
    );
  detail.append(
    raw("Full constraints and lineage", {
      constraints: grant.constraints!,
      authority_kind: grant.authority_kind!,
      usage: grant.usage!,
    }),
    raw("Native context and evidence", { native_context: grant.native_context!, evidence: grant.evidence! }),
    raw("Exact ARM authorization", grant),
    metadata(view),
  );
}

function card(grant: ObjectValue, view: ObjectValue, availability: string): HTMLElement {
  const row = node("article", "", "permission");
  const header = node("div", "", "permission-header");
  header.append(
    node("span", `${text(object(grant.authority_kind).kind)} authority`, "badge"),
    node("span", availability, "availability"),
  );
  const principal = node("p", principalLabel(grant.principal), "address");
  const button = node("button", "Inspect evidence →", "link-button");
  button.onclick = () => showDetail(grant, view, availability);
  row.append(
    header,
    node("h3", permissionLabel(grant)),
    principal,
    node("p", `Resource: ${text(object(grant.resource).id)}`, "address muted"),
  );
  const usage = object(grant.usage);
  if (usage.remaining !== undefined)
    row.append(
      node(
        "p",
        usage.remaining === null
          ? "Remaining allowance is unknown."
          : `${integer(usage.remaining).toLocaleString("en-US")} base units remain at this observation.`,
        "remaining",
      ),
    );
  row.append(button);
  return row;
}

function currentScenario(): Scenario {
  const scenario = scenarios[Number(select.value)];
  if (!scenario) throw new Error("No native observation selected.");
  return scenario;
}

async function scan(historical = false) {
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  const address = input.value.trim();
  results.replaceChildren();
  detail.hidden = true;
  scanButton.disabled = false;
  if (!isAddress(address)) {
    status("Enter a valid Solana address.", true);
    return;
  }
  scanButton.disabled = true;
  status("Loading the selected observation...");
  try {
    const scenario = currentScenario();
    const path = historical
      ? `snapshots/${scenario.snapshots[0]!.id}/authorizations/${address}`
      : `scopes/${scenario.scope}/effective/${address}`;
    const view = object(await get(path, signal));
    if (view.arm_schema_version !== "0.1")
      throw new Error("Unsupported ARM schema. Permission interpretation is unavailable.");
    const entries = array(object(view.projection).authorizations ?? []);
    if (object(view.projection).status !== "compiled") {
      grants(view.projection);
    }
    const permissions = entries.map((entry) =>
      historical
        ? { grant: authorization(entry), availability: "Historical grant; availability not evaluated" }
        : {
            grant: authorization(object(entry).authorization),
            availability: text(object(entry).availability),
          },
    );
    const content = document.createDocumentFragment();
    const heading = node("div", "", "section-heading");
    heading.append(node("h2", historical ? "Earlier recorded permissions" : "Current observed permissions"));
    if (scenario.snapshots.length > 1) {
      const toggle = node(
        "button",
        historical ? "View current observation" : `View earlier slot ${scenario.snapshots[0]!.slot}`,
        "link-button",
      );
      toggle.onclick = () => scan(!historical);
      heading.append(toggle);
    }
    content.append(heading, metadata(view));
    if (permissions.length === 0)
      content.append(
        node("p", "No matching authorizations in this observed scope. Coverage is partial.", "empty"),
      );
    else for (const { grant, availability } of permissions) content.append(card(grant, view, availability));
    if (signal.aborted) return;
    results.replaceChildren(content);
    status(`Showing ${scenario.name.toLowerCase()} evidence for the selected address.`);
  } catch (error) {
    if (!signal.aborted) {
      results.replaceChildren();
      status(error instanceof Error ? error.message : "Unable to read the observation.", true);
    }
  } finally {
    if (!signal.aborted) scanButton.disabled = false;
  }
}

async function showDiff() {
  request?.abort();
  request = new AbortController();
  const signal = request.signal;
  diff.replaceChildren();
  const scenario = currentScenario();
  if (scenario.snapshots.length < 2) {
    status("This fixture has one observation. A comparison requires two native states.");
    return;
  }
  status("Comparing the two recorded native states...");
  try {
    const [before, after] = await Promise.all([
      get(`snapshots/${scenario.snapshots[0]!.id}`, signal),
      get(`scopes/${scenario.scope}`, signal),
    ]);
    const changes = compare(before!, after!);
    if (signal.aborted) return;
    diff.append(
      node(
        "h2",
        `Observed changes: slot ${scenario.snapshots[0]!.slot} → ${integer(object(object(object(after).snapshot).observation).slot)}`,
      ),
    );
    diff.append(
      node(
        "p",
        "This compares recorded states across several native transitions. It does not predict a transaction or attribute every change to revoke alone.",
        "notice",
      ),
    );
    if (changes.length === 0)
      diff.append(node("p", "No semantic authorization changes between these observations.", "empty"));
    for (const change of changes) {
      const grant = change.after ?? change.before!;
      const row = node("article", "", "permission");
      row.append(
        node("span", change.kind, "badge"),
        node("h3", `${text(object(grant.authority_kind).kind)} authority: ${permissionLabel(grant)}`),
      );
      row.append(node("p", principalLabel(grant.principal), "address"));
      if (change.before) row.append(raw("Before", change.before));
      if (change.after) row.append(raw("After", change.after));
      diff.append(row);
    }
    diff.append(
      raw("Observation provenance", {
        before: {
          id: object(before).id!,
          observation: object(object(before).snapshot).observation!,
          versions: object(before).versions!,
        },
        after: {
          id: object(after).id!,
          observation: object(object(after).snapshot).observation!,
          versions: object(after).versions!,
        },
      }),
    );
    status("Comparison complete. Source evidence is retained in both records.");
  } catch (error) {
    if (!signal.aborted) {
      diff.replaceChildren();
      status(error instanceof Error ? error.message : "Comparison unavailable.", true);
    }
  }
}

function setMode(next: "scan" | "diff") {
  mode = next;
  results.hidden = next !== "scan";
  diff.hidden = next !== "diff";
  detail.hidden = true;
  document.querySelector("#scan-tab")!.classList.toggle("selected", next === "scan");
  document.querySelector("#diff-tab")!.classList.toggle("selected", next === "diff");
  if (next === "diff") {
    scanButton.disabled = false;
    void showDiff();
  } else void scan();
}

function selectScenario() {
  const scenario = currentScenario();
  const examples = document.querySelector("#examples")!;
  examples.replaceChildren(node("span", "Try a recorded address:", "muted"));
  for (const example of scenario.examples) {
    const button = node("button", example.label, "example");
    button.onclick = () => {
      input.value = example.address;
      setMode("scan");
    };
    examples.append(button);
  }
  input.value = scenario.examples[0]!.address;
  if (mode === "diff") void showDiff();
  else void scan();
}

form.onsubmit = (event) => {
  event.preventDefault();
  setMode("scan");
};
select.onchange = selectScenario;
document.querySelector<HTMLButtonElement>("#scan-tab")!.onclick = () => setMode("scan");
document.querySelector<HTMLButtonElement>("#diff-tab")!.onclick = () => setMode("diff");
try {
  const manifest = array(await get("scenarios"));
  scenarios = manifest.map((value) => {
    const scenario = object(value);
    return {
      name: text(scenario.name),
      scope: text(scenario.scope),
      snapshots: array(scenario.snapshots).map((value) => ({
        id: text(object(value).id),
        slot: text(object(value).slot),
      })),
      examples: array(scenario.examples).map((value) => ({
        label: text(object(value).label),
        address: text(object(value).address),
      })),
    };
  });
  if (scenarios.length === 0) throw new Error("No native observations have been loaded.");
  select.replaceChildren(
    ...scenarios.map((scenario, index) => {
      const option = node("option", scenario.name);
      option.value = String(index);
      return option;
    }),
  );
  select.disabled = false;
  scanButton.disabled = false;
  selectScenario();
} catch (error) {
  status(error instanceof Error ? error.message : "Observations are unavailable.", true);
}
