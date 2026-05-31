import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { formatUnits, parseUnits } from "ethers";

import PageLayout from "../widgets/PageLayout.js";
import { SelectList } from "../components/SelectList.js";
import { TextPrompt } from "../components/TextPrompt.js";
import { shortenAddr, useEscBack } from "../hooks/useEscBack.js";
import type { TuiSession } from "../session.js";
import {
  assertPpErc20TokenWhitelisted,
  type SupportedProtocol,
} from "../../utils/plugins.js";
import { resolveTokenMeta } from "../../utils/tokens-util.js";
import {
  broadcastShield,
  formatPublicAccountBalanceLabel,
  listPublicAccountsWithBalance,
  prepareShieldPlan,
  type PublicAccountWithBalance,
} from "../../lib/shield-flow.js";

type Step =
  | "protocol"
  | "token"
  | "accounts"
  | "amount"
  | "confirm"
  | "running"
  | "done"
  | "error";

const CREAM = "#f5efe0";

export function ShieldScreen({
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
  const [accounts, setAccounts] = useState<PublicAccountWithBalance[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [fromAddress, setFromAddress] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [amount, setAmount] = useState<bigint | null>(null);
  const [broadcast, setBroadcast] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [result, setResult] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEscBack(onBack, step === "running");

  useEffect(() => {
    if (step !== "accounts" || !tokenMeta) return;
    let cancelled = false;
    setAccountsLoading(true);
    setAccounts([]);
    void (async () => {
      try {
        const list = await listPublicAccountsWithBalance(
          session.rpcUrl,
          session.walletDir,
          session.mnemonic,
          session.password,
          tokenMeta
        );
        if (!cancelled) {
          setAccounts(list);
          setAccountsLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setAccountsLoading(false);
          setError(e instanceof Error ? e.message : String(e));
          setStep("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, tokenMeta, session]);

  async function resolveToken(): Promise<void> {
    const meta = await resolveTokenMeta(tokenInput, session.rpcUrl);
    if (protocol === "privacy-pools" && !meta.isEth) {
      assertPpErc20TokenWhitelisted(session.chainId, meta.tokenAddress);
    }
    setTokenMeta(meta);
    setStep("accounts");
  }

  function pickAmountAndContinue(): void {
    if (!tokenMeta) return;
    try {
      const parsed = parseUnits(amountInput.trim(), tokenMeta.decimals);
      if (parsed <= 0n) throw new Error("Amount must be > 0");
      setAmount(parsed);
      setStep("accounts");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("error");
    }
  }

  if (step === "protocol") {
    return (
      <PageLayout title="Shield" subtitle="protocol">
        <SelectList
          items={[
            { label: "Railgun", value: "railgun" as const },
            { label: "Privacy pools", value: "privacy-pools" as const },
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
    return (
      <PageLayout title="Shield" subtitle="token">
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

  if (step === "accounts" && tokenMeta) {
    if (accountsLoading) {
      return (
        <PageLayout title="Shield" subtitle="accounts">
          <Text color={CREAM}>Working… loading public accounts and balances</Text>
        </PageLayout>
      );
    }

    if (accounts.length === 0) {
      return (
        <PageLayout title="Shield" subtitle="accounts">
          <Text color="#c92a2a">No public accounts. Create one via next-fresh-address.</Text>
          <SelectList items={[{ label: "Back", value: "back" }]} onSelect={onBack} onCancel={onBack} />
        </PageLayout>
      );
    }

    if (amount === null) {
      return (
        <PageLayout title="Shield" subtitle={`amount (${tokenMeta.symbol})`}>
          <Text dimColor>Balances per public account ({tokenMeta.symbol}):</Text>
          <TextPrompt
            label={`Amount (${tokenMeta.symbol}):`}
            value={amountInput}
            onChange={setAmountInput}
            onSubmit={pickAmountAndContinue}
            onCancel={onBack}
          />
          <Box marginTop={1} flexDirection="column">
            {accounts.map((a) => (
              <Text key={a.address} dimColor>
                [{a.index}] {shortenAddr(a.address)}  {formatPublicAccountBalanceLabel(a, tokenMeta)}
              </Text>
            ))}
          </Box>
        </PageLayout>
      );
    }

    const need = amount;
    const candidates = accounts.filter((a) => a.balance >= need);
    if (candidates.length === 0) {
      return (
        <PageLayout title="Shield" subtitle="accounts">
          <Text color="#c92a2a">
            No account has {formatUnits(need, tokenMeta.decimals)} {tokenMeta.symbol}
          </Text>
          <SelectList
            items={[{ label: "Change amount", value: "amt" }, { label: "Back", value: "back" }]}
            onSelect={(v) => {
              if (v === "back") onBack();
              else {
                setAmount(null);
              }
            }}
            onCancel={onBack}
          />
        </PageLayout>
      );
    }

    if (!fromAddress) {
      return (
        <PageLayout title="Shield" subtitle="source account">
          <SelectList
            items={candidates.map((a) => ({
              label: `[${a.index}] ${a.address.slice(0, 10)}… ${formatPublicAccountBalanceLabel(a, tokenMeta)}`,
              value: a.address,
            }))}
            onSelect={(addr) => {
              setFromAddress(addr);
              setStep("confirm");
            }}
            onCancel={onBack}
          />
        </PageLayout>
      );
    }
  }

  if (step === "confirm" && protocol && tokenMeta && amount && fromAddress) {
    return (
      <PageLayout title="Shield" subtitle="confirm">
        <Text color={CREAM}>
          {formatUnits(amount, tokenMeta.decimals)} {tokenMeta.symbol} → {protocol}
        </Text>
        <Text>From: {fromAddress}</Text>
        <SelectList
          items={[
            { label: "Dry run (prepare txs only)", value: false },
            { label: "Broadcast on-chain", value: true },
          ]}
          onSelect={(b) => {
            setBroadcast(b);
            setStep("running");
            void runShield(b);
          }}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  async function runShield(doBroadcast: boolean): Promise<void> {
    if (!protocol || !tokenMeta || !amount || !fromAddress) return;
    setStatus("Working…");
    try {
      if (doBroadcast) {
        const txs = await broadcastShield({
          protocol,
          rpcUrl: session.rpcUrl,
          walletDir: session.walletDir,
          password: session.password,
          mnemonic: session.mnemonic,
          chainId: session.chainId,
          tokenMeta,
          amount,
          fromValue: fromAddress,
          allowDeriveFromMnemonic: false,
        });
        setResult(txs.map((t) => `${t.type}: ${t.hash}`));
      } else {
        const plan = await prepareShieldPlan({
          protocol,
          rpcUrl: session.rpcUrl,
          walletDir: session.walletDir,
          password: session.password,
          mnemonic: session.mnemonic,
          chainId: session.chainId,
          tokenMeta,
          amount,
          fromValue: fromAddress,
        });
        setResult(
          plan.transactions.map(
            (t, i) => `tx ${i + 1}: to ${t.to.slice(0, 10)}… value ${t.value}`
          )
        );
      }
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("error");
    }
  }

  if (step === "running") {
    return (
      <PageLayout title="Shield" subtitle="…">
        <Text color={CREAM}>{status}</Text>
      </PageLayout>
    );
  }

  if (step === "done") {
    return (
      <PageLayout title="Shield" subtitle="complete">
        <Text color="#3ecf8e">✓ {broadcast ? "Broadcast" : "Dry run"} complete</Text>
        {result.map((line, i) => (
          <Text key={i} dimColor>
            {line}
          </Text>
        ))}
        <SelectList
          items={[{ label: "Back to menu", value: "back" }]}
          onSelect={onBack}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  if (step === "error") {
    return (
      <PageLayout title="Shield" subtitle="error">
        <Text color="#c92a2a">{error}</Text>
        <SelectList
          items={[{ label: "Back to menu", value: "back" }]}
          onSelect={onBack}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  return null;
}
