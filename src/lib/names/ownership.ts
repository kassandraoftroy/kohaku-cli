import { getAddress, isAddress, type Address, type Hex } from "viem";
import { Mnemonic } from "derive-railgun-keys";

import { parseFromIndex } from "../shield-flow.js";
import { makePublicAccountsStorage } from "../../utils/public-accounts.js";
import { addressFromPrivateKey } from "../../utils/viem-tx.js";
import type { NameOwnership } from "./types.js";

export type ResolvedSigner = {
  address: Address;
  privateKey: string | undefined;
  index: number | null;
};

/**
 * Resolve which wallet key should sign for a name that is already owned.
 *
 * Preference order:
 * 1. Public-account matching `requiredAddress` (owner or manager)
 * 2. `--index` (+ `--owner-priv` when the index is not yet persisted) whose
 *    derived address equals `requiredAddress`
 */
export function resolveNameSigner(opts: {
  requiredAddress: Address;
  walletDir: string;
  mnemonic: string;
  password: string;
  indexFlag?: string;
  ownerPriv: boolean;
  dryRun: boolean;
}): ResolvedSigner {
  const required = getAddress(opts.requiredAddress);
  const storage = makePublicAccountsStorage(
    opts.walletDir,
    opts.mnemonic,
    opts.password
  );
  const accounts = storage.getAccounts();
  const byAddr = accounts.find(
    (a) => a.address.toLowerCase() === required.toLowerCase()
  );
  if (byAddr) {
    return {
      address: getAddress(byAddr.address),
      privateKey: byAddr.priv,
      index: byAddr.index,
    };
  }

  if (opts.indexFlag !== undefined && opts.indexFlag !== "") {
    const idx = parseFromIndex(opts.indexFlag);
    if (idx === null) {
      throw new Error("--index must be a non-negative integer.");
    }
    const persisted = storage.getAccount(idx);
    if (persisted) {
      const addr = getAddress(persisted.address);
      if (addr.toLowerCase() !== required.toLowerCase()) {
        throw new Error(
          `--index ${idx} is ${addr} but name requires ${required}.`
        );
      }
      return { address: addr, privateKey: persisted.priv, index: idx };
    }
    if (opts.ownerPriv || opts.dryRun) {
      const priv = Mnemonic.to0xPrivateKeyByIndex(opts.mnemonic, idx);
      const addr = addressFromPrivateKey(priv);
      if (addr.toLowerCase() !== required.toLowerCase()) {
        throw new Error(
          `--index ${idx} derives ${addr} but name requires ${required}.`
        );
      }
      return {
        address: addr,
        privateKey: opts.dryRun && !opts.ownerPriv ? undefined : priv,
        index: idx,
      };
    }
    throw new Error(
      `Public account index ${idx} not found. Pass --owner-priv to derive it from the seed.`
    );
  }

  throw new Error(
    `Name is controlled by ${required}, which is not in this wallet's public accounts. ` +
      `Pass --index <n> for the matching HD account` +
      (opts.ownerPriv ? "." : " (and --owner-priv if it is not persisted yet).")
  );
}

/**
 * Resolve the registrant/signer for `register-name` (defaults to index 0).
 */
export function resolveRegisterSigner(opts: {
  walletDir: string;
  mnemonic: string;
  password: string;
  indexFlag?: string;
  ownerPriv: boolean;
  dryRun: boolean;
}): ResolvedSigner {
  const raw = opts.indexFlag ?? "0";
  const idx = parseFromIndex(raw);
  if (idx === null) {
    throw new Error("--index must be a non-negative integer.");
  }
  const storage = makePublicAccountsStorage(
    opts.walletDir,
    opts.mnemonic,
    opts.password
  );
  const persisted = storage.getAccount(idx);
  if (persisted) {
    return {
      address: getAddress(persisted.address),
      privateKey: persisted.priv,
      index: idx,
    };
  }
  if (opts.ownerPriv || opts.dryRun) {
    const priv = Mnemonic.to0xPrivateKeyByIndex(opts.mnemonic, idx);
    return {
      address: addressFromPrivateKey(priv),
      privateKey: opts.dryRun && !opts.ownerPriv ? undefined : priv,
      index: idx,
    };
  }
  throw new Error(
    `Public account index ${idx} not found. Create it with next-fresh-address, or pass --owner-priv.`
  );
}

/**
 * Anyone may pay a renewal. Prefer the name owner when present in the wallet;
 * otherwise require `--index` for the paying account.
 */
export function resolveRenewPayer(opts: {
  ownerAddress: Address;
  walletDir: string;
  mnemonic: string;
  password: string;
  indexFlag?: string;
  ownerPriv: boolean;
  dryRun: boolean;
}): ResolvedSigner {
  try {
    return resolveNameSigner({
      requiredAddress: opts.ownerAddress,
      walletDir: opts.walletDir,
      mnemonic: opts.mnemonic,
      password: opts.password,
      indexFlag: opts.indexFlag,
      ownerPriv: opts.ownerPriv,
      dryRun: opts.dryRun,
    });
  } catch (ownerErr) {
    if (opts.indexFlag === undefined || opts.indexFlag === "") {
      throw ownerErr;
    }
    // Fall back: pay from an explicit index (renew is not owner-gated on-chain).
    return resolveRegisterSigner({
      walletDir: opts.walletDir,
      mnemonic: opts.mnemonic,
      password: opts.password,
      indexFlag: opts.indexFlag,
      ownerPriv: opts.ownerPriv,
      dryRun: opts.dryRun,
    });
  }
}

/** Pick which on-chain role address must sign for a given transfer role. */
export function requiredAddressForTransfer(
  ownership: NameOwnership,
  role: "owner" | "manager" | "both"
): Address {
  if (role === "manager") return ownership.manager;
  return ownership.owner;
}

/** Record updates need the manager (ENS) / owner (GNS/WNS). */
export function requiredAddressForRecords(ownership: NameOwnership): Address {
  return ownership.manager;
}

export function parseTransferRole(raw: string | undefined): "owner" | "manager" | "both" {
  const v = (raw ?? "owner").trim().toLowerCase();
  if (v !== "owner" && v !== "manager" && v !== "both") {
    throw new Error("--role must be owner, manager, or both");
  }
  return v;
}

export function generateSecret(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function resolveToAddress(
  value: string,
  resolveName: (v: string) => Promise<Address>
): Promise<Address> {
  const trimmed = value.trim();
  if (isAddress(trimmed)) return getAddress(trimmed);
  return resolveName(trimmed);
}
