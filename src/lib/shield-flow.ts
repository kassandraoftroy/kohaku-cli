import type { AssetAmount } from "@kohaku-eth/plugins";
import { formatUnits, getAddress, isAddress, parseUnits, type Address } from "viem";
import { Mnemonic } from "derive-railgun-keys";

import { makePublicClient, disposePublicClient, type KohakuPublicClient } from "../utils/rpc";
import { withTor } from "../utils/tor";
import { runWithSyncProgress, syncPluginWithProgress } from "../utils/sync-progress.js";
import { rpcForWalletOps, withProtocolRuntime } from "./protocol-runtime.js";
import { ERC20_ABI } from "../utils/tokens-util";
import type { ResolvedTokenMeta } from "../utils/tokens-util";
import {
  ETH_AS_ERC20,
  prepareProtocolShield,
  type SupportedProtocol,
} from "../utils/plugins";
import { assertTornadoDepositAmount } from "../utils/tornado-pools.js";
import type { BalancesSnapshot } from "./balances-snapshot.js";
import { makePublicAccountsStorage } from "../utils/public-accounts";
import {
  makeStealthAccountsStorage,
  parseStealthIndex,
} from "./stealth/storage.js";
import {
  addressFromPrivateKey,
  encodeContractCall,
  makeWalletClient,
  simulateCallOrThrow,
  sendTransactionAndWait,
} from "../utils/viem-tx.js";

export type PublicAccountWithBalance = {
  /** HD public-account index, or `-1` when this row is a stealth account. */
  index: number;
  /** Present when `kind === "stealth"`. */
  stealthIndex?: number;
  kind?: "hd" | "stealth";
  address: string;
  priv: string;
  balance: bigint;
  ethBalance: bigint;
  /** Optional identity name attached to a stealth payment. */
  stealthName?: string;
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

export function formatAccountSelector(acct: PublicAccountWithBalance): string {
  if (acct.kind === "stealth" && acct.stealthIndex !== undefined) {
    return `s${acct.stealthIndex}`;
  }
  return String(acct.index);
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
  /** @deprecated use approvals */
  approve: { to: string; data: string; value: bigint } | null;
  approvals: Array<{ to: string; data: string; value: bigint }>;
  shieldTx: { to: string; data: string; value: bigint };
  shieldTxs: Array<{ to: string; data: string; value: bigint }>;
  /** Full ordered call list (approvals + shield txs). */
  calls: Array<{ to: string; data: string; value: bigint }>;
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
  const stealthStorage = makeStealthAccountsStorage(walletDir, password);
  const tokenKey = tokenMeta.tokenAddress.toLowerCase();

  const fromRows = (
    address: string,
    priv: string,
    index: number,
    extra: Partial<PublicAccountWithBalance>
  ): PublicAccountWithBalance => {
    const rows = snap.publicByAddress[address];
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
      index,
      address,
      priv,
      balance,
      ethBalance,
      ...extra,
    };
  };

  const hd = publicStorage.getAccounts().map((acct) =>
    fromRows(acct.address, acct.priv, acct.index, { kind: "hd" })
  );
  const stealth = stealthStorage.getAccounts().map((acct) =>
    fromRows(acct.address, acct.priv, -1, {
      kind: "stealth",
      stealthIndex: acct.stealthIndex,
      stealthName: acct.name,
    })
  );
  return [...hd, ...stealth];
}

export async function listPublicAccountsWithBalance(
  rpcUrl: string,
  walletDir: string,
  mnemonic: string,
  password: string,
  tokenMeta: ResolvedTokenMeta
): Promise<PublicAccountWithBalance[]> {
  const publicStorage = makePublicAccountsStorage(walletDir, mnemonic, password);
  const stealthStorage = makeStealthAccountsStorage(walletDir, password);
  const allPublicAccounts = publicStorage.getAccounts();
  const stealthAccounts = stealthStorage.getAccounts();
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
        kind: "hd",
        address: acct.address,
        priv: acct.priv,
        balance: bal,
        ethBalance,
      });
    }
    for (const acct of stealthAccounts) {
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
        index: -1,
        kind: "stealth",
        stealthIndex: acct.stealthIndex,
        stealthName: acct.name,
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

const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

export type ShieldCall = { to: string; data: string; value: bigint };

/** Decode ERC-20 `approve(address,uint256)` calldata, or null if not an approve. */
export function tryDecodeErc20Approve(data: string): {
  spender: Address;
  amount: bigint;
} | null {
  const hex = data.toLowerCase();
  if (!hex.startsWith(ERC20_APPROVE_SELECTOR) || hex.length < 2 + 8 + 64 + 64) {
    return null;
  }
  const spenderWord = hex.slice(10, 74);
  const amountWord = hex.slice(74, 138);
  const spender = getAddress(`0x${spenderWord.slice(24)}`);
  return { spender, amount: BigInt(`0x${amountWord}`) };
}

/** Parse prepareShield() into one or more deposit/shield calls (may include approves). */
export function toShieldTxs(op: unknown): ShieldCall[] {
  let txs: ShieldCall[] | null = null;

  if (Array.isArray(op)) {
    txs = op as ShieldCall[];
  } else if (
    typeof op === "object" &&
    op !== null &&
    "txns" in op &&
    Array.isArray((op as { txns?: unknown[] }).txns)
  ) {
    txs = (op as { txns: ShieldCall[] }).txns;
  }

  if (!txs) {
    throw new Error("Unsupported shield operation shape returned by plugin.");
  }

  if (txs.length === 0) {
    throw new Error("prepareShield() returned no transactions.");
  }
  return txs;
}

/**
 * Split prepareShield txs into deposit calls + any plugin-embedded ERC-20 approves.
 * Tornado ERC-20 embeds one `approve(pool, denomination)` per deposit; we strip
 * those and re-emit a single aggregated approve per pool.
 */
export function partitionShieldTxs(txs: ShieldCall[]): {
  deposits: ShieldCall[];
  /** Aggregated allowance needed per pool/spender (from plugin approve txs). */
  approvalNeededBySpender: Map<string, bigint>;
  /** Token contract from the first approve tx (when present). */
  approvalToken: string | undefined;
} {
  const deposits: ShieldCall[] = [];
  const approvalNeededBySpender = new Map<string, bigint>();
  let approvalToken: string | undefined;

  for (const tx of txs) {
    const decoded = tryDecodeErc20Approve(tx.data);
    if (decoded && tx.value === 0n) {
      approvalToken = getAddress(tx.to);
      const key = getAddress(decoded.spender);
      approvalNeededBySpender.set(
        key,
        (approvalNeededBySpender.get(key) ?? 0n) + decoded.amount
      );
      continue;
    }
    deposits.push(tx);
  }

  return { deposits, approvalNeededBySpender, approvalToken };
}

/**
 * Build ERC-20 approval calls the consumer must submit before deposits.
 * - Tornado: aggregates plugin per-deposit approves into one approve per pool
 *   (e.g. 2×1000 + 5×100 → approve 2000 to 1000-pool, 500 to 100-pool).
 * - Railgun / others: if prepareShield has no approves, approve `amount` to each
 *   unique deposit target (non-payable calls only).
 */
export async function resolveShieldApprovalCalls(opts: {
  client: KohakuPublicClient;
  tokenAddress: string;
  senderAddress: string;
  amount: bigint;
  /** Raw prepareShield txs (may include embedded approves). */
  shieldTxs: ShieldCall[];
}): Promise<{
  approvals: ShieldCall[];
  /** Deposit/shield calls only (approves stripped). */
  deposits: ShieldCall[];
}> {
  const { deposits, approvalNeededBySpender, approvalToken } = partitionShieldTxs(
    opts.shieldTxs
  );
  const token = approvalToken ?? getAddress(opts.tokenAddress);

  if (approvalNeededBySpender.size === 0) {
    // No plugin-embedded approves: approve full amount to each unique ERC-20
    // deposit target (Railgun / Privacy Pools style).
    for (const tx of deposits) {
      if (tx.value > 0n) continue;
      const key = getAddress(tx.to);
      if (!approvalNeededBySpender.has(key)) {
        approvalNeededBySpender.set(key, opts.amount);
      }
    }
  }

  const approvals: ShieldCall[] = [];
  for (const [spender, approveAmount] of approvalNeededBySpender) {
    if (approveAmount <= 0n) continue;
    const allowance = await opts.client.readContract({
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [
        opts.senderAddress as `0x${string}`,
        spender as `0x${string}`,
      ],
    });
    if (allowance < approveAmount) {
      approvals.push(encodeErc20ApproveTx(token, spender, approveAmount));
    }
  }

  return { approvals, deposits };
}

/** Approvals first, then shield/deposit calls — the UserOp / EOA call list. */
export function buildShieldCallList(
  approvals: ShieldCall[],
  deposits: ShieldCall[]
): ShieldCall[] {
  return [...approvals, ...deposits];
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
  const stealthStorage = makeStealthAccountsStorage(
    opts.walletDir,
    opts.password
  );

  const stealthIdx = parseStealthIndex(opts.fromValue);
  if (stealthIdx !== null) {
    const account = stealthStorage.getAccount(stealthIdx);
    if (!account) {
      throw new Error(
        `Stealth account s${stealthIdx} not found. Run balances (or init-profile) to scan announcements.`
      );
    }
    return { senderAddress: account.address, senderPrivateKey: account.priv };
  }

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
    const stealthMatch = stealthStorage.findByAddress(senderAddress);
    if (stealthMatch) {
      return {
        senderAddress: getAddress(stealthMatch.address),
        senderPrivateKey: stealthMatch.priv,
      };
    }
    if (opts.dryRun) {
      return { senderAddress, senderPrivateKey: undefined };
    }
    throw new Error(
      `Address ${senderAddress} is not in this wallet's public or stealth accounts.`
    );
  }
  throw new Error(
    "--from must be a non-negative HD index, a stealth selector (s0), or an address."
  );
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
  onSyncProgress?: (message: string) => void;
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
    onSyncProgress,
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
    assertTornadoDepositAmount(chainId, amount, {
      isEth: tokenMeta.isEth,
      tokenAddress: tokenMeta.tokenAddress,
      symbol: tokenMeta.symbol,
      decimals: tokenMeta.decimals,
    });
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

        const op =
          protocol === "railgun"
            ? await prepareProtocolShield(plugin, protocol, asset as AssetAmount)
            : await runWithSyncProgress(
                { protocol, onUpdate: onSyncProgress },
                async () => {
                  await syncPluginWithProgress(plugin, protocol);
                  return prepareProtocolShield(plugin, protocol, asset as AssetAmount);
                }
              );
        const rawTxs = toShieldTxs(op);

        let approvals: ShieldCall[] = [];
        let deposits: ShieldCall[];
        if (tokenMeta.isEth) {
          const parted = partitionShieldTxs(rawTxs);
          deposits = parted.deposits;
        } else {
          const resolved = await resolveShieldApprovalCalls({
            client: rpc,
            tokenAddress: tokenMeta.tokenAddress,
            senderAddress,
            amount,
            shieldTxs: rawTxs,
          });
          approvals = resolved.approvals;
          deposits = resolved.deposits;
        }
        const shieldTx = deposits[0]!;
        const shieldTxs = deposits;
        const calls = buildShieldCallList(approvals, deposits);

        const transactions: ShieldTxPayload[] = calls.map((tx) => ({
          data: tx.data,
          to: tx.to,
          from: senderAddress,
          value: tx.value.toString(),
        }));

        return {
          senderAddress,
          approve: approvals[0] ?? null,
          approvals,
          shieldTx,
          shieldTxs,
          calls,
          transactions,
        };
      } finally {
        dispose();
      }
    }
    )
  );
}

export type BroadcastShieldResult = {
  type: "approval" | "shield" | "eip7702-userop";
  hash: string;
  userOpHash?: string;
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
  const { senderAddress, calls } = plan;

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
  try {
    if (calls.length === 1) {
      const tx = calls[0]!;
      await simulateTransactionOrThrow(
        rpc,
        {
          to: tx.to,
          from: senderAddress,
          data: tx.data,
          value: tx.value,
        },
        "Shield transaction"
      );
    }
    // Multi-call UserOp: skip per-call eth_call (dependent payloads). Bundler
    // prepare inside sendEip7702BatchUserOperation validates the full batch.

    if (calls.length > 1) {
      const { sendEip7702BatchUserOperation } = await import(
        "../utils/eip7702-batch-userop.js"
      );
      const sent = await sendEip7702BatchUserOperation({
        client: rpc,
        privateKey: sender.senderPrivateKey,
        chainId: opts.chainId,
        calls,
      });
      return [
        {
          type: "eip7702-userop",
          hash: sent.txHash,
          userOpHash: sent.userOpHash,
        },
      ];
    }

    const tx = calls[0]!;
    const walletClient = makeWalletClient(
      sender.senderPrivateKey,
      rpc,
      opts.rpcUrl
    );
    const hash = await sendTransactionAndWait(walletClient, rpc, {
      to: tx.to,
      data: tx.data,
      value: tx.value,
      gas: 2_000_000n,
    });
    return [{ type: "shield", hash }];
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
