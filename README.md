# kohaku-cli

A terminal wallet for moving funds between **public** Ethereum accounts (derived from your seed) and **private** balances on [Railgun](https://railgun.org/) and [Privacy Pools](https://privacypools.com/). The CLI encrypts your seed on disk, walks you through shield / unshield with prompts, and can run headlessly with `--non-interactive` for scripts and agents.

**Requirements:** Node.js 22+, an Ethereum RPC URL (`RPC_URL` or `--rpc-url`).

```bash
npm install
npm run build
# or during development:
npm run dev -- <command> ...
```

After build, the binary is `kohaku` (see `package.json`). Examples below use `kohaku`; swap in `npm run dev --` if you have not built yet.

Set your RPC once per shell (Sepolia for `--testnet` wallets):

```bash
export RPC_URL="https://sepolia.infura.io/v3/YOUR_KEY"
```

Some commands sync private state by calling `eth_getLogs` in chunks (default: up to **499** blocks per request). If your provider rejects large log ranges or times out, lower the chunk size:

```bash
export KOHAKU_GETLOGS_MAX_BLOCK_SPAN=100
```

Use any positive integer; smaller values mean more RPC calls but fewer failures on strict nodes.

Wallet data lives in `~/.kohaku-cli` by default (`--dataDir` to override).

---

## Getting started

This walkthrough creates a testnet wallet, funds a fresh public address, shields ETH into Privacy Pools, checks balances, then unshields to a **new** public address so the withdrawal lands on an address that was never used as the shield source.

### 1. Create wallets

**New seed (CLI generates and shows the mnemonic once):**

```bash
kohaku create-wallet testWallet --testnet
```

You will be asked for an encryption password twice. Copy the mnemonic from the boxed output and store it offline; it is not shown again.

**Import an existing seed (scans RPC for used addresses and resumes account index):**

```bash
kohaku create-wallet importTest --testnet --import
```

Paste your 12- or 24-word phrase when prompted (masked). `--rpc-url` or `RPC_URL` is required for import so the CLI can detect which derived addresses already have activity.

### 2. See what you have

```bash
kohaku balances
```

Pick `testWallet` if you have more than one wallet, enter the wallet password, then wait for the spinner. You should see **Public** totals (ETH + common ERC-20s on Sepolia), plus **Private — Railgun** and **Private — Privacy pools** (both empty at first).

To pin the wallet and get per-address detail:

```bash
kohaku balances --wallet testWallet --verbose
```

### 3. Get a deposit address

```bash
kohaku next-fresh-address --wallet testWallet
```

The command prints a single `0x…` address and saves it as the next public account in your wallet. Send **Sepolia ETH** (and optionally test ERC-20s) to that address from a faucet or another wallet. Run `balances` again until public ETH shows up.

### 4. Shield into Privacy Pools (ETH)

Dry run first (prints transaction JSON, does not send):

```bash
kohaku shield --protocol privacy-pools --wallet testWallet
```

Interactively: enter the amount of ETH to shield, then choose a public account that has enough balance. Review the planned tx(s). Add `--broadcast` when you are ready to sign and submit on-chain:

```bash
kohaku shield --protocol privacy-pools --wallet testWallet --broadcast --amount-formatted 0.01
```

You will confirm one or two steps: an ERC-20 **approval** only appears for tokens, not native ETH. Confirm the shield transaction when asked; spinners show mining status.

Check balances again — public ETH should drop and **Private — Privacy pools** should show the shielded amount:

```bash
kohaku balances --wallet testWallet
```

### 5. Unshield to a fresh public address

Withdraw private ETH back to public chain via the protocol relayer. Dry run builds the private operation JSON:

```bash
kohaku unshield --protocol privacy-pools --wallet testWallet
```

Interactively: choose **Generate next fresh public account** (recommended for a clean recipient), enter the amount (prompt shows max; Privacy Pools uses the **largest single note** per withdrawal). Then add `--broadcast` to submit through the relayer:

```bash
kohaku unshield --protocol privacy-pools --wallet testWallet --next --amount-formatted 0.01 --broadcast
```

Confirm the broadcast prompt (amount + recipient). The CLI syncs private state first, prepares the proof, then relays. A new address is printed via `--next` (same idea as `next-fresh-address`).

```bash
kohaku balances --wallet testWallet
```

You should see private Privacy Pools balance decrease and the new public account holding ETH — funds that left the pool on an address not used when you shielded.

---

## Commands list

Global behavior:

| Topic | Detail |
|--------|--------|
| **RPC** | `--rpc-url <url>` or env `RPC_URL` (required for most commands except `create-wallet` without `--import`, and `list-wallets`). |
| **Data directory** | `--dataDir <path>` (default `~/.kohaku-cli`). |
| **Networks** | Wallets created with `--testnet` expect Sepolia (`11155111`); otherwise mainnet (`1`). RPC chain ID must match the wallet. |
| **`--non-interactive`** | Available on every command below. Skips prompts and spinners; prints **JSON** where applicable. Requires flags documented per command (`--password`, `--wallet`, amounts, `--from`, `--to` / `--next`, etc.). Use for CI, agents, and piping output. |
| **`--password`** | Wallet unlock password. In non-interactive mode, required where the wallet is encrypted. Value can be a literal string or a path to a file containing the password. |

---

### `create-wallet <name>`

Create a BIP-39 seed wallet encrypted on disk.

| Option | Description |
|--------|-------------|
| `--testnet` | Tag wallet for Sepolia instead of mainnet. |
| `--import` | Restore from mnemonic instead of generating a new one. |
| `--rpc-url <url>` | Required with `--import` (or `RPC_URL`) to scan used addresses. |
| `--mnemonic <phrase>` | Mnemonic (required with `--non-interactive --import`). |
| `--password <password>` | Encryption password (required with `--non-interactive`). |
| `--non-interactive` | No prompts; no mnemonic box on create. |
| `--dataDir <path>` | Data root. |

**Interactive:** encryption password (twice); for `--import`, masked mnemonic entry. New wallets display the mnemonic once in a warning box.

**Examples:**

```bash
kohaku create-wallet myWallet --testnet
kohaku create-wallet restored --testnet --import --rpc-url "$RPC_URL"
```

---

### `list-wallets`

List wallet names and network kind (mainnet / testnet).

| Option | Description |
|--------|-------------|
| `--non-interactive` | Output `{"wallets":{"name":{"mainnet":true|false|null}}}` |
| `--dataDir <path>` | Data root. |

---

### `next-fresh-address`

Derive and persist the next HD public account; print its address.

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet (prompt if omitted). |
| `--password <password>` | Unlock password. |
| `--non-interactive` | Requires `--wallet` and `--password`; prints address only. |
| `--dataDir <path>` | Data root. |

**Interactive:** wallet picker (if needed), wallet password.

**Examples:**

```bash
kohaku next-fresh-address --wallet testWallet
kohaku next-fresh-address --wallet testWallet --password "$WALLET_PW" --non-interactive
```

---

### `balances`

Show aggregated **public** balances (ETH + default ERC-20s for the chain, plus any private tokens discovered), and **private** balances for Railgun and Privacy Pools.

| Option | Description |
|--------|-------------|
| `--wallet <name>` | Wallet (optional in interactive mode). |
| `--password <password>` | Unlock password. |
| `--rpc-url <url>` | RPC endpoint. |
| `--verbose` | Human: per-address public breakdown + Privacy Pools note list. JSON: adds `public_account_indexes_by_address` and `private_notes`. |
| `--tokensList <addrs>` | Extra ERC-20 addresses (comma- or space-separated), merged with chain defaults. |
| `--non-interactive` | JSON only; requires `--wallet` and `--password`. |
| `--dataDir <path>` | Data root. |

**Interactive:** wallet picker, password, loading spinner, formatted tables.

Default Sepolia ERC-20s include USDC and WETH; mainnet adds USDC, USDT, DAI, WETH.

**Examples:**

```bash
kohaku balances --wallet testWallet
kohaku balances --wallet testWallet --verbose --tokensList 0xYourToken
```

---

### `shield`

Move funds from a **public** account into a private protocol.

| Option | Description |
|--------|-------------|
| `--protocol <railgun\|privacy-pools>` | **Required.** |
| `--wallet <name>` | Wallet. |
| `--password <password>` | Unlock password. |
| `--from <address-or-index>` | Sender public account (address or HD index). |
| `--from-priv` | With `--broadcast`: derive private key by index from mnemonic if account not yet in stored public list. |
| `--token <address\|eth>` | Token (default: `eth`). |
| `--amount-wei <n>` | Amount in base units. |
| `--amount-formatted <decimal>` | Human amount (uses token decimals). |
| `--rpc-url <url>` | RPC endpoint. |
| `--broadcast` | Sign and send on-chain. **Omit** for dry-run (transaction JSON only). |
| `--base-fee-gwei`, `--priority-fee-gwei` | Optional fee overrides (reserved; auto fees used today). |
| `--non-interactive` | JSON output; requires `--wallet`, `--password`, `--from`, and an amount flag. |
| `--dataDir <path>` | Data root. |

**Interactive (no amount / from flags):** lists public accounts with balances for the token → amount prompt → account picker → dry-run JSON or confirmations with `--broadcast`.

**Protocols:**

- **privacy-pools** — Native ETH shield; non-ETH tokens must be on the protocol whitelist for your chain.
- **railgun** — ETH and ERC-20; non-ETH may need an approval transaction before shield.

**Examples:**

```bash
kohaku shield --protocol privacy-pools --wallet testWallet --broadcast --amount-formatted 0.05
kohaku shield --protocol railgun --wallet testWallet --from 0 --token 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 --amount-formatted 10 --broadcast
```

---

### `unshield`

Withdraw **private** balance to a **public** address via the protocol broadcaster / relayer.

| Option | Description |
|--------|-------------|
| `--protocol <railgun\|privacy-pools>` | **Required.** |
| `--wallet <name>` | Wallet. |
| `--password <password>` | Unlock password. |
| `--to <address>` | Recipient public address. |
| `--next` | Create and use the next fresh public account (mutually exclusive with `--to`). |
| `--token <address\|eth>` | Token (default: `eth`). |
| `--amount-wei <n>` | Amount in base units. |
| `--amount-formatted <decimal>` | Human amount. |
| `--rpc-url <url>` | RPC endpoint. |
| `--broadcast` | Submit via Railgun Waku broadcaster or Privacy Pools relayer. **Omit** to print prepared private operation JSON only. |
| `--non-interactive` | JSON; requires `--wallet`, `--password`, `--to` or `--next`, and an amount flag. |
| `--dataDir <path>` | Data root. |

**Interactive:** recipient menu (next fresh / custom address / existing account) → amount (shows max; Privacy Pools capped by largest note) → prepared op or broadcast confirmation.

**Examples:**

```bash
kohaku unshield --protocol privacy-pools --wallet testWallet
kohaku unshield --protocol privacy-pools --wallet testWallet --next --amount-formatted 0.01 --broadcast
```

---

### `see-decrypted-storage <type>`

Debug helper: decrypt and print wallet storage JSON.

| Argument | `public` \| `railgun` \| `privacy-pools` |
|--------|-------------------------------------------|
| Options | Same wallet / password / `--non-interactive` / `--dataDir` as other commands. |

Files: `public-accounts.json`, `rg-storage.json`, `ppv1-storage.json`.

---

## Tips

- **Dry run vs broadcast:** `shield` and `unshield` default to *prepare only*. Always read the printed JSON before adding `--broadcast`.
- **Fresh addresses:** Use `next-fresh-address` before funding, and `unshield --next` when you want withdrawals to land on a new public key that was not your shield source.
- **Privacy Pools note size:** Each unshield uses one note; large shields may require multiple unshields if balances are split across notes.
- **Agents:** Pass `--non-interactive --password … --wallet …` and parse JSON stdout; set `RPC_URL` in the environment to avoid repeating `--rpc-url`.
