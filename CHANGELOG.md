# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.0.6] — 2026-10-06

### Added

- add `list-wallets --format json-v1`, an opt-in versioned discovery schema with network, numeric chain ID, and CAIP-2 chain ID. The existing `--non-interactive` JSON shape remains unchanged.
- add explicit `--password-file` support to every command that unlocks a wallet, and `--mnemonic-file` to `create-wallet --import`. These POSIX inputs are mutually exclusive with their literal counterparts and require owner-only, regular, non-symlink files; they fail closed on Windows where ACLs are not validated.

### Changed

- Public Ethereum RPC client (`makePublicClient`) uses viem HTTP JSON-RPC batching by default, so concurrent reads share HTTP round-trips against any compliant node.
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
