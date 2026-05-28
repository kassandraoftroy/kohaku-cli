import React, { useEffect, useState } from "react";

import { buildTuiSession, type TuiSession } from "./session.js";
import { resolveWalletDir } from "../utils/wallets-util.js";
import { resolveRpcUrl, DEFAULT_DATA_DIR } from "../utils/rpc.js";
import {
  BootScreen,
  PasswordScreen,
  RpcScreen,
  WalletPickScreen,
} from "./screens/OnboardingScreens.js";
import { MainMenuScreen, type MainMenuAction } from "./screens/MainMenuScreen.js";
import { BalancesScreen } from "./screens/BalancesScreen.js";
import { ShieldScreen } from "./screens/ShieldScreen.js";
import { UnshieldScreen } from "./screens/UnshieldScreen.js";

export type TuiLaunchOptions = {
  dataDir?: string;
  wallet?: string;
  password?: string;
  rpcUrl?: string;
};

type Route =
  | { name: "wallet" }
  | { name: "rpc" }
  | { name: "password"; walletName: string }
  | { name: "boot" }
  | { name: "main"; session: TuiSession }
  | { name: "balances"; session: TuiSession; verbose: boolean }
  | { name: "shield"; session: TuiSession }
  | { name: "unshield"; session: TuiSession };

export default function App({ options }: { options: TuiLaunchOptions }) {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const presetWallet = options.wallet?.trim();
  const presetPassword = options.password?.trim();
  const presetRpc = resolveRpcUrl(options.rpcUrl) || undefined;

  const [route, setRoute] = useState<Route>(() => {
    if (!presetWallet) return { name: "wallet" };
    if (!presetRpc) return { name: "rpc" };
    if (!presetPassword) return { name: "password", walletName: presetWallet };
    return { name: "boot" };
  });

  const [walletName, setWalletName] = useState(presetWallet ?? "");
  const [rpcUrl, setRpcUrl] = useState(presetRpc ?? "");
  const [password, setPassword] = useState(presetPassword ?? "");
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    if (route.name !== "boot") return;
    let cancelled = false;
    void (async () => {
      try {
        const session = await buildTuiSession({
          dataDir,
          walletName,
          password,
          rpcUrl,
        });
        if (!cancelled) setRoute({ name: "main", session });
      } catch (e) {
        if (!cancelled) {
          setBootError(e instanceof Error ? e.message : String(e));
          setRoute({
            name: "password",
            walletName,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route.name, dataDir, walletName, password, rpcUrl]);

  if (route.name === "wallet") {
    return (
      <WalletPickScreen
        dataDir={dataDir}
        initialWallet={presetWallet}
        onDone={(w) => {
          setWalletName(w);
          if (presetRpc) {
            setRpcUrl(presetRpc);
            if (presetPassword) {
              setRoute({ name: "boot" });
            } else {
              setRoute({ name: "password", walletName: w });
            }
          } else {
            setRoute({ name: "rpc" });
          }
        }}
        onQuit={() => process.exit(0)}
      />
    );
  }

  if (route.name === "rpc") {
    return (
      <RpcScreen
        initialRpc={presetRpc}
        onDone={(url) => {
          setRpcUrl(url);
          setRoute({ name: "password", walletName });
        }}
        onBack={() => setRoute({ name: "wallet" })}
      />
    );
  }

  if (route.name === "password") {
    const walletDir = resolveWalletDir(dataDir, route.walletName);
    return (
      <PasswordScreen
        walletDir={walletDir}
        initialPassword={presetPassword}
        onDone={(pw) => {
          setPassword(pw);
          setBootError(null);
          setRoute({ name: "boot" });
        }}
        onBack={() => {
          if (presetRpc) setRoute({ name: "wallet" });
          else setRoute({ name: "rpc" });
        }}
      />
    );
  }

  if (route.name === "boot") {
    return (
      <BootScreen
        message={
          bootError
            ? `Unlock failed: ${bootError}`
            : "Unlocking wallet and verifying RPC chain…"
        }
      />
    );
  }

  if (route.name === "balances") {
    return (
      <BalancesScreen
        session={route.session}
        verbose={route.verbose}
        onBack={() => setRoute({ name: "main", session: route.session })}
      />
    );
  }

  if (route.name === "shield") {
    return (
      <ShieldScreen
        session={route.session}
        onBack={() => setRoute({ name: "main", session: route.session })}
      />
    );
  }

  if (route.name === "unshield") {
    return (
      <UnshieldScreen
        session={route.session}
        onBack={() => setRoute({ name: "main", session: route.session })}
      />
    );
  }

  if (route.name === "main") {
    return (
      <MainMenuScreen
        session={route.session}
        onAction={(action: MainMenuAction) => {
          if (action === "quit") process.exit(0);
          if (action === "balances") {
            setRoute({ name: "balances", session: route.session, verbose: false });
          } else if (action === "balances-verbose") {
            setRoute({ name: "balances", session: route.session, verbose: true });
          } else if (action === "shield") {
            setRoute({ name: "shield", session: route.session });
          } else if (action === "unshield") {
            setRoute({ name: "unshield", session: route.session });
          }
        }}
      />
    );
  }

  return null;
}
