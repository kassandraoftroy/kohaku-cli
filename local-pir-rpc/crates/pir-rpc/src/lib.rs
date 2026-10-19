//! Hybrid Ethereum JSON-RPC provider: PIR for private account reads, fallback
//! RPC for everything else.

#![doc = include_str!("../README.md")]
#![cfg_attr(docsrs, feature(doc_auto_cfg))]

mod dataset;
mod error;
mod fallback;
mod lookup;
mod names;
mod plan;
mod router;
mod routes;
mod tokens;
mod transport;

pub use dataset::DatasetManifest;
pub use error::PirProviderError;
pub use fallback::{FallbackRpc, HttpFallback, MapFallback};
pub use lookup::{
    LookupBackend, MapLookup, NamesLookupBatch, StealthBroadcast, StealthEntry, StealthText,
};
pub use names::{ClassifiedName, NameForward, NameSystem};
pub use plan::{CallPath, CallTrace, Decoded, PirDecode, PirLane, PirOp, PlannedOp};
pub use router::{PirRouter, decode_pir, dedupe_keys};
pub use routes::{
    CallMatch, Route, RouteTable, TokenBalanceMatch, balance_of_data_hex, token_balance_op,
};
pub use tokens::{BALANCE_OF_SELECTOR, PIR_TOKENS, PirToken, pir_token_by_contract};
pub use transport::{PirConnect, PirTransport, connect_provider};
