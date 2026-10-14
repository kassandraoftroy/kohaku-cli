use std::{
    collections::HashMap,
    sync::{Mutex, PoisonError},
};

use crate::PirProviderError;

/// One ERC-6538 registration from a names-lookup sidecar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StealthEntry {
    /// Registrant address.
    pub registrant: [u8; 20],
    /// Scheme id (`1` is secp256k1).
    pub scheme_id: u64,
    /// Registered meta-address bytes.
    pub meta: Vec<u8>,
}

/// One `stealth-address-scheme-1` text record from a names-lookup sidecar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StealthText {
    /// Namehash of the name (also the GNS / WNS token id).
    pub node: [u8; 32],
    /// Record value.
    pub value: String,
}

/// Registry and stealth text records attached to a names lookup.
///
/// Every names response carries the same lists. They are not PIR values.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StealthBroadcast {
    /// Whole ERC-6538 registry.
    pub registry: Vec<StealthEntry>,
    /// Every set `stealth-address-scheme-1` record.
    pub texts: Vec<StealthText>,
}

/// Values from a names-lane batch, plus the sidecar from the client that ran it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NamesLookupBatch {
    /// One entry per key, in request order.
    pub values: Vec<Option<Vec<u8>>>,
    /// Sidecar from this batch. `None` when the backend did not parse one.
    pub stealth: Option<StealthBroadcast>,
}

/// Blocking key lookup used by the router (wrapped in `spawn_blocking`).
///
/// Live PIR is a `LookupBackend` you provide (typically wrapping
/// `pir_client::PirClient` from inspire-gpu-serving). This crate does not
/// depend on that repo, so kohaku-rs CI stays self-contained.
pub trait LookupBackend: Send + Sync {
    /// Return the raw value bytes for `key`, or `None` if the key is absent.
    ///
    /// # Errors
    ///
    /// Returns [`PirProviderError::Client`] when the lookup fails.
    fn lookup(&self, key: &[u8]) -> Result<Option<Vec<u8>>, PirProviderError>;

    /// Look up many keys. Default loops [`lookup`](Self::lookup); backends that
    /// can amortize round-trips should override this.
    ///
    /// # Errors
    ///
    /// Returns [`PirProviderError::Client`] when the batch lookup fails.
    fn lookup_batch(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>, PirProviderError> {
        keys.iter().map(|k| self.lookup(k)).collect()
    }

    /// Names-lane batch. Default ignores the sidecar.
    ///
    /// Backends that talk to a names server should override this and return the
    /// stealth registry and text list from the client that served the lookup.
    ///
    /// # Errors
    ///
    /// Returns [`PirProviderError::Client`] when the batch lookup fails.
    fn lookup_names_batch(&self, keys: &[Vec<u8>]) -> Result<NamesLookupBatch, PirProviderError> {
        Ok(NamesLookupBatch {
            values: self.lookup_batch(keys)?,
            stealth: None,
        })
    }
}

/// In-memory lookup for tests.
#[derive(Default)]
pub struct MapLookup {
    /// Raw PIR key → value bytes.
    pub entries: Mutex<HashMap<Vec<u8>, Vec<u8>>>,
    /// Sidecar returned by [`LookupBackend::lookup_names_batch`].
    pub stealth: Mutex<Option<StealthBroadcast>>,
}

impl MapLookup {
    /// Insert a key/value pair.
    pub fn insert(&self, key: impl AsRef<[u8]>, value: impl AsRef<[u8]>) {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key.as_ref().to_vec(), value.as_ref().to_vec());
    }
}

impl LookupBackend for MapLookup {
    fn lookup(&self, key: &[u8]) -> Result<Option<Vec<u8>>, PirProviderError> {
        Ok(self
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(key)
            .cloned())
    }

    fn lookup_names_batch(&self, keys: &[Vec<u8>]) -> Result<NamesLookupBatch, PirProviderError> {
        Ok(NamesLookupBatch {
            values: self.lookup_batch(keys)?,
            stealth: self
                .stealth
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone(),
        })
    }
}
