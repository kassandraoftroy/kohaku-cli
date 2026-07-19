import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { formatUnits, getAddress, isAddress } from "ethers";

import {
  assertPpErc20TokenWhitelisted,
  assertTornadoEthOnly,
  assertTornadoUnshieldAmount,
  type SupportedProtocol,
} from "../../utils/plugins.js";
import { resolveTokenMeta } from "../../utils/tokens-util.js";
import {
  findPublicAccountByAddress,
  makePublicAccountsStorage,
} from "../../utils/public-accounts.js";
import {
  broadcastUnshield,
  extractUnshieldExplorerHash,
  maxUnshieldAmountHintForWallet,
  parseUnshieldAmount,
  prepareUnshieldOperation,
} from "../../lib/unshield-flow.js";
import PageLayout from "../widgets/PageLayout.js";
import { SelectList } from "../components/SelectList.js";
import { TextPrompt } from "../components/TextPrompt.js";
import { useEscBack, shortenAddr } from "../hooks/useEscBack.js";
import type { TuiSession } from "../session.js";
import { etherscanTxUrl } from "../etherscan.js";

const NEXT_FRESH = "__next_fresh__";
const CUSTOM_ADDR = "__custom__";

type Step =
  | "protocol"
  | "token"
  | "recipient"
  | "custom-addr"
  | "amount"
  | "confirm"
  | "running"
  | "done"
  | "error";

const CREAM = "#f5efe0";

function as0xPrivateKey(priv: string): `0x${string}` {
  return (priv.startsWith("0x") ? priv : `0x${priv}`) as `0x${string}`;
}

export function UnshieldScreen({
  session,
  onBack,
}: {
  session: TuiSession;
  onBack: () => void;
}) {
  const [step, setStep] = useState<Step>("protocol");
  const [protocol, setProtocol] = useState<SupportedProtocol | null>(null);
  const [tokenInput, setTokenInput] = useState("eth");
  const [tokenMeta, setTokenMeta] = useState<Awaited<
    ReturnType<typeof resolveTokenMeta>
  > | null>(null);
  const [recipient, setRecipient] = useState<`0x${string}` | null>(null);
  const [recipientPriv, setRecipientPriv] = useState<`0x${string}` | undefined>();
  const [customAddrInput, setCustomAddrInput] = useState("");
  const [maxHint, setMaxHint] = useState(0n);
  const [amountInput, setAmountInput] = useState("");
  const [amount, setAmount] = useState<bigint | null>(null);
  const [broadcast, setBroadcast] = useState(false);
  const [status, setStatus] = useState("");
  const [bundleTxHash, setBundleTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [persistNextAccount, setPersistNextAccount] = useState(false);

  useEscBack(onBack, step === "running");

  useEffect(() => {
    if (step !== "token" || protocol !== "tornado") return;
    let cancelled = false;
    void (async () => {
      try {
        const meta = await resolveTokenMeta("eth", session.rpcUrl, session.chainId);
        assertTornadoEthOnly(meta.isEth);
        if (!cancelled) {
          setTokenMeta(meta);
          setStep("recipient");
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setStep("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, protocol, session.rpcUrl]);

  async function resolveToken(): Promise<void> {
    const meta = await resolveTokenMeta(tokenInput, session.rpcUrl, session.chainId);
    if (protocol === "privacy-pools" && !meta.isEth) {
      assertPpErc20TokenWhitelisted(session.chainId, meta.tokenAddress);
    }
    if (protocol === "tornado") {
      assertTornadoEthOnly(meta.isEth);
    }
    setTokenMeta(meta);
    setStep("recipient");
  }

  useEffect(() => {
    if (step !== "amount" || !protocol || !tokenMeta) return;
    let cancelled = false;
    void (async () => {
      try {
        const hint = await maxUnshieldAmountHintForWallet({
          protocol,
          rpcUrl: session.rpcUrl,
          walletDir: session.walletDir,
          password: session.password,
          mnemonic: session.mnemonic,
          chainId: session.chainId,
          tokenMeta,
        });
        if (!cancelled) setMaxHint(hint.cap);
      } catch {
        if (!cancelled) setMaxHint(0n);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, protocol, tokenMeta, session]);

  if (step === "protocol") {
    return (
      <PageLayout title="Unshield" subtitle="protocol">
        <SelectList
          items={[
            { label: "Railgun", value: "railgun" as const },
            { label: "Privacy pools", value: "privacy-pools" as const },
            { label: "Tornado Cash", value: "tornado" as const },
          ]}
          onSelect={(p) => {
            setProtocol(p);
            setStep("token");
          }}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  if (step === "token") {
    if (protocol === "tornado") {
      return (
        <PageLayout title="Unshield" subtitle="token">
          <Text color={CREAM}>Tornado Cash supports ETH only.</Text>
        </PageLayout>
      );
    }
    return (
      <PageLayout title="Unshield" subtitle="token">
        <TextPrompt
          label="Token ('eth' or '0x address' of a token):"
          value={tokenInput}
          onChange={setTokenInput}
          onSubmit={() => void resolveToken().catch((e) => {
            setError(e instanceof Error ? e.message : String(e));
            setStep("error");
          })}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  if (step === "recipient" && protocol && tokenMeta) {
    const storage = makePublicAccountsStorage(
      session.walletDir,
      session.mnemonic,
      session.password
    );
    const existing = storage.getAccounts();
    const choices = [
      { label: "Next fresh public account", value: NEXT_FRESH },
      ...(protocol !== "railgun"
        ? [{ label: "Custom address", value: CUSTOM_ADDR }]
        : []),
      ...existing.map((a) => ({
        label: `[${a.index}] ${shortenAddr(a.address)}`,
        value: a.address,
      })),
    ];

    return (
      <PageLayout title="Unshield" subtitle="recipient">
        <SelectList
          items={choices}
          reservedRows={12}
          onSelect={(v) => {
            if (v === CUSTOM_ADDR) {
              setStep("custom-addr");
              return;
            }
            if (v === NEXT_FRESH) {
              const fresh = storage.peekNextAccounts(1)[0]!;
              setRecipient(getAddress(fresh.address) as `0x${string}`);
              setRecipientPriv(as0xPrivateKey(fresh.priv));
              setPersistNextAccount(true);
            } else {
              const addr = getAddress(v) as `0x${string}`;
              const acct = findPublicAccountByAddress(storage, addr);
              if (protocol === "railgun" && !acct) {
                setError("Railgun requires a wallet-owned public recipient.");
                setStep("error");
                return;
              }
              setRecipient(addr);
              setRecipientPriv(acct ? as0xPrivateKey(acct.priv) : undefined);
              setPersistNextAccount(false);
            }
            setStep("amount");
          }}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  if (step === "custom-addr") {
    return (
      <PageLayout title="Unshield" subtitle="address">
        <TextPrompt
          label="Recipient 0x:"
          value={customAddrInput}
          onChange={setCustomAddrInput}
          onSubmit={() => {
            if (!isAddress(customAddrInput.trim())) {
              setError("Invalid address");
              setStep("error");
              return;
            }
            setRecipient(getAddress(customAddrInput.trim()) as `0x${string}`);
            setRecipientPriv(undefined);
            setStep("amount");
          }}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  if (step === "amount" && tokenMeta) {
    const maxLabel =
      maxHint > 0n
        ? formatUnits(maxHint, tokenMeta.decimals)
        : "unknown";
    const maxHintText =
      protocol === "tornado" || protocol === "privacy-pools"
        ? `largest note ~${maxLabel}`
        : `max ~${maxLabel}`;
    return (
      <PageLayout title="Unshield" subtitle={`amount (${maxHintText}, or "max")`}>
        <TextPrompt
          label={`Amount (${tokenMeta.symbol}):`}
          value={amountInput}
          onChange={setAmountInput}
          onSubmit={() => {
            try {
              const parsed = parseUnshieldAmount(
                amountInput,
                tokenMeta.decimals,
                maxHint
              );
              if (protocol === "tornado") {
                assertTornadoUnshieldAmount(session.chainId, parsed);
              }
              setAmount(parsed);
              setStep("confirm");
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              setStep("error");
            }
          }}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  if (step === "confirm" && protocol && tokenMeta && amount && recipient) {
    if (protocol === "railgun" && !recipientPriv) {
      return (
        <PageLayout title="Unshield" subtitle="error">
          <Text color="#c92a2a">Railgun needs a wallet public account recipient.</Text>
          <SelectList items={[{ label: "Back", value: "b" }]} onSelect={onBack} onCancel={onBack} />
        </PageLayout>
      );
    }
    return (
      <PageLayout title="Unshield" subtitle="confirm">
        <Text color={CREAM}>
          {formatUnits(amount, tokenMeta.decimals)} {tokenMeta.symbol} → {recipient}
        </Text>
        <Text dimColor>via {protocol}</Text>
        <SelectList
          items={[
            { label: "Prepare only (no broadcast)", value: false },
            { label: "Broadcast via relayer", value: true },
          ]}
          onSelect={(b) => {
            setBroadcast(b);
            setStep("running");
            void runUnshield(b);
          }}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  async function runUnshield(doBroadcast: boolean): Promise<void> {
    if (!protocol || !tokenMeta || !amount || !recipient) return;
    setStatus("Working…");
    setBundleTxHash(null);
    try {
      if (doBroadcast) {
        setStatus("Broadcasting…");
        const relayResult = await broadcastUnshield({
          protocol,
          rpcUrl: session.rpcUrl,
          walletDir: session.walletDir,
          password: session.password,
          mnemonic: session.mnemonic,
          chainId: session.chainId,
          tokenMeta,
          amount,
          recipient,
          recipientPriv,
          onStatus: setStatus,
        });
        if (persistNextAccount) {
          makePublicAccountsStorage(
            session.walletDir,
            session.mnemonic,
            session.password
          ).addNextAccounts(1);
        }
        setBundleTxHash(
          extractUnshieldExplorerHash(relayResult, protocol)
        );
      } else {
        setStatus("Preparing…");
        await prepareUnshieldOperation({
          protocol,
          rpcUrl: session.rpcUrl,
          walletDir: session.walletDir,
          password: session.password,
          mnemonic: session.mnemonic,
          chainId: session.chainId,
          tokenMeta,
          amount,
          recipient,
          recipientPriv,
          onStatus: setStatus,
        });
      }
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("error");
    }
  }

  if (step === "running") {
    return (
      <PageLayout title="Unshield" subtitle="…">
        <Text color={CREAM}>{status}</Text>
      </PageLayout>
    );
  }

  if (step === "done") {
    return (
      <PageLayout title="Unshield" subtitle="complete">
        <Text color="#3ecf8e">✓ {broadcast ? "Broadcast" : "Prepared"} complete</Text>
        {broadcast && bundleTxHash ? (
          <Text color="#74c0fc">{etherscanTxUrl(session.chainId, bundleTxHash)}</Text>
        ) : broadcast ? (
          <Text dimColor>
            {protocol === "privacy-pools"
              ? "Relayer did not return an on-chain tx hash."
              : protocol === "tornado"
                ? "Tornado paymaster bundler did not return a userOpHash or tx hash."
                : "Bundler did not return a userOpHash or tx hash."}
          </Text>
        ) : null}
        <SelectList items={[{ label: "Back to menu", value: "b" }]} onSelect={onBack} onCancel={onBack} />
      </PageLayout>
    );
  }

  if (step === "error") {
    return (
      <PageLayout title="Unshield" subtitle="error">
        <Text color="#c92a2a">{error}</Text>
        <SelectList items={[{ label: "Back to menu", value: "b" }]} onSelect={onBack} onCancel={onBack} />
      </PageLayout>
    );
  }

  return null;
}
