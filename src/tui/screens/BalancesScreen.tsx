import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

import { loadBalancesSnapshot, type BalancesSnapshot } from "../../lib/balances-snapshot.js";
import PageLayout from "../widgets/PageLayout.js";
import { SelectList } from "../components/SelectList.js";
import type { TuiSession } from "../session.js";

const CREAM = "#f5efe0";

function shortenAddr(addr: string): string {
  if (addr.length < 14) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function BalanceRows({ rows }: { rows: { symbol: string; formatted_token_holdings: string }[] }) {
  if (rows.length === 0) {
    return <Text dimColor>(none)</Text>;
  }
  return (
    <>
      {rows.map((r, i) => (
        <Text key={i}>
          <Text color={CREAM}>{r.symbol.padEnd(10)}</Text>
          <Text> {r.formatted_token_holdings}</Text>
        </Text>
      ))}
    </>
  );
}

function BalancesView({ snap, verbose }: { snap: BalancesSnapshot; verbose: boolean }) {
  return (
    <Box flexDirection="column">
      <Text bold color="#c92a2a">
        Public (aggregated)
      </Text>
      <BalanceRows rows={snap.publicAggregated} />

      <Text bold color="#c92a2a">
        {" "}
        Private — Railgun
      </Text>
      <BalanceRows rows={snap.privateRailgun} />

      <Text bold color="#c92a2a">
        {" "}
        Private — Privacy pools
      </Text>
      <BalanceRows rows={snap.privatePrivacyPools} />

      {verbose ? (
        <>
          <Text bold color="#c92a2a">
            {" "}
            Public by address
          </Text>
          {Object.entries(snap.publicByAddress).map(([addr, rows]) => {
            const idx = snap.publicAccountIndexByAddress[addr];
            return (
              <Box key={addr} flexDirection="column" marginBottom={1}>
                <Text color={CREAM}>
                  {idx !== undefined ? `[${idx}] ` : ""}
                  {addr}
                </Text>
                <BalanceRows rows={rows} />
              </Box>
            );
          })}
          {snap.privacyPoolsNotes && snap.privacyPoolsNotes.length > 0 ? (
            <>
              <Text bold color="#c92a2a">
                {" "}
                Privacy pool notes
              </Text>
              {snap.privacyPoolsNotes.map((n) => (
                <Text key={n.label}>
                  label {n.label} · {n.balance_formatted} · {shortenAddr(n.asset_address)}{" "}
                  {n.approved ? "approved" : "pending"}
                </Text>
              ))}
            </>
          ) : null}
        </>
      ) : null}
    </Box>
  );
}

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

  if (phase === "loading") {
    return (
      <PageLayout title="Balances" subtitle="loading…">
        <Text color={CREAM}>Fetching public and private balances…</Text>
      </PageLayout>
    );
  }

  if (phase === "error" || !snap) {
    return (
      <PageLayout title="Balances" subtitle="error">
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
    <PageLayout title="Balances" subtitle={verbose ? "verbose" : "summary"} animateKoi={false}>
      {warnings.map((w, i) => (
        <Text key={i} color="#ffb000">
          ⚠ {w}
        </Text>
      ))}
      <BalancesView snap={snap} verbose={verbose} />
      <Box marginTop={1}>
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
