import { getWallets } from "@wallet-standard/app";
import type { StandardConnectFeature, StandardEventsFeature } from "@wallet-standard/features";
import type { SolanaSignTransactionFeature } from "@solana/wallet-standard-features";

type RegisteredWallet = ReturnType<ReturnType<typeof getWallets>["get"]>[number];
export type SigningWallet = RegisteredWallet & {
  features: StandardConnectFeature & StandardEventsFeature & SolanaSignTransactionFeature;
};
export const wallets = getWallets();
export function signingWallets(): SigningWallet[] {
  return wallets.get().filter((wallet): wallet is SigningWallet => {
    const features = wallet.features as Partial<SigningWallet["features"]>;
    return (
      typeof features["standard:connect"]?.connect === "function" &&
      typeof features["standard:events"]?.on === "function" &&
      typeof features["solana:signTransaction"]?.signTransaction === "function" &&
      features["solana:signTransaction"].supportedTransactionVersions.includes("legacy")
    );
  });
}
