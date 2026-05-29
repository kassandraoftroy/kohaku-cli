import type { AssetAmount } from "@kohaku-eth/plugins";
import {
  Contract,
  Interface,
  Wallet,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
} from "ethers";
import { Mnemonic } from "derive-railgun-keys";

import { makeEthersProvider } from "../utils/rpc";
import { rpcForWalletOps, withProtocolRuntime } from "./protocol-runtime.js";
import { ERC20_ABI } from "../utils/tokens-util";
import type { ResolvedTokenMeta } from "../utils/tokens-util";
import {
  ETH_AS_ERC20,
  type SupportedProtocol,
} from "../utils/plugins";
import { makePublicAccountsStorage } from "../utils/public-accounts";

export type PublicAccountWithBalance = {
  index: number;
  address: string;
  priv: string;
  balance: bigint;
};

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
  transactions: ShieldTxPayload[];
};

export function parseFromIndex(fromValue: string): number | null {
  if (!/^\d+$/.test(fromValue)) return null;
  const parsed = Number(fromValue);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
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
  const rpc = await makeEthersProvider(rpcUrl);
  try {
    const withBalances: PublicAccountWithBalance[] = [];
    for (const acct of allPublicAccounts) {
      const bal = tokenMeta.isEth
        ? await rpc.getBalance(acct.address)
        : await new Contract(tokenMeta.tokenAddress, ERC20_ABI, rpc).balanceOf(
            acct.address
          );
      withBalances.push({
        index: acct.index,
        address: acct.address,
        priv: acct.priv,
        balance: bal,
      });
    }
    return withBalances;
  } finally {
    rpc.destroy();
  }
}

function encodeErc20ApproveTx(
  tokenAddress: string,
  spender: string,
  amount: bigint
): { to: string; data: string; value: bigint } {
  const iface = new Interface(ERC20_ABI);
  const data = iface.encodeFunctionData("approve", [spender, amount]);
  return { to: tokenAddress, data, value: 0n };
}

function toShieldTxs(op: unknown): Array<{ to: string; data: string; value: bigint }> {
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

  if (txs.length !== 1) {
    throw new Error(
      `Expected prepareShield() to return exactly 1 tx, got ${txs.length}.`
    );
  }
  return txs;
}

export async function simulateTransactionOrThrow(
  rpc: Awaited<ReturnType<typeof makeEthersProvider>>,
  tx: { to: string; from: string; data: string; value: bigint; gasLimit?: bigint },
  stepLabel: string
): Promise<void> {
  try {
    await rpc.call({
      to: tx.to,
      from: tx.from,
      data: tx.data,
      value: tx.value,
      gasLimit: tx.gasLimit,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${stepLabel} simulation failed: ${msg}`);
  }
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
      return { senderAddress: new Wallet(priv).address, senderPrivateKey: priv };
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
  } = opts;

  const { senderAddress, senderPrivateKey: _pk } = resolveShieldSender({
    fromValue,
    walletDir,
    mnemonic,
    password,
    dryRun: true,
    allowDeriveFromMnemonic,
  });

  return withProtocolRuntime(
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

        const op = await plugin.prepareShield(asset as AssetAmount);
        const shieldTx = toShieldTxs(op)[0]!;

        let approve: { to: string; data: string; value: bigint } | null = null;
        if (!tokenMeta.isEth) {
          const erc20Read = new Contract(tokenMeta.tokenAddress, ERC20_ABI, rpc);
          const allowance: bigint = await erc20Read.allowance(senderAddress, shieldTx.to);
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
        transactions.push({
          data: shieldTx.data,
          to: shieldTx.to,
          from: senderAddress,
          value: shieldTx.value.toString(),
        });

        return { senderAddress, approve, shieldTx, transactions };
      } finally {
        dispose();
      }
    }
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
}): Promise<BroadcastShieldResult> {
  const plan = await prepareShieldPlan({ ...opts, allowDeriveFromMnemonic: opts.allowDeriveFromMnemonic ?? true });
  const { senderAddress, approve, shieldTx } = plan;

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
    const signer = new Wallet(sender.senderPrivateKey, rpc);

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
      const erc20 = new Contract(opts.tokenMeta.tokenAddress, ERC20_ABI, signer);
      const t = await erc20.approve(shieldTx.to, opts.amount);
      await t.wait();
      results.push({ type: "approval", hash: t.hash });
    }

    await simulateTransactionOrThrow(
      rpc,
      {
        to: shieldTx.to,
        from: senderAddress,
        data: shieldTx.data,
        value: shieldTx.value,
        gasLimit: 2000000n,
      },
      "Shield transaction"
    );
    const s = await signer.sendTransaction({
      to: shieldTx.to,
      data: shieldTx.data,
      value: shieldTx.value,
      gasLimit: 2000000,
    });
    await s.wait();
    results.push({ type: "shield", hash: s.hash });
    return results;
  } finally {
    dispose();
  }
}

export function formatAmountPreview(amount: bigint, tokenMeta: ResolvedTokenMeta): string {
  return `${formatUnits(amount, tokenMeta.decimals)} ${tokenMeta.symbol}`;
}
