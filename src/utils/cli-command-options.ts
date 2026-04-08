/**
 * Shared Commander `--help` strings for options repeated across commands.
 * Keeps wording in one place without dictating `.option()` call order.
 */
export const cliOptions = {
  password: "Wallet password (required with --non-interactive; else prompted)",
  rpcUrl: "RPC URL (or set RPC_URL)",
  dataDir: "Kohaku data directory (default: ~/.kohaku-cli)",
  walletPickList: "Wallet name (omit to choose interactively from the list)",
  walletBalancesOptional:
    "Wallet name (optional without --non-interactive; omit to pick from the list)",
  nonInteractiveShieldLike:
    "Agent mode: no confirmation prompts; requires --password; --wallet required if omitted",
  nonInteractiveBalances:
    "Agent mode: JSON only, no prompts; requires --password and --wallet",
  nonInteractiveCompact:
    "Agent mode: no prompts; requires --password; --wallet required if omitted",
  nonInteractiveListWallets:
    "Agent mode: print JSON instead of human-readable output (no prompts)",
} as const;
