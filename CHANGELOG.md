# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.0.5] — 2026-08-29

### Added

- `--skip-sim` on `shield` dry-runs so counterfactual (unfunded) senders still print call payloads. Cannot be combined with `--broadcast`. `--non-interactive` JSON schema is unchanged; `fees` are zeroed.
- `--amount-max` on `shield`: spend the account's maximum (ETH minus estimated gas; ERC-20 full balance). Tornado amounts are floored to the smallest pool denomination, then refined if gas would push the deposit below a step.

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
