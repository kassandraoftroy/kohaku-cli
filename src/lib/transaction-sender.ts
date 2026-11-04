import { password as promptPassword } from "@inquirer/prompts";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { resolveShieldSender, type PublicAccountWithBalance } from "./shield-flow.js";
import { disposePublicClient, makePublicClient } from "../utils/rpc.js";
import { ERC20_ABI, type ResolvedTokenMeta } from "../utils/tokens-util.js";

type SenderOptions = {
  fromValue: string;
  walletDir: string;
  mnemonic: string;
  password: string;
  dryRun: boolean;
  senderPriv?: string;
  nonInteractive?: boolean;
};

export function validateSenderPrivateKey(value: string, address: string): Hex {
  const key = (value.startsWith("0x") ? value : `0x${value}`) as Hex;
  let derived: string;
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error();
    derived = privateKeyToAccount(key).address;
  } catch {
    throw new Error("Invalid sender private key. Expected a valid 32-byte secp256k1 key.");
  }
  if (derived.toLowerCase() !== address.toLowerCase()) {
    throw new Error("Sender private key does not match the selected --from address.");
  }
  return key;
}

/** Unsaved HD indices are derived from the seed; external keys stay in memory. */
export async function resolveTransactionSender(opts: SenderOptions): Promise<{
  senderAddress: string; senderPrivateKey: string | undefined;
}> {
  const sender = resolveShieldSender({ ...opts, dryRun: true, allowDeriveFromMnemonic: true });
  if (opts.senderPriv !== undefined) {
    sender.senderPrivateKey = validateSenderPrivateKey(opts.senderPriv, sender.senderAddress);
  }
  if (!sender.senderPrivateKey && !opts.dryRun) {
    if (opts.nonInteractive) {
      throw new Error("No stored key for --from. Provide --sender-priv <key> to sign in non-interactive mode.");
    }
    const value = await promptPassword({
      message: `Sender private key for ${sender.senderAddress}:`,
      mask: "*",
      validate: (value) => {
        try { validateSenderPrivateKey(value, sender.senderAddress); return true; }
        catch (error) { return (error as Error).message; }
      },
    });
    sender.senderPrivateKey = validateSenderPrivateKey(value, sender.senderAddress);
  }
  return sender;
}

/** Include explicitly selected external/unsaved senders without saving their key. */
export async function includeSelectedSenderBalance(
  accounts: PublicAccountWithBalance[], opts: Omit<SenderOptions, "dryRun">,
  rpcUrl: string, tokenMeta: ResolvedTokenMeta,
): Promise<string> {
  const sender = await resolveTransactionSender({ ...opts, dryRun: true });
  const address = getAddress(sender.senderAddress);
  if (accounts.some((account) => account.address.toLowerCase() === address.toLowerCase())) return address;
  const client = await makePublicClient(rpcUrl);
  try {
    const ethBalance = await client.getBalance({ address });
    const balance = tokenMeta.isEth ? ethBalance : await client.readContract({
      address: tokenMeta.tokenAddress as Hex, abi: ERC20_ABI, functionName: "balanceOf", args: [address],
    });
    accounts.push({ address, index: -1, priv: "", balance, ethBalance });
    return address;
  } finally { disposePublicClient(client); }
}
