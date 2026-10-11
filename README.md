# Catalyst demo

Scan an address, inspect its native authorization and compare two observed states.
This is the Velon showcase. ARM, Cataloger and Catalyst keep their own repositories.

The demo runs the pinned Cataloger CLI, imports accounts captured by executed native
tests and serves its real journal API. The browser interprets ARM 0.1 responses.
No balances, permissions or transaction outcomes are fabricated for the interface.

![Scan showing native fixture authority, exact amounts and partial coverage](docs/scan.png)

## Run

Requirements: Bun 1.3.14 or newer, Node 22, npm, Git and stable Rust.

```sh
git clone https://github.com/dakewamama/cataloger.git ../cataloger
git -C ../cataloger checkout b5c3c4adfe607acaf40d611a34e7265c34f93898
npm ci --ignore-scripts
bun run demo
```

Open `http://127.0.0.1:3000`. For an existing checkout, set
`CATALOGER_DIR=/absolute/path/to/cataloger`. Its tracked files must match the pinned
revision. The first run builds `authorization-api`; later builds reuse Cargo's cache.
The local fixture journal lives in ignored `.data/observations-{cataloger_revision}.db`.
Each runtime pin gets its own journal so older projection evidence remains intact.
No RPC credential is required for fixture replay.
`PORT` and `RUNTIME_PORT` select the browser and observation API ports respectively.
Both bind to localhost by default. `HOST` changes only the browser server's bind address.

For bundled assets:

```sh
npm run build
bun run start
```

## What the evidence proves

Subscriptions fixtures retain two observations of the same target at slots 108
and 122. The earlier observation contains merchant/puller authority with a shared
recurring allowance. The later observation follows cancellation and delegation
revocation. That derived spend grant disappears while technical and administrative
authority remain independently observable. Select Merchant, then View earlier slot
108, to inspect the shared allowance and its parent grant.

Observed Diff compares these two whole ARM projections. It omits changing evidence
references from semantic equality while retaining the complete original records.
The interval includes several native transitions. It is not a predicted transaction
diff or proof that all changes were caused by one instruction. Different scopes,
unordered slots, failed projections and duplicate grant identities are rejected.

The SPL fixture demonstrates the same Scan and Detail views through another adapter.
Native amounts stay in integer base units. The demo does not infer a mint symbol or
decimal scale. Integers are parsed losslessly, including values above JavaScript's
safe integer range. Compound principals retain one shared grant and allowance.

Every view identifies its state version, observed slot, partial coverage, deployment,
adapter and evidence. Current means latest observed state in this fixture scope.
It does not claim complete address discovery or live freshness. Unknown, incomplete
and invalid projections suppress permissions. Derived availability remains unknown
where the generic ARM evaluator cannot prove dependencies.

## Verification

```sh
npm run format:check
npm run typecheck
npm test
npm run build
node_modules/.bin/playwright install chromium --only-shell
npm run test:e2e
```

Browser tests run against the real imported journal on desktop, tablet and mobile.
They cover shared allowances, native u64 amounts, retained administrative authority,
removed derived authority, evidence inspection, partial coverage, invalid input,
empty results, provider failure and conflicting/unsupported observations. Screenshots
and traces remain under ignored `test-results/`.

## Revoke API bridge

The browser server forwards these existing Cataloger routes:

- `POST /api/snapshots/{id}/actions/revoke/{token_account}` requests simulation.
- `POST /api/snapshots/{id}/actions/revoke/{token_account}/verify` forwards the
  signed transaction for finalized verification and native reobservation.
- `GET /api/verifications/revoke/{verification_id}` retrieves retained evidence.

POST requests require `X-Velon-Action: revoke`. Simulation accepts no body;
verification requires `application/json` containing `signed_transaction`, as defined
by Cataloger. Request bodies are limited to 4096 bytes. The server preserves raw
response bytes and status codes, rejects query strings and redirects, and never sends
transactions or forwards browser credentials. The action header prevents cross-origin
browser requests without preflight; it is not client authentication.

Set `RPC_URL` for Cataloger's action endpoints. They remain unavailable without it.
The imported fixtures alone do not establish live authority. Cataloger still requires
verified deployment/runtime evidence and current state before returning signing bytes.
A 404 during finalization remains pending or absent, not a successful revocation.
The browser connects through Wallet Standard and requires `solana:signTransaction`.
It passes the reviewed bytes through Catalyst's pinned signing/submission helper.
Changed messages, invalid signatures, expired blockhashes and changed checkpoints
stop submission. A send response alone never produces a success screen: verification
must succeed, the current scope must agree, and the grant must be absent after reload.

## Wallet control

Fixture scenarios remain read-only. To expose an existing finalized SPL observation,
configure the same journal and providers used to collect it:

```sh
DATABASE_URL=sqlite:///absolute/path/observations.db \
LIVE_SNAPSHOT_ID=<retained-snapshot-id> \
LIVE_NETWORK=devnet \
RPC_URL=<server-rpc-url> \
PUBLIC_RPC_URL=<browser-safe-rpc-url> \
CATALOGER_DIR=/absolute/path/to/cataloger bun run demo
```

`PUBLIC_RPC_URL` is deliberately exposed to the browser. Use a public endpoint or
one explicitly intended for browser use; do not put a private provider credential
there. Cataloger and browser RPCs must serve the same genesis. Devnet is checked
against its exact genesis identity. `LIVE_NETWORK=localnet` labels every action as
local-validator execution and never claims public-chain finality.

Connect the token-account owner's signing wallet, select the live permission and
choose Revoke. Review the principal, account, allowance and network, then confirm
in the wallet. Finalization polls the existing verification endpoint without
resending. Keep the displayed signature if finalization fails or remains uncertain.
Account changes invalidate the session. A successful screen includes the finalized
transaction slot and retained verification ID.

A compatible finalized deployment/runtime witness is still required. Current public
captures do not supply one, so they remain incomplete and cannot open a signing
review. Simulation requires the same finalized bank as the retained observation;
stale captures need fresh collection and review. This change does not bypass that
requirement or add a continuous collector.

The browser tests register an ephemeral test wallet, sign real legacy revoke bytes
with Ed25519 and run the actual Catalyst helper. RPC finality and reobservation
responses in those tests are synthetic. They prove browser conformance, not an
executed devnet journey or compatibility testing with a particular wallet extension.

## Scope

The default browser mode replays native fixtures. An explicitly configured finalized
SPL scope enables wallet control through existing runtime and SDK APIs. Live public
execution, continuous collection/repair, general transaction Diff, Squads, Swig and
exact intent compilation remain separate milestones. No claim
is made that this repository already implements the full cross-protocol closed loop
or that no other public or private implementation exists.

Sources and reuse decisions are recorded in [SOURCE_LEDGER.md](docs/research/SOURCE_LEDGER.md).
