import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";

import PageLayout from "../widgets/PageLayout.js";
import { TextPrompt } from "../components/TextPrompt.js";
import { readSeedKeystore } from "../../utils/mnemonic.js";
import { makeEthersProvider, resolveRpcUrl } from "../../utils/rpc.js";
import {
  assertRpcMatchesWallet,
  formatWalletRpcMismatchError,
  isWalletRpcChainMismatch,
  walletNetworkLabel,
} from "../rpc-validation.js";

const CREAM = "#f5efe0";

export function RpcScreen({
  autoApplyRpc,
  walletDir,
  onDone,
  onBack,
  onFatal,
}: {
  /** When set (from RPC_URL or --rpc-url), skip this screen and use that URL. */
  autoApplyRpc?: string;
  /** When set, RPC chain ID must match the wallet's .wallet-type before continuing. */
  walletDir?: string;
  onDone: (rpc: string) => void;
  onBack: () => void;
  onFatal?: (message: string) => void;
}) {
  const envOrFlagRpc = resolveRpcUrl();
  const [value, setValue] = useState(autoApplyRpc?.trim() || envOrFlagRpc || "");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const url = autoApplyRpc?.trim();
    if (!url) return;
    let cancelled = false;
    void (async () => {
      setChecking(true);
      try {
        await validateRpcUrl(url);
        if (!cancelled) onDone(url);
      } catch (e) {
        if (!cancelled) {
          if (walletDir && onFatal && isWalletRpcChainMismatch(e)) {
            onFatal(formatWalletRpcMismatchError(url, walletDir, e));
          } else {
            setError(e instanceof Error ? e.message : String(e));
            setChecking(false);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoApplyRpc, walletDir, onDone, onFatal]);

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
    setError(null);
    try {
      await validateRpcUrl(url);
      onDone(url);
    } catch (e) {
      if (walletDir && onFatal && isWalletRpcChainMismatch(e)) {
        onFatal(formatWalletRpcMismatchError(url, walletDir, e));
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  if (autoApplyRpc?.trim()) {
    return (
      <PageLayout title="Kohaku TUI" subtitle="RPC">
        <Text color={CREAM}>
          Using RPC from {process.env.RPC_URL ? "RPC_URL" : "--rpc-url"}…
        </Text>
        {walletDir ? (
          <Text dimColor>Checking chain matches {walletNetworkLabel(walletDir)}…</Text>
        ) : null}
        {error ? <Text color="#c92a2a">{error}</Text> : null}
      </PageLayout>
    );
  }

  return (
    <PageLayout title="Kohaku TUI" subtitle="RPC endpoint">
      <Text dimColor>
        {envOrFlagRpc
          ? "RPC_URL is set — edit below or press Enter to use it."
          : "No RPC_URL in environment — paste your HTTP RPC URL."}
      </Text>
      <TextPrompt
        label="RPC URL (HTTP/S):"
        value={value}
        onChange={setValue}
        onSubmit={() => void submit()}
        placeholder="https://..."
      />
      {walletDir ? (
        <Text dimColor>Wallet expects {walletNetworkLabel(walletDir)}.</Text>
      ) : null}
      {checking ? <Text color={CREAM}>Checking RPC…</Text> : null}
      {error ? <Text color="#c92a2a">{error}</Text> : null}
    </PageLayout>
  );
}

export function FatalErrorScreen({ message }: { message: string }) {
  useEffect(() => {
    const lines = message.split("\n");
    for (const line of lines) {
      console.error(line);
    }
    const t = setTimeout(() => process.exit(1), 100);
    return () => clearTimeout(t);
  }, [message]);

  return (
    <PageLayout title="Kohaku TUI" subtitle="error">
      <Text color="#c92a2a">{message}</Text>
      <Text dimColor>Exiting.</Text>
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
