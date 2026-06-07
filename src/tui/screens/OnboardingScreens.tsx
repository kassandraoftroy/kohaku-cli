import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";

import PageLayout from "../widgets/PageLayout.js";
import { TextPrompt } from "../components/TextPrompt.js";
import { readSeedKeystore } from "../../utils/mnemonic.js";
import { makeEthersProvider, resolveRpcUrl } from "../../utils/rpc.js";
import {
  assertRpcMatchesWallet,
  formatWalletRpcMismatchBrief,
  isWalletRpcChainMismatch,
  walletNetworkLabel,
} from "../rpc-validation.js";

const CREAM = "#f5efe0";
const WARN = "#ffb000";

export function RpcScreen({
  autoApplyRpc,
  initialRpc,
  walletDir,
  initialAlert,
  pageTitle = "Kohaku TUI",
  pageSubtitle = "RPC endpoint",
  onDone,
  onBack,
}: {
  /** When set (from RPC_URL or --rpc-url), try once without prompting. */
  autoApplyRpc?: string;
  /** Prefill the RPC input (e.g. current session RPC when changing). */
  initialRpc?: string;
  /** When set, RPC chain ID must match the wallet's .wallet-type before continuing. */
  walletDir?: string;
  /** Shown when returning after a wrong-network RPC (user can enter a new URL). */
  initialAlert?: string;
  pageTitle?: string;
  pageSubtitle?: string;
  onDone: (rpc: string) => void;
  onBack: () => void;
}) {
  const envOrFlagRpc = resolveRpcUrl();
  const [manualEntry, setManualEntry] = useState(
    () => !!initialAlert || !!initialRpc?.trim() || !autoApplyRpc?.trim()
  );
  const [value, setValue] = useState(
    () => initialRpc?.trim() || autoApplyRpc?.trim() || envOrFlagRpc || ""
  );
  const [alert, setAlert] = useState<string | null>(initialAlert ?? null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const url = autoApplyRpc?.trim();
    if (!url || manualEntry) return;

    let cancelled = false;
    void (async () => {
      setChecking(true);
      setAlert(null);
      setError(null);
      try {
        await validateRpcUrl(url);
        if (!cancelled) onDone(url);
      } catch (e) {
        if (cancelled) return;
        if (walletDir && isWalletRpcChainMismatch(e)) {
          setManualEntry(true);
          setValue(url);
          setAlert(formatWalletRpcMismatchBrief(walletDir, e));
          setChecking(false);
          return;
        }
        setManualEntry(true);
        setValue(url);
        setError(e instanceof Error ? e.message : String(e));
        setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoApplyRpc, manualEntry, walletDir, onDone]);

  useInput((_, key) => {
    if (key.escape && !checking) onBack();
  });

  async function validateRpcUrl(url: string): Promise<void> {
    const rpc = await makeEthersProvider(url);
    try {
      await rpc.getNetwork();
    } finally {
      rpc.destroy();
    }
    if (walletDir) {
      await assertRpcMatchesWallet(url, walletDir);
    }
  }

  async function submit() {
    const url = value.trim();
    if (!url) {
      setError("RPC URL is required (or set RPC_URL in your environment).");
      return;
    }
    setChecking(true);
    setAlert(null);
    setError(null);
    try {
      await validateRpcUrl(url);
      onDone(url);
    } catch (e) {
      if (walletDir && isWalletRpcChainMismatch(e)) {
        setAlert(formatWalletRpcMismatchBrief(walletDir, e));
        setError(null);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setChecking(false);
    }
  }

  if (!manualEntry && autoApplyRpc?.trim()) {
    return (
      <PageLayout title={pageTitle} subtitle="RPC">
        <Text color={CREAM}>
          Using RPC from {process.env.RPC_URL ? "RPC_URL" : "--rpc-url"}…
        </Text>
        {walletDir ? (
          <Text dimColor>Checking chain matches {walletNetworkLabel(walletDir)}…</Text>
        ) : null}
        {checking ? <Text color={CREAM}>Checking RPC…</Text> : null}
      </PageLayout>
    );
  }

  return (
    <PageLayout title={pageTitle} subtitle={pageSubtitle}>
      {alert ? (
        <Box marginBottom={1} flexDirection="column">
          <Text color={WARN} bold>
            Wrong network for this wallet
          </Text>
          <Text color={WARN}>{alert}</Text>
        </Box>
      ) : null}
      <Text dimColor>
        {envOrFlagRpc && !alert
          ? "RPC_URL is set — edit below or press Enter to use it."
          : "Paste an HTTP RPC URL for your wallet's network."}
      </Text>
      <TextPrompt
        label="RPC URL (HTTP/S):"
        value={value}
        onChange={setValue}
        onSubmit={() => void submit()}
        onCancel={() => {
          if (!checking) onBack();
        }}
        placeholder="https://..."
      />
      {walletDir ? (
        <Text dimColor>Required: {walletNetworkLabel(walletDir)}</Text>
      ) : null}
      {checking ? <Text color={CREAM}>Checking RPC…</Text> : null}
      {error ? <Text color="#c92a2a">{error}</Text> : null}
    </PageLayout>
  );
}

export function PasswordScreen({
  walletDir,
  initialPassword,
  onDone,
  onBack,
}: {
  walletDir: string;
  initialPassword?: string;
  onDone: (password: string) => void;
  onBack: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = initialPassword?.trim();
    if (!raw) return;
    try {
      readSeedKeystore(raw, walletDir);
      onDone(raw);
    } catch {
      // fall through to prompt
    }
  }, [initialPassword, walletDir, onDone]);

  useInput((_, key) => {
    if (key.escape) onBack();
  });

  function submit() {
    const pw = value.trim();
    if (!pw) {
      setError("Password cannot be empty.");
      return;
    }
    try {
      readSeedKeystore(pw, walletDir);
      onDone(pw);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid password.");
    }
  }

  if (initialPassword?.trim()) {
    try {
      readSeedKeystore(initialPassword.trim(), walletDir);
      return null;
    } catch {
      // show prompt
    }
  }

  return (
    <PageLayout title="Kohaku TUI" subtitle="unlock wallet">
      <TextPrompt
        label="Wallet password:"
        value={value}
        onChange={setValue}
        onSubmit={submit}
        onCancel={onBack}
        mask="*"
      />
      {error ? <Text color="#c92a2a">{error}</Text> : null}
    </PageLayout>
  );
}

export function BootScreen({ message }: { message: string }) {
  return (
    <PageLayout title="Kohaku TUI" subtitle="starting">
      <Box>
        <Text color={CREAM}>{message}</Text>
      </Box>
    </PageLayout>
  );
}
