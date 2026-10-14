//! Batch-aware Tor + PIR privacy orchestrator for Alloy JSON-RPC.
//!
//! # TorPIRProvider
//!
//! There is no combinatorial `HeliosTorPIRProvider` type matrix. Compose via
//! [`PrivacyBuilder`]:
//!
//! ```rust,ignore
//! let provider = PrivacyBuilder::new(rpc_url)?
//!     .tor(tor)
//!     .pir_over_tor(accounts_pir_url, Some(token_pir_url), datasets)
//!     .connect()
//!     .await?;
//! ```
//!
//! All egress (PIR HTTP and fallback Ethereum RPC) goes through Tor. Prefer PIR
//! when the allowlist matches; otherwise send plaintext JSON-RPC over Tor with
//! selective circuit isolation so different EOAs stay unlinkable. Fallback
//! `eth_call` / `eth_getBalance` are packed into Multicall3 per circuit.
//!
#![doc = include_str!("../README.md")]
#![cfg_attr(docsrs, feature(doc_auto_cfg))]

mod async_lookup;
mod builder;
mod error;
mod isolation;
mod multicall;
mod tor_rpc;
mod transport;
mod verifier;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;

pub use async_lookup::{
    AsyncLookupBackend, CachingAsyncLookup, DEFAULT_PIR_CACHE_TTL, SyncLookupAdapter, TorPirLookup,
};
pub use builder::{PrivacyBuilder, connect_tor_pir, sync_pir_lookup};
pub use error::PrivacyError;
pub use isolation::{CircuitChoice, DefaultIsolationPolicy, IsolationPolicy};
pub use tor_rpc::{LiveTorRpc, TorRpcBackend};
pub use transport::{PrivacyConnect, PrivacyTransport};
pub use verifier::StateVerifier;
