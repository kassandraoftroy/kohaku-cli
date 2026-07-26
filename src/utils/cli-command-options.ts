/**
 * Shared Commander `--help` strings for options repeated across commands.
 * Keeps wording in one place without dictating `.option()` call order.
 */
export const cliOptions = {
  password: "Wallet password (required with --non-interactive; else prompted)",
  rpcUrl: "RPC URL (or set RPC_URL in env)",
  dataDir: "Kohaku data directory (default: ~/.kohaku-cli)",
  walletPickList: "Wallet name (omit to choose interactively from the list)",
  walletBalancesOptional:
    "Wallet name (optional without --non-interactive; omit to pick from the list)",
  nonInteractiveShieldLike:
    "Agent mode: JSON where applicable, no confirmations or spinners; requires --password and --wallet",
  nonInteractiveBalances:
    "Agent mode: JSON only, no prompts or spinners; requires --password and --wallet",
  nonInteractiveCompact:
    "Agent mode: no prompts or spinners; requires --password and --wallet",
  nonInteractiveListWallets:
    "Agent mode: print JSON instead of human-readable output (no prompts)",
  withoutTor:
    "Disable Tor for non-RPC HTTP (default: Tor on for private-protocol sync / shield / unshield). RPC stays clearnet. Or set KOHAKU_WITHOUT_TOR=1",
} as const;
