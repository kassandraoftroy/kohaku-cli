import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  loadBalancesSnapshot,
  type BalancesSnapshot,
} from "../../lib/balances-snapshot.js";
import type { TuiSession } from "../session.js";

type BalancesPhase = "loading" | "view" | "error";

type BalancesContextValue = {
  walletName: string;
  verbose: boolean;
  setVerbose: (v: boolean) => void;
  toggleVerbose: () => void;
  phase: BalancesPhase;
  snap: BalancesSnapshot | null;
  warnings: string[];
  error: string | null;
  refresh: () => void;
};

const BalancesContext = createContext<BalancesContextValue | null>(null);

export function BalancesProvider({
  session,
  children,
}: {
  session: TuiSession;
  children: React.ReactNode;
}) {
  const [verbose, setVerbose] = useState(false);
  const [phase, setPhase] = useState<BalancesPhase>("loading");
  const [snap, setSnap] = useState<BalancesSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => {
    setPhase("loading");
    setSnap(null);
    setError(null);
    setWarnings([]);
    setRefreshTick((t) => t + 1);
  }, []);

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

  const value = useMemo(
    () => ({
      walletName: session.walletName,
      verbose,
      setVerbose,
      toggleVerbose: () => setVerbose((v) => !v),
      phase,
      snap,
      warnings,
      error,
      refresh,
    }),
    [session.walletName, verbose, phase, snap, warnings, error, refresh]
  );

  return (
    <BalancesContext.Provider value={value}>{children}</BalancesContext.Provider>
  );
}

export function useBalances(): BalancesContextValue | null {
  return useContext(BalancesContext);
}
