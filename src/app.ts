import { createSolanaRpc } from "@solana/rpc";
import { signAndSubmitReviewedTransaction } from "catalyst-sdk/src/submit";
import { action, result, reviewRevoke, verifiedRevoke, type Control, type ActionState } from "./control.ts";
import { wallets, signingWallets, type SigningWallet } from "./wallet.ts";
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
  if (
    control &&
    currentScenario().scope === control.scope &&
    connected &&
    object(view.observation).origin === "finalized" &&
    grant.observability === "exact" &&
    object(grant.native_context).protocol === "spl-token" &&
    grant.capability === "spend" &&
    object(grant.authority_kind).kind === "direct" &&
    object(grant.lifecycle).kind === "active" &&
    object(grant.subject).kind === "identity" &&
    object(grant.subject).value === connected.account.address
  ) {
    const revoke = node("button", "Revoke", "action-button");
    revoke.onclick = () => void prepare(grant, view);
    row.append(revoke);
  }
  return row;
}

function currentScenario(): Scenario {
  const scenario = scenarios[Number(select.value)];
  if (!scenario) throw new Error("No native observation selected.");
  return scenario;
}

async function scan(historical = false) {
  invalidateReview();
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
    const live = control?.scope === scenario.scope;
    document.querySelector(".header-links .badge")!.textContent = live
      ? control!.network === "devnet"
        ? "Devnet observation"
        : "Local validator"
      : "Native fixture replay";
    document.querySelector(".scope-note")!.textContent = live
      ? "These permissions come from the latest retained finalized observation. Coverage is partial; review checks must pass before signing."
      : "This replay uses accounts captured from executed native tests. Coverage is partial. Every result is tied to an observed state.";
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
    return true;
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
  if (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState)) return;
  invalidateReview();
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

let control: Control | null = null;
let connected: { wallet: SigningWallet; account: SigningWallet["accounts"][number] } | undefined;
let unsubscribe: (() => void) | undefined;
let actionAbort: AbortController | undefined;
let actionState: ActionState | undefined;
const walletChoice = document.querySelector<HTMLSelectElement>("#wallet-choice")!;
const connectButton = document.querySelector<HTMLButtonElement>("#connect-wallet")!;
const walletStatus = document.querySelector<HTMLElement>("#wallet-status")!;
const review = document.querySelector<HTMLDialogElement>("#revoke-review")!;
const actionResult = document.querySelector<HTMLElement>("#action-result")!;

function invalidateReview() {
  if (actionState === "PREPARING" || actionState === "SIMULATED") {
    actionAbort?.abort();
    review.close();
    actionState = undefined;
  }
}

function refreshWallets() {
  const available = signingWallets();
  walletChoice.replaceChildren(
    ...available.map((wallet, index) => {
      const option = node("option", wallet.name);
      option.value = String(index);
      return option;
    }),
  );
  if (!available.length) walletChoice.append(node("option", "No signing wallet detected"));
  connectButton.disabled = !available.length || !scenarios.length;
}
wallets.on("register", refreshWallets);
wallets.on("unregister", () => {
  if (connected && !wallets.get().includes(connected.wallet)) disconnected();
  refreshWallets();
});
refreshWallets();

function disconnected() {
  actionAbort?.abort();
  review.close();
  connected = undefined;
  walletStatus.textContent = "Wallet changed or disconnected. Connect again to review.";
  if (actionState)
    setAction("FAILED", "Wallet changed. Any submitted transaction must still be checked on chain.");
  void scan();
}
connectButton.onclick = async () => {
  if (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState)) return;
  try {
    invalidateReview();
    const wallet = signingWallets()[Number(walletChoice.value)];
    if (!wallet) throw new Error("Install a Wallet Standard wallet with signTransaction support.");
    const { accounts } = await wallet.features["standard:connect"].connect();
    const account = accounts.find(
      (account) =>
        account.features.includes("solana:signTransaction") &&
        (control?.network !== "devnet" || account.chains.includes("solana:devnet")),
    );
    if (!account) throw new Error("This wallet has no compatible Solana signing account.");
    unsubscribe?.();
    connected = { wallet, account };
    unsubscribe = wallet.features["standard:events"].on("change", disconnected);
    walletStatus.textContent = `${wallet.name}: ${account.address}`;
    if (control) {
      const index = scenarios.findIndex((scenario) => scenario.scope === control!.scope);
      if (index >= 0) select.value = String(index);
    }
    input.value = account.address;
    setMode("scan");
  } catch (error) {
    status(error instanceof Error ? error.message : "Wallet connection failed.", true);
  }
};

function setAction(state: ActionState, message: string) {
  actionState = state;
  actionResult.hidden = false;
  actionResult.replaceChildren(node("h2", state === "VERIFIED" ? "REVOKED" : state), node("p", message));
  const busy = ["PREPARING", "AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(state);
  connectButton.disabled = busy;
  walletChoice.disabled = busy;
  select.disabled = busy;
  scanButton.disabled = busy;
  document
    .querySelectorAll<HTMLButtonElement>(".action-button")
    .forEach((button) => (button.disabled = busy));
}

async function prepare(grant: ObjectValue, view: ObjectValue) {
  if (
    !control ||
    !connected ||
    (actionState && ["AWAITING_SIGNATURE", "SUBMITTING", "FINALIZING"].includes(actionState))
  )
    return;
  actionAbort?.abort();
  actionAbort = new AbortController();
  const signal = actionAbort.signal;
  const session = connected;
  const config = control;
  const stateVersion = text(view.state_version);
  const source = text(object(grant.resource).id);
  const path = `snapshots/${stateVersion}/actions/revoke/${source}`;
  try {
    setAction("PREPARING", "Checking the native revoke simulation...");
    const simulated = await result(await action(path, signal));
    signal.throwIfAborted();
    const prepared = reviewRevoke(simulated, view, grant, session.account.address, config.network);
    setAction("SIMULATED", "Review what your wallet will sign.");
    const title = node("h2", "You are removing");
    title.tabIndex = -1;
    review.replaceChildren(title);
    const facts = node("dl", "", "facts");
    facts.append(
      field("Principal", principalLabel(grant.principal)),
      field("Capability", "Spend"),
      field("Resource", source),
      field("Limit", `${integer(object(grant.usage).remaining)} base units`),
      field("Program", "SPL Token"),
      field("Network", config.network === "devnet" ? "Devnet" : "Local validator"),
      field("Simulation", "Verified"),
      field("Deployment", "Verified"),
    );
    const confirm = node("button", "Confirm in wallet", "action-button");
    const cancel = node("button", "Cancel", "link-button");
    cancel.onclick = () => {
      invalidateReview();
      actionResult.hidden = true;
    };
    review.append(facts, raw("View technical evidence", prepared.evidence), confirm, cancel);
    review.showModal();
    title.focus({ preventScroll: true });
    review.scrollTop = 0;
    confirm.onclick = async () => {
      confirm.disabled = true;
      let submittedSignature: string | undefined;
      try {
        const latest = object(await get(`scopes/${config.scope}`, signal));
        if (latest.id !== stateVersion)
          throw new Error("Permission evidence changed. Scan and review again.");
        signal.throwIfAborted();
        if (connected !== session) throw new Error("Wallet changed. Review again.");
        review.close();
        const sent = await signAndSubmitReviewedTransaction(
          createSolanaRpc(config.rpcUrl),
          prepared.bytes,
          async (bytes) => {
            signal.throwIfAborted();
            if (connected !== session) throw new Error("Wallet changed. Review again.");
            setAction("AWAITING_SIGNATURE", "Confirm the reviewed revoke in your wallet.");
            const signed = await session.wallet.features["solana:signTransaction"].signTransaction({
              account: session.account,
              transaction: bytes,
              ...(config.network === "devnet" ? { chain: "solana:devnet" as const } : {}),
            });
            signal.throwIfAborted();
            if (connected !== session || signed.length !== 1)
              throw new Error("Wallet signing response changed.");
            const current = object(await get(`scopes/${config.scope}`, signal));
            if (current.id !== stateVersion)
              throw new Error("Permission evidence changed while signing. Review again.");
            setAction("SUBMITTING", "Submitting the exact reviewed transaction...");
            return signed[0]!.signedTransaction;
          },
          { ...prepared, abortSignal: signal },
        );
        submittedSignature = sent.signature;
        setAction(
          "FINALIZING",
          sent.status === "unknown"
            ? "Submission response is uncertain. Checking finalization without resending."
            : "Waiting for finalized native verification...",
        );
        actionResult.append(field("Transaction signature", sent.signature));
        for (let attempt = 0; attempt < 60; attempt++) {
          signal.throwIfAborted();
          const response = await action(`${path}/verify`, signal, sent.signedTransaction);
          if (response.status === 404) {
            await new Promise<void>((resolve) => setTimeout(resolve, 2000));
            continue;
          }
          const verification = await result(response);
          const current = await get(`scopes/${config.scope}`, signal);
          const checked = verifiedRevoke(
            verification,
            current,
            stateVersion,
            text(grant.id),
            sent.signedTransaction,
          );
          if (!(await scan()))
            throw new Error("Verification was retained, but current permissions could not be reloaded.");
          signal.throwIfAborted();
          setAction(
            "VERIFIED",
            config.network === "devnet" ? "Verified on chain (devnet)." : "Verified on the local validator.",
          );
          actionResult.append(
            field("Transaction signature", sent.signature),
            field("Finalized slot", String(checked.slot)),
            field("Verification ID", checked.id),
          );
          return;
        }
        throw new Error(
          "Finalization is still unconfirmed. Keep the transaction signature; do not assume revocation or submit again.",
        );
      } catch (error) {
        review.close();

        setAction("FAILED", error instanceof Error ? error.message : "Revoke verification failed.");
        if (submittedSignature) actionResult.append(field("Transaction signature", submittedSignature));
      }
    };
  } catch (error) {
    if (!signal.aborted) setAction("FAILED", error instanceof Error ? error.message : "Simulation failed.");
  }
}
review.addEventListener("cancel", invalidateReview);

form.onsubmit = (event) => {
  event.preventDefault();
  setMode("scan");
};
select.onchange = selectScenario;
document.querySelector<HTMLButtonElement>("#scan-tab")!.onclick = () => setMode("scan");
document.querySelector<HTMLButtonElement>("#diff-tab")!.onclick = () => setMode("diff");
try {
  const [scenarioData, controlData] = await Promise.all([get("scenarios"), get("control")]);
  if (controlData !== null) {
    const config = object(controlData);
    if (config.network !== "devnet" && config.network !== "localnet")
      throw new Error("Unsupported control network.");
    const rpcUrl = new URL(text(config.rpcUrl));
    if (!["http:", "https:"].includes(rpcUrl.protocol)) throw new Error("Invalid public RPC URL.");
    control = { scope: text(config.scope), rpcUrl: rpcUrl.href, network: config.network };
  }
  const manifest = array(scenarioData);
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
  refreshWallets();
  selectScenario();
} catch (error) {
  status(error instanceof Error ? error.message : "Observations are unavailable.", true);
}
