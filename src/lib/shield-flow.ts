import type { AssetAmount } from "@kohaku-eth/plugins";
import { formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { Mnemonic } from "derive-railgun-keys";

import { makePublicClient, disposePublicClient, type KohakuPublicClient } from "../utils/rpc";
import { withTor } from "../utils/tor";
import { rpcForWalletOps, withProtocolRuntime } from "./protocol-runtime.js";
import { ERC20_ABI } from "../utils/tokens-util";
import type { ResolvedTokenMeta } from "../utils/tokens-util";
import {
  assertTornadoEthOnly,
  assertTornadoShieldAmount,
  ETH_AS_ERC20,
  prepareProtocolShield,
  type SupportedProtocol,
} from "../utils/plugins";
import type { BalancesSnapshot } from "./balances-snapshot.js";
import { makePublicAccountsStorage } from "../utils/public-accounts";
import {
  addressFromPrivateKey,
  encodeContractCall,
  makeWalletClient,
  simulateCallOrThrow,
  sendTransactionAndWait,
} from "../utils/viem-tx.js";

export type PublicAccountWithBalance = {
  index: number;
  address: string;
  priv: string;
  balance: bigint;
  ethBalance: bigint;
};

function formatEthDisplay(balanceWei: bigint): string {
  const full = formatUnits(balanceWei, 18);
  const [whole, fracRaw = ""] = full.split(".");
  if (!fracRaw) return whole;

  const firstNonZero = fracRaw.search(/[1-9]/);
  if (firstNonZero === -1) return `${whole}.0`;

  const keepDigits = Math.max(6, firstNonZero + 1);
  const clipped = fracRaw.slice(0, keepDigits).replace(/0+$/, "");
  return clipped ? `${whole}.${clipped}` : whole;
}

export function formatPublicAccountBalanceLabel(
  acct: PublicAccountWithBalance,
  tokenMeta: ResolvedTokenMeta
): string {
  const tokenBal = tokenMeta.isEth
    ? formatEthDisplay(acct.balance)
    : formatUnits(acct.balance, tokenMeta.decimals);
  if (tokenMeta.isEth) {
    return `${tokenBal} ${tokenMeta.symbol}`;
  }
  const ethBal = formatEthDisplay(acct.ethBalance);
  return `${tokenBal} ${tokenMeta.symbol} (${ethBal} ETH)`;
}

export type ShieldTxPayload = {
  data: string;
  to: string;
  from: string;
  value: string;
};

export type ShieldPlan = {
  senderAddress: string;
  approve: { to: string; data: string; value: bigint } | null;
  shieldTx: { to: string; data: string; value: bigint };
  shieldTxs: Array<{ to: string; data: string; value: bigint }>;
  transactions: ShieldTxPayload[];
};

export function parseFromIndex(fromValue: string): number | null {
  if (!/^\d+$/.test(fromValue)) return null;
  const parsed = Number(fromValue);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/** Build shield account rows from the balances snapshot (no RPC). */
export function publicAccountsWithBalanceFromSnapshot(
  snap: BalancesSnapshot,
  walletDir: string,
  mnemonic: string,
  password: string,
  tokenMeta: ResolvedTokenMeta
): PublicAccountWithBalance[] {
  const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
  const tokenKey = tokenMeta.tokenAddress.toLowerCase();

  return publicStorage.getAccounts().map((acct) => {
    const rows = snap.publicByAddress[acct.address];
    const ethRow = rows?.find((r) => r.symbol === "ETH");
    const tokenRow = tokenMeta.isEth
      ? ethRow
      : rows?.find((r) => r.token_address.toLowerCase() === tokenKey);

    const ethBalance = ethRow ? BigInt(ethRow.raw_token_holdings) : 0n;
    const balance = tokenMeta.isEth
      ? ethBalance
      : tokenRow
        ? BigInt(tokenRow.raw_token_holdings)
        : 0n;

    return {
      index: acct.index,
      address: acct.address,
      priv: acct.priv,
      balance,
      ethBalance,
    };
  });
}

export async function listPublicAccountsWithBalance(
  rpcUrl: string,
  walletDir: string,
  mnemonic: string,
  password: string,
  tokenMeta: ResolvedTokenMeta
): Promise<PublicAccountWithBalance[]> {
  const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
  const allPublicAccounts = publicStorage.getAccounts();
  const client = await makePublicClient(rpcUrl);
  try {
    const withBalances: PublicAccountWithBalance[] = [];
    for (const acct of allPublicAccounts) {
      const ethBalance = await client.getBalance({
        address: acct.address as `0x${string}`,
      });
      const bal = tokenMeta.isEth
        ? ethBalance
        : await client.readContract({
            address: tokenMeta.tokenAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [acct.address as `0x${string}`],
          });
      withBalances.push({
        index: acct.index,
        address: acct.address,
        priv: acct.priv,
        balance: bal,
        ethBalance,
      });
    }
    return withBalances;
  } finally {
    disposePublicClient(client);
  }
}

function encodeErc20ApproveTx(
  tokenAddress: string,
  spender: string,
  amount: bigint
): { to: string; data: string; value: bigint } {
  const data = encodeContractCall(ERC20_ABI, "approve", [spender, amount]);
  return { to: tokenAddress, data, value: 0n };
}

function toShieldTxs(
  op: unknown,
  opts?: { allowMultiple?: boolean }
): Array<{ to: string; data: string; value: bigint }> {
  let txs: Array<{ to: string; data: string; value: bigint }> | null = null;

  if (Array.isArray(op)) {
    txs = op as Array<{ to: string; data: string; value: bigint }>;
  } else if (
    typeof op === "object" &&
    op !== null &&
    "txns" in op &&
    Array.isArray((op as { txns?: unknown[] }).txns)
  ) {
    txs = (op as { txns: Array<{ to: string; data: string; value: bigint }> }).txns;
  }

  if (!txs) {
    throw new Error("Unsupported shield operation shape returned by plugin.");
  }

  if (txs.length === 0) {
    throw new Error("prepareShield() returned no transactions.");
  }

  if (!opts?.allowMultiple && txs.length !== 1) {
    throw new Error(
      `Expected prepareShield() to return exactly 1 tx, got ${txs.length}.`
    );
  }
  return txs;
}

export async function simulateTransactionOrThrow(
  client: KohakuPublicClient,
  tx: { to: string; from: string; data: string; value: bigint; gasLimit?: bigint },
  stepLabel: string
): Promise<void> {
  await simulateCallOrThrow(
    client,
    {
      to: tx.to,
      from: tx.from,
      data: tx.data,
      value: tx.value,
      gas: tx.gasLimit,
    },
    stepLabel
  );
}

export function resolveShieldSender(opts: {
  fromValue: string;
  walletDir: string;
  mnemonic: string;
  password: string;
  dryRun: boolean;
  allowDeriveFromMnemonic: boolean;
}): { senderAddress: string; senderPrivateKey: string | undefined } {
  const publicStorage = makePublicAccountsStorage(
    opts.walletDir,
    opts.mnemonic,
    opts.password
  );
  const fromIndex = parseFromIndex(opts.fromValue);
  if (fromIndex !== null) {
    const account = publicStorage.getAccount(fromIndex);
    if (account) {
      return { senderAddress: account.address, senderPrivateKey: account.priv };
    }
    if (opts.allowDeriveFromMnemonic || opts.dryRun) {
      const priv = Mnemonic.to0xPrivateKeyByIndex(opts.mnemonic, fromIndex);
      return { senderAddress: addressFromPrivateKey(priv), senderPrivateKey: priv };
    }
    throw new Error(
      `Public account index ${fromIndex} not found. Derive from mnemonic is not enabled.`
    );
  }
  if (isAddress(opts.fromValue)) {
    const senderAddress = getAddress(opts.fromValue);
    const match = publicStorage
      .getAccounts()
      .find((x) => x.address.toLowerCase() === senderAddress.toLowerCase());
    if (match) {
      return { senderAddress, senderPrivateKey: match.priv };
    }
    if (opts.dryRun) {
      return { senderAddress, senderPrivateKey: undefined };
    }
    throw new Error(
      `Address ${senderAddress} is not in this wallet's public accounts.`
    );
  }
  throw new Error("--from must be either a valid address or a non-negative index.");
}

export async function prepareShieldPlan(opts: {
  protocol: SupportedProtocol;
  rpcUrl: string;
  walletDir: string;
  password: string;
  mnemonic: string;
  chainId: bigint;
  tokenMeta: ResolvedTokenMeta;
  amount: bigint;
  fromValue: string;
  allowDeriveFromMnemonic?: boolean;
  withoutTor?: boolean;
}): Promise<ShieldPlan> {
  const {
    protocol,
    rpcUrl,
    walletDir,
    password,
    mnemonic,
    chainId,
    tokenMeta,
    amount,
    fromValue,
    allowDeriveFromMnemonic = false,
    withoutTor,
  } = opts;

  const { senderAddress, senderPrivateKey: _pk } = resolveShieldSender({
    fromValue,
    walletDir,
    mnemonic,
    password,
    dryRun: true,
    allowDeriveFromMnemonic,
  });

  if (protocol === "tornado") {
    assertTornadoEthOnly(tokenMeta.isEth);
    assertTornadoShieldAmount(chainId, amount);
  }

  return withTor(!withoutTor, { rpcUrl, walletDir }, () =>
    withProtocolRuntime(
      { protocol, rpcUrl, walletDir, password, mnemonic, chainId },
      async (_host, plugin) => {
      const { rpc, dispose } = await rpcForWalletOps({
        protocol,
        rpcUrl,
        walletDir,
        password,
        mnemonic,
        chainId,
      });
      try {
        const asset =
          tokenMeta.isEth && protocol === "railgun"
            ? { asset: { __type: "native" as const }, amount }
            : {
                asset: {
                  __type: "erc20" as const,
                  contract: (tokenMeta.isEth
                    ? ETH_AS_ERC20
                    : tokenMeta.tokenAddress) as `0x${string}`,
                },
                amount,
              };

        const op = await prepareProtocolShield(plugin, protocol, asset as AssetAmount);
        const shieldTxs = toShieldTxs(op, {
          allowMultiple: protocol === "tornado",
        });
        const shieldTx = shieldTxs[0]!;

        let approve: { to: string; data: string; value: bigint } | null = null;
        if (!tokenMeta.isEth) {
          const allowance = await rpc.readContract({
            address: tokenMeta.tokenAddress as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [senderAddress as `0x${string}`, shieldTx.to as `0x${string}`],
          });
          if (allowance < amount) {
            approve = encodeErc20ApproveTx(tokenMeta.tokenAddress, shieldTx.to, amount);
          }
        }

        const transactions: ShieldTxPayload[] = [];
        if (approve) {
          transactions.push({
            data: approve.data,
            to: approve.to,
            from: senderAddress,
            value: approve.value.toString(),
          });
        }
        for (const tx of shieldTxs) {
          transactions.push({
            data: tx.data,
            to: tx.to,
            from: senderAddress,
            value: tx.value.toString(),
          });
        }

        return { senderAddress, approve, shieldTx, shieldTxs, transactions };
      } finally {
        dispose();
      }
    }
    )
  );
}

export type BroadcastShieldResult = {
  type: "approval" | "shield";
  hash: string;
}[];

export async function broadcastShield(opts: {
  protocol: SupportedProtocol;
  rpcUrl: string;
  walletDir: string;
  password: string;
  mnemonic: string;
  chainId: bigint;
  tokenMeta: ResolvedTokenMeta;
  amount: bigint;
  fromValue: string;
  allowDeriveFromMnemonic?: boolean;
  withoutTor?: boolean;
}): Promise<BroadcastShieldResult> {
  const plan = await prepareShieldPlan({
    ...opts,
    allowDeriveFromMnemonic: opts.allowDeriveFromMnemonic ?? true,
  });
  const { senderAddress, approve, shieldTx, shieldTxs } = plan;

  const sender = resolveShieldSender({
    fromValue: opts.fromValue,
    walletDir: opts.walletDir,
    mnemonic: opts.mnemonic,
    password: opts.password,
    dryRun: false,
    allowDeriveFromMnemonic: opts.allowDeriveFromMnemonic ?? true,
  });
  if (!sender.senderPrivateKey) {
    throw new Error(
      "Cannot sign: no private key for this sender (use a saved public account)."
    );
  }

  const ctx = {
    protocol: opts.protocol,
    rpcUrl: opts.rpcUrl,
    walletDir: opts.walletDir,
    password: opts.password,
    mnemonic: opts.mnemonic,
    chainId: opts.chainId,
  };
  const { rpc, dispose } = await rpcForWalletOps(ctx);
  const results: BroadcastShieldResult = [];
  try {
    const walletClient = makeWalletClient(sender.senderPrivateKey, rpc, opts.rpcUrl);

    if (approve && !opts.tokenMeta.isEth) {
      await simulateTransactionOrThrow(
        rpc,
        {
          to: opts.tokenMeta.tokenAddress,
          from: senderAddress,
          data: approve.data,
          value: 0n,
        },
        "Approval transaction"
      );
      const approvalHash = await walletClient.writeContract({
        account: walletClient.account!,
        chain: walletClient.chain,
        address: opts.tokenMeta.tokenAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [shieldTx.to as `0x${string}`, opts.amount],
      });
      await rpc.waitForTransactionReceipt({ hash: approvalHash });
      results.push({ type: "approval", hash: approvalHash });
    }

    for (let i = 0; i < shieldTxs.length; i++) {
      const tx = shieldTxs[i]!;
      await simulateTransactionOrThrow(
        rpc,
        {
          to: tx.to,
          from: senderAddress,
          data: tx.data,
          value: tx.value,
          gasLimit: 2000000n,
        },
        shieldTxs.length > 1
          ? `Shield transaction (${i + 1}/${shieldTxs.length})`
          : "Shield transaction"
      );
      const hash = await sendTransactionAndWait(walletClient, rpc, {
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gas: 2000000n,
      });
      results.push({ type: "shield", hash });
    }
    return results;
  } finally {
    dispose();
  }
}

export function formatAmountPreview(amount: bigint, tokenMeta: ResolvedTokenMeta): string {
  return `${formatUnits(amount, tokenMeta.decimals)} ${tokenMeta.symbol}`;
}

export function summarizeMultiShieldPlan(
  shieldTxs: Array<{ value: bigint }>,
  tokenMeta: ResolvedTokenMeta
): string {
  const counts = new Map<string, { count: number; value: bigint }>();
  for (const tx of shieldTxs) {
    const key = tx.value.toString();
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { count: 1, value: tx.value });
    }
  }
  return [...counts.values()]
    .sort((a, b) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0))
    .map(({ count, value }) => {
      const amount = formatAmountPreview(value, tokenMeta);
      return count === 1 ? `1 × ${amount}` : `${count} × ${amount}`;
    })
    .join(" + ");
}

export function shieldTransactionConfirmMessage(opts: {
  step: string;
  txValue: bigint;
  shieldTxs: Array<{ value: bigint }>;
  tokenMeta: ResolvedTokenMeta;
  senderAddress: string;
}): string {
  const txAmount = formatAmountPreview(opts.txValue, opts.tokenMeta);
  const base = `Send shield transaction (${opts.step}): shield ${txAmount}`;
  if (opts.shieldTxs.length > 1) {
    const plan = summarizeMultiShieldPlan(opts.shieldTxs, opts.tokenMeta);
    return `${base} (${plan}) (from ${opts.senderAddress})?`;
  }
  return `${base} (from ${opts.senderAddress})?`;
}
