import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";

import { loadBalancesSnapshot, type BalancesSnapshot } from "../../lib/balances-snapshot.js";
import { formatBalancesLines } from "../balances-format.js";
import { ScrollableLines } from "../components/ScrollableLines.js";
import PageLayout from "../widgets/PageLayout.js";
import { SelectList } from "../components/SelectList.js";
import type { TuiSession } from "../session.js";

const CREAM = "#f5efe0";

export function BalancesScreen({
  session,
  onBack,
}: {
  session: TuiSession;
  onBack: () => void;
}) {
  const [verbose, setVerbose] = useState(false);
  const [phase, setPhase] = useState<"loading" | "view" | "error">("loading");
  const [snap, setSnap] = useState<BalancesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await loadBalancesSnapshot({
          rpcUrl: session.rpcUrl,
          walletDir: session.walletDir,
          password: session.password,
          mnemonic: session.mnemonic,
          chainId: session.chainId,
          verbose: true,
          onWarning: (msg) => {
            if (!cancelled) setWarnings((w) => [...w, msg]);
          },
        });
        if (!cancelled) {
          setSnap(result);
          setPhase("view");
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, refreshTick]);

  const balanceLines = useMemo(
    () => (snap ? formatBalancesLines(snap, verbose, warnings) : []),
    [snap, verbose, warnings]
  );

  const actionItems = [
    { label: "Refresh", value: "refresh" as const },
    {
      label: verbose ? "See concise" : "See verbose",
      value: "toggle-view" as const,
    },
    { label: "Back to menu", value: "back" as const },
  ];

  if (phase === "loading") {
    return (
      <PageLayout title="Balances" subtitle="loading…" showKoi={false}>
        <Text color={CREAM}>Fetching public and private balances…</Text>
      </PageLayout>
    );
  }

  if (phase === "error" || !snap) {
    return (
      <PageLayout title="Balances" subtitle="error" showKoi={false}>
        <Text color="#c92a2a">{error ?? "Unknown error"}</Text>
        <SelectList
          items={[{ label: "Back to menu", value: "back" }]}
          onSelect={() => onBack()}
          onCancel={onBack}
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="Balances"
      subtitle={verbose ? "verbose" : "concise"}
      showKoi={false}
      animateKoi={false}
      footerHint="j/k PgUp/PgDn scroll balances · ↑↓ actions · Esc back"
    >
      <ScrollableLines lines={balanceLines} reservedRows={8} />
      <Box marginTop={1} flexShrink={0}>
        <SelectList
          items={actionItems}
          onSelect={(v) => {
            if (v === "back") onBack();
            else if (v === "toggle-view") setVerbose((v) => !v);
            else {
              setPhase("loading");
              setSnap(null);
              setWarnings([]);
              setRefreshTick((t) => t + 1);
            }
          }}
          onCancel={onBack}
        />
      </Box>
    </PageLayout>
  );
}
