import { log } from "@clack/prompts";
import chalk from "chalk";

/**
 * Standard CLI failure: red ✖ line via clack, `process.exitCode = 1`.
 * Pass the message without a leading `✖` (it is added unless already present).
 */
export function cliError(message: string): void {
  const m = message.trimStart();
  const line = m.startsWith("✖") ? m : `✖ ${m}`;
  log.error(chalk.red(line));
  process.exitCode = 1;
}

export function cliErrorFromCaught(e: unknown): void {
  cliError(e instanceof Error ? e.message : String(e));
}
