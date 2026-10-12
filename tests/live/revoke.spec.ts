import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { getAddressDecoder } from "@solana/addresses";

const keypair = process.env.LIVE_OWNER_KEYPAIR;
const rpcUrl = process.env.RPC_URL;

test("owner revokes a finalized SPL delegate and the chain agrees", async ({ page, request }) => {
  test.skip(!keypair || !rpcUrl, "Requires LIVE_OWNER_KEYPAIR and RPC_URL from scripts/local.ts.");
  const secret: number[] = JSON.parse(readFileSync(keypair!, "utf8"));
  const owner = getAddressDecoder().decode(Uint8Array.from(secret.slice(32)));
  await page.addInitScript(
    ({ owner, secret }) => {
      const account = {
        address: owner,
        publicKey: new Uint8Array(secret.slice(32)),
        chains: ["solana:localnet"],
        features: ["solana:signTransaction"],
      };
      const pkcs8 = [48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32, ...secret.slice(0, 32)];
      const wallet = {
        version: "1.0.0",
        name: "Local owner key",
        icon: "data:image/svg+xml,<svg/>",
        chains: ["solana:localnet"],
        accounts: [account],
        features: {
          "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy"],
            signTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
              const bytes = new Uint8Array(transaction);
              const key = await crypto.subtle.importKey(
                "pkcs8",
                new Uint8Array(pkcs8),
                { name: "Ed25519" },
                false,
                ["sign"],
              );
              bytes.set(new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes.slice(65))), 1);
              return [{ signedTransaction: bytes }];
            },
          },
        },
      };
      window.addEventListener("wallet-standard:app-ready", (event) => {
        (event as CustomEvent<{ register: (wallet: unknown) => void }>).detail.register(wallet);
      });
    },
    { owner, secret },
  );
  const rpc = async (method: string, params: unknown[]) =>
    (await (await request.post(rpcUrl!, { data: { jsonrpc: "2.0", id: 1, method, params } })).json()).result;

  await page.goto("/");
  await page.getByRole("button", { name: "Connect wallet", exact: true }).click();
  const source = await page.locator("#address").inputValue();
  const before = await rpc("getAccountInfo", [source, { encoding: "jsonParsed", commitment: "finalized" }]);
  const delegate: string = before.value.data.parsed.info.delegate;
  expect(delegate).toBeTruthy();
  await expect(page.locator("#results article")).toContainText(delegate);
  await page.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(delegate);
  await expect(page.getByRole("dialog")).toContainText(source);
  await page.screenshot({ path: "test-results/live-review.png", fullPage: true });
  await page.getByRole("button", { name: "Confirm in wallet" }).click();
  await expect(page.getByRole("heading", { name: "Revoked", exact: true })).toBeVisible({ timeout: 150000 });
  await expect(page.locator("#results article")).toHaveCount(0);
  await page.screenshot({ path: "test-results/live-verified.png", fullPage: true });

  const receipt = await page.locator("#action-result dd").allTextContents();
  const [signature, slot, verification] = receipt as [string, string, string];
  const executed = await rpc("getTransaction", [signature, { commitment: "finalized", encoding: "json" }]);
  expect(executed.meta.err).toBeNull();
  expect(String(executed.slot)).toBe(slot);
  const after = await rpc("getAccountInfo", [source, { encoding: "jsonParsed", commitment: "finalized" }]);
  expect(after.value.data.parsed.info.delegate).toBeUndefined();
  expect((await request.get(`/api/verifications/revoke/${verification}`)).status()).toBe(200);
});
