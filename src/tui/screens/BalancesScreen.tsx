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
  verbose,
  onBack,
}: {
  session: TuiSession;
  verbose: boolean;
  onBack: () => void;
}) {
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
          verbose,
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
  }, [session, verbose, refreshTick]);

  const balanceLines = useMemo(
    () => (snap ? formatBalancesLines(snap, verbose, warnings) : []),
    [snap, verbose, warnings]
  );

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
      subtitle={verbose ? "verbose" : "summary"}
      showKoi={false}
      animateKoi={false}
      footerHint="j/k PgUp/PgDn scroll balances · ↑↓ actions · Esc back"
    >
      <ScrollableLines lines={balanceLines} reservedRows={7} />
      <Box marginTop={1} flexShrink={0}>
        <SelectList
          items={[
            { label: "Refresh", value: "refresh" },
            { label: "Back to menu", value: "back" },
          ]}
          onSelect={(v) => {
            if (v === "back") onBack();
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
