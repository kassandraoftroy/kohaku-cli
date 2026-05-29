import React, { useEffect, useState } from "react";

import { buildTuiSession, type TuiSession } from "./session.js";
import { resolveWalletDir } from "../utils/wallets-util.js";
import { resolveRpcUrl, DEFAULT_DATA_DIR } from "../utils/rpc.js";
import {
  BootScreen,
  FatalErrorScreen,
  PasswordScreen,
  RpcScreen,
} from "./screens/OnboardingScreens.js";
import {
  formatWalletRpcMismatchError,
  isWalletRpcChainMismatch,
} from "./rpc-validation.js";
import {
  WalletStartScreen,
  type WalletStartChoice,
} from "./screens/WalletStartScreen.js";
import {
  CreateWalletWizard,
  type CreateWalletResult,
} from "./screens/CreateWalletScreens.js";
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
  | { name: "create"; mode: "generate" | "import" }
  | { name: "rpc"; afterCreate?: boolean; walletName?: string }
  | { name: "password"; walletName: string }
  | { name: "boot" }
  | { name: "fatal"; message: string }
  | { name: "main"; session: TuiSession }
  | { name: "balances"; session: TuiSession; verbose: boolean }
  | { name: "shield"; session: TuiSession }
  | { name: "unshield"; session: TuiSession };

export default function App({ options }: { options: TuiLaunchOptions }) {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const presetWallet = options.wallet?.trim();
  const presetPassword = options.password?.trim();
  const envRpc = resolveRpcUrl(options.rpcUrl) || undefined;

  const [route, setRoute] = useState<Route>(() => {
    if (!presetWallet) return { name: "wallet" };
    if (!envRpc) return { name: "rpc", walletName: presetWallet };
    if (!presetPassword) return { name: "rpc", walletName: presetWallet };
    return { name: "boot" };
  });

  const [walletName, setWalletName] = useState(presetWallet ?? "");
  const [rpcUrl, setRpcUrl] = useState(envRpc ?? "");
  const [password, setPassword] = useState(presetPassword ?? "");
  const [bootError, setBootError] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState(false);

  const goFatal = (message: string) => setRoute({ name: "fatal", message });

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
        if (cancelled) return;
        const walletDir = resolveWalletDir(dataDir, walletName);
        if (isWalletRpcChainMismatch(e)) {
          goFatal(formatWalletRpcMismatchError(rpcUrl, walletDir, e));
          return;
        }
        setBootError(e instanceof Error ? e.message : String(e));
        setRoute({ name: "password", walletName });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [route.name, dataDir, walletName, password, rpcUrl]);

  function rpcWalletDir(name?: string): string | undefined {
    const n = (name ?? walletName).trim();
    if (!n) return undefined;
    try {
      return resolveWalletDir(dataDir, n);
    } catch {
      return undefined;
    }
  }

  function afterWalletCreated(result: CreateWalletResult) {
    setWalletName(result.walletName);
    setPassword(result.password);
    setBootError(null);
    setRoute({ name: "rpc", walletName: result.walletName, afterCreate: true });
  }

  function handleWalletChoice(choice: WalletStartChoice) {
    if (choice.kind === "unlock") {
      setWalletName(choice.walletName);
      setPassword("");
      setRoute({ name: "rpc", walletName: choice.walletName });
      return;
    }
    if (choice.kind === "generate") {
      setPendingImport(false);
      setRoute({ name: "create", mode: "generate" });
      return;
    }
    setPendingImport(true);
    if (!envRpc && !rpcUrl.trim()) {
      setRoute({ name: "rpc" });
    } else {
      setRoute({ name: "create", mode: "import" });
    }
  }

  if (route.name === "fatal") {
    return <FatalErrorScreen message={route.message} />;
  }

  if (route.name === "wallet") {
    return (
      <WalletStartScreen
        dataDir={dataDir}
        initialWallet={presetWallet}
        onChoose={handleWalletChoice}
        onQuit={() => process.exit(0)}
      />
    );
  }

  if (route.name === "create") {
    return (
      <CreateWalletWizard
        dataDir={dataDir}
        mode={route.mode}
        rpcUrl={rpcUrl || envRpc}
        onDone={afterWalletCreated}
        onBack={() => {
          setPendingImport(false);
          setRoute({ name: "wallet" });
        }}
      />
    );
  }

  if (route.name === "rpc") {
    const activeWallet = route.walletName ?? walletName;

    return (
      <RpcScreen
        autoApplyRpc={envRpc}
        walletDir={rpcWalletDir(activeWallet)}
        onDone={(url) => {
          setRpcUrl(url);
          if (pendingImport) {
            setRoute({ name: "create", mode: "import" });
            return;
          }
          if (route.afterCreate) {
            setRoute({ name: "boot" });
            return;
          }
          const havePassword = !!password.trim() || !!presetPassword;
          if (havePassword) {
            if (presetPassword && !password) setPassword(presetPassword);
            setRoute({ name: "boot" });
          } else {
            setRoute({ name: "password", walletName: activeWallet });
          }
        }}
        onBack={() => {
          setPendingImport(false);
          setRoute({ name: "wallet" });
        }}
        onFatal={goFatal}
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
          setRoute({ name: "rpc", walletName: route.walletName });
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
