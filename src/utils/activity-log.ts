import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decrypt, encrypt, generateSalt, isEncryptedEnvelopeV1 } from "./aes-storage.js";

export type ActivityContext = {
  walletDir: string;
  password: string;
  chainId: bigint;
  operation: string;
  protocol?: string;
  from?: string;
  to?: string;
};
export type ActivityEntry = {
  version: 1;
  id: string;
  timestamp: string;
  updatedAt: string;
  operation: string;
  protocol?: string;
  chainId: string;
  status: "submitted" | "confirmed" | "reverted";
  txHash?: string;
  userOpHash?: string;
  relayerUrl?: string;
  relayerJobId?: string;
  poolAddress?: string;
  nullifierHash?: string;
  from?: string;
  to?: string;
};
const context = new AsyncLocalStorage<ActivityContext>();

/** Called once after unlocking a command's wallet; inherited by every send. */
export function startActivityLog(value: ActivityContext): void {
  context.enterWith(value);
}

export function runWithActivityLog<T>(value: ActivityContext, fn: () => T): T {
  return context.run(value, fn);
}

/** Attach the private sender and final recipient to an outgoing Railgun submission. */
export function setRailgunActivityParticipants(from: string, to: string): void {
  const ctx = context.getStore();
  if (ctx?.protocol === "railgun") {
    ctx.from = from;
    ctx.to = to;
  }
}

function persist(ctx: ActivityContext, entry: ActivityEntry): void {
  const dir = join(ctx.walletDir, "activity");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${entry.id}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const encrypted = encrypt(JSON.stringify(entry), ctx.password, generateSalt());
  writeFileSync(temporary, JSON.stringify(encrypted), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

/** Logging must never turn an accepted submission into an apparent send failure. */
export function recordSubmission(hashes: { txHash?: string; userOpHash?: string;
  relayerUrl?: string; relayerJobId?: string; poolAddress?: string; nullifierHash?: string },
  options: { requirePersistence?: boolean } = {}):
  (update: Partial<Pick<ActivityEntry, "status" | "txHash" | "relayerJobId">>) => void {
  const ctx = context.getStore();
  if (!ctx) {
    if (options.requirePersistence) throw new Error("Cannot submit before starting encrypted activity tracking.");
    return () => {};
  }
  const timestamp = new Date().toISOString();
  const entry: ActivityEntry = {
    version: 1, id: randomUUID(), timestamp, updatedAt: timestamp,
    operation: ctx.operation, protocol: ctx.protocol,
    chainId: ctx.chainId.toString(), status: "submitted", ...hashes,
    ...(ctx.protocol === "railgun" && ctx.from && ctx.to ? { from: ctx.from, to: ctx.to } : {}),
  };
  const save = (required = false) => {
    try { persist(ctx, entry); }
    catch (error) {
      if (required) throw new Error("Cannot save encrypted submission metadata. No relayer proof was sent.");
      console.error(`Activity log could not be saved for ${entry.txHash ?? entry.userOpHash}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  save(options.requirePersistence);
  return (update) => {
    Object.assign(entry, update, { updatedAt: new Date().toISOString() });
    save();
  };
}

export function readActivity(walletDir: string, password: string): ActivityEntry[] {
  const dir = join(walletDir, "activity");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => {
    const envelope: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (!isEncryptedEnvelopeV1(envelope)) throw new Error(`Invalid activity file: ${name}`);
    const entry = JSON.parse(decrypt(envelope, password)) as ActivityEntry;
    if (entry.version !== 1) throw new Error(`Unsupported activity version: ${name}`);
    return entry;
  }).sort((a, b) => b.timestamp.localeCompare(a.timestamp) || a.id.localeCompare(b.id));
}
