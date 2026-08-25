import { existsSync } from "node:fs";

import { pluginStorePathForWallet, type PluginId } from "../host/storage.js";
import { pluginIdForProtocol, type SupportedProtocol } from "./plugins.js";

/**
 * `${walletDir}|${pluginId}` -> storage file was missing when the Host was built.
 *
 * Privacy Pools seeds a bundled state snapshot into `ppv1-storage.json` while the
 * plugin is constructed, i.e. before any sync runs, so a plain file check made at
 * sync time would report an incremental sync on a genuinely first one. Recording
 * the answer at Host creation (the one step that always precedes plugin
 * construction) keeps callers free to ask whenever it suits them.
 */
const observed = new Map<string, boolean>();

function key(walletDir: string, pluginId: PluginId): string {
  return `${walletDir}|${pluginId}`;
}

function storeIsMissing(walletDir: string, pluginId: PluginId): boolean {
  return !existsSync(pluginStorePathForWallet(walletDir, pluginId));
}

/** Record whether this wallet has protocol state yet. Called from `makeHost`. */
export function noteProtocolStorageFreshness(
  walletDir: string,
  pluginId: PluginId
): void {
  const k = key(walletDir, pluginId);
  if (observed.has(k)) return;
  observed.set(k, storeIsMissing(walletDir, pluginId));
}

/** True when this wallet has no persisted state for `protocol` yet. */
export function isFirstProtocolSync(
  walletDir: string,
  protocol: SupportedProtocol
): boolean {
  const pluginId = pluginIdForProtocol(protocol);
  return (
    observed.get(key(walletDir, pluginId)) ??
    storeIsMissing(walletDir, pluginId)
  );
}

/** Test hook: drop memoized observations. */
export function resetFirstSyncObservations(): void {
  observed.clear();
}
