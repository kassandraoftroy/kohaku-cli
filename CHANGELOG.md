# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.0.10] - 2026-10-21

### Changed

- `@kohaku-eth/tornado-cash` and `@kohaku-eth/privacy-pools` `0.1.0-alpha.27`. New Tornado and Privacy Pools shields use signature-derived secrets. Existing BIP-32 notes and imported Tornado note strings stay in their current storage and remain spendable. Balances show the combined total and, when it is non-zero, how much of that total is legacy. Notes and JSON omit derivation labels when the wallet has no legacy notes. An unshield or private transfer spends legacy notes when that scheme covers the amount, otherwise signature notes, and warns only when legacy notes are spent. It errors when neither covers it. One withdrawal never mixes the two. `--amount-max` is the larger single-scheme amount.
- Privacy Pools paymaster unshields pass a wallet delegation path (`--next`, a stored public HD account, or a stored stealth account), the same way Tornado does. The stealth sentinel path stays in the keystore for both protocols.
- Railgun, Tornado, and Privacy Pools proving circuits install with the CLI via the `kohaku-artifacts` package. Prove and unshield read that package and do not download circuits. `fetch-artifacts` is removed.
- `--next` and private-transfer skip a public HD index that already has a nonce, balance, or code. That index is saved in the wallet and the cursor advances. The unused account is still persisted only after a successful broadcast. `balances` checks the next two unstored indexes the same way and includes any it saves.

## [0.0.9] - 2026-10-19

### Added

- `KOHAKU_RAILGUN_FORCE_VALID_POI=1` rewrites PPOI `Missing` statuses to `Valid` in the fetch layer so a Railgun note whose POI submit never landed can still be spent. Off by default. The contract does not consult PPOI; this only lifts the client-side filter.

### Changed

- `@kohaku-eth/privacy-pools` `0.1.0-alpha.26` (faster proving). The plugin keeps the legacy BIP-32 `SecretManager`. The SDK's signature-derived secrets are not used, so existing notes stay spendable.

## [0.0.8] — 2026-10-15

### Added

- `private-transfer` unshields through a fresh public account and tail-calls an exact ETH or token transfer to `--to` on Tornado, Railgun, and Privacy Pools. Tornado unshields the smallest set of notes that covers the transfer plus the paymaster fee (a 0.1 ETH transfer from 0.1 notes unshields 0.2) and leaves the remainder on the fresh account. Railgun and Privacy Pools unshield the exact transfer amount, with fees taken from the private balance. Privacy Pools uses the fresh account as the EIP-7702 delegate and refund recipient, so unused-gas change does not go to `--to`.
- Privacy Pools circuit downloads (`raw.githubusercontent.com/.../packages/circuits/...`) are rewritten to `<KOHAKU_ARTIFACTS_BASE_URL>/privacy-pools/` and cached under `proving-artifacts`, same as Railgun and Tornado. Pre-warm with `fetch-artifacts --privacy-pools`.

## [0.0.7] — 2026-10-14

### Changed

- Privacy Pools unshield is an ERC-4337 paymaster user operation. The typed amount is the net the recipient receives; the paymaster fee is paid from the private balance. Approved notes are spent largest first, and further notes run as execution-phase withdrawals. `--tail-calls` and multi-note withdrawals use `--to` as the EIP-7702 account (`--next`, a stored public HD account, or a stored stealth account). That account runs the tail calls and keeps any change. A custom `--to` is only allowed for a single-note unshield with no `--tail-calls`. Sepolia unshield fails until a paymaster adapter is configured; shield and `balances` still work there. Withdrawals are no longer sent through fastrelay.
- Privacy Pools shield accepts any asset the entrypoint has a pool for, rejects deposits below that pool's minimum, and shows the vetting fee in the shield preview.
- `@kohaku-eth/privacy-pools` `0.0.2-alpha.24`, `@kohaku-eth/tornado-cash` `0.0.2-alpha.25`, `@kohaku-eth/plugins` `0.0.1-alpha.17`.
- Privacy Pools mainnet sync reads history from the saga CDN and uses `eth_getLogs` only for the tip past that coverage. The bundled mainnet state snapshot is no longer seeded. Sepolia has no Privacy Pools saga stream, so it keeps the bundled snapshot and syncs the tip from logs.

## [0.0.6] — 2026-10-06

### Added

- add `list-wallets --format json-v1`, an opt-in versioned discovery schema with network, numeric chain ID, and CAIP-2 chain ID. The existing `--non-interactive` JSON shape remains unchanged.
- add explicit `--password-file` support to every command that unlocks a wallet, and `--mnemonic-file` to `create-wallet --import`. These POSIX inputs are mutually exclusive with their literal counterparts and require owner-only, regular, non-symlink files; they fail closed on Windows where ACLs are not validated.

### Changed

- Public Ethereum RPC client (`makePublicClient`) uses viem HTTP JSON-RPC batching by default, so concurrent reads share HTTP round-trips against any compliant node.
- Public Ethereum RPC HTTP timeout raised from viem's default 10s to 180s so large batched POSTs (e.g. `balances` against slow PIR RPC) do not abort mid-batch.
- `balances` loads public ETH + ERC-20 balances (and unknown token meta) concurrently so independent state reads pack into batched JSON-RPC POSTs.

### Fixed

- `transact-raw --from` now accepts stealth selectors (`s0` / `stealth:0`) like `shield` and `transfer` do. It previously sent them to ENS/GNS/WNS resolution and failed with `"s0" is not a valid Ethereum address`, even though the sender resolver behind it already supported them.

## [0.0.5] — 2026-08-29

### Added

- add `--skip-sim` flag on `shield` dry-runs so counterfactual (unfunded) senders still print call payloads. Cannot be combined with `--broadcast` (we always do simulation on broadcast).
- add `--amount-max` flag on `shield`: spend the account's maximum (ETH minus estimated gas; ERC-20 full balance).
- Default Sepolia token list includes DAI (`0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357`).

### Changed

- Privacy-protocol sync progress logs: omit confusing request counts (timer + phase only). Stealth scan now shows `scanned/total` blocks on the progress log.

### Fixed

- fix `balances --verbose` to no longer sync privacy protocols twice unnecessarily.
- `shield` and `unshield` keep a live progress timer during protocol sync (including Railgun WASM), matching `balances`.
- the `--from` flag on `shield` correctly supports `<stealth address>` or `sN` (stealth address by index)

## [0.0.4] — 2026-08-25

### Added

- `fetch-sync-cache` command to prefetch the public sync snapshot (Railgun Subsquid and Tornado saga HTTP pages) so later `balances` / `shield` / `unshield` syncs can start from disk instead of the network.
- `--tail-calls` on ERC-20 (non-ETH) unshields for Tornado and Railgun.
- `--tail-calls` when unshielding to a stored stealth address (`sN`).

### Changed

- Protocol syncs are substantially faster, using the public-sync cache and tighter log-range work.
- Sync progress is much easier to follow: live spinner updates and clearer logs during first-time and catch-up syncs.

### Fixed

- Unshielding to a custom / ephemeral recipient (`--to` an address that is not a stored HD account) no longer fails or mis-routes funds.
