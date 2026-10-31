import type { Host } from "@kohaku-eth/plugins";

const contexts = new WeakMap<Host, { rpcUrl: string; walletDir: string }>();

export function setRailgunHostContext(host: Host, rpcUrl: string, walletDir: string): void {
  contexts.set(host, { rpcUrl, walletDir });
}

export function railgunHostContext(host: Host): { rpcUrl: string; walletDir: string } {
  const context = contexts.get(host);
  if (!context) throw new Error("Railgun host is missing its RPC context");
  return context;
}
