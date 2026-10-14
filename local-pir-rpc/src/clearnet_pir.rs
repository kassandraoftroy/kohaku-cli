//! Clearnet (no Tor) PIR client pool using inspire `pir-client`.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};

use kohaku_pir_rpc::{LookupBackend, PirProviderError};
use pir_client::PirClient;

/// How keys are interpreted before hitting the PIR server.
#[derive(Clone, Copy, Debug)]
pub enum KeyMode {
    /// 20-byte EOAs: apply the server's account `key_derivation`.
    Account,
    /// Pre-derived storage keys: pass through to `lookup` unchanged.
    Storage,
    /// Primary names, keyed by the address on a `content = names` server.
    Names,
}

/// Sync pool of clearnet [`PirClient`]s for concurrent `LookupBackend` calls.
pub struct ClearnetPirLookup {
    idle: Mutex<VecDeque<PirClient>>,
    available: Condvar,
    pool_size: usize,
    key_mode: KeyMode,
}

impl ClearnetPirLookup {
    /// Connect once, clone into a pool of `pool_size` account-mode clients.
    ///
    /// # Errors
    ///
    /// Returns when the PIR server is unreachable or `pool_size` is zero.
    #[allow(dead_code)]
    pub fn connect(base: &str, pool_size: usize) -> Result<Arc<Self>, String> {
        Self::connect_with_mode(base, pool_size, KeyMode::Account)
    }

    /// Like [`connect`](Self::connect) with an explicit [`KeyMode`].
    ///
    /// # Errors
    ///
    /// Returns when the PIR server is unreachable or `pool_size` is zero.
    pub fn connect_with_mode(
        base: &str,
        pool_size: usize,
        key_mode: KeyMode,
    ) -> Result<Arc<Self>, String> {
        if pool_size == 0 {
            return Err("pir pool size must be >= 1".into());
        }
        let prototype = PirClient::connect(base)?;
        match key_mode {
            KeyMode::Names if prototype.manifest.cuckoo.content != "names" => {
                return Err(format!(
                    "expected a names PIR server at {base}, manifest content is {:?}",
                    prototype.manifest.cuckoo.content
                ));
            }
            KeyMode::Account if !prototype.manifest.cuckoo.content.is_empty() => {
                return Err(format!(
                    "expected an account PIR server at {base}, manifest content is {:?}",
                    prototype.manifest.cuckoo.content
                ));
            }
            _ => {}
        }
        // PirClient is not Clone; reconnect for each pool member (same clearnet base).
        let mut clients = Vec::with_capacity(pool_size);
        clients.push(prototype);
        for _ in 1..pool_size {
            clients.push(PirClient::connect(base)?);
        }
        Ok(Arc::new(Self {
            idle: Mutex::new(VecDeque::from(clients)),
            available: Condvar::new(),
            pool_size,
            key_mode,
        }))
    }

    #[must_use]
    pub const fn pool_size(&self) -> usize {
        self.pool_size
    }

    fn with_client<R>(&self, f: impl FnOnce(&mut PirClient) -> R) -> R {
        let mut idle = self.idle.lock().unwrap_or_else(|e| e.into_inner());
        while idle.is_empty() {
            idle = self.available.wait(idle).unwrap_or_else(|e| e.into_inner());
        }
        let mut client = idle.pop_front().expect("non-empty after wait");
        drop(idle);
        let out = f(&mut client);
        self.idle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push_back(client);
        self.available.notify_one();
        out
    }

    fn lookup_key(&self, key: &[u8]) -> Result<Option<Vec<u8>>, PirProviderError> {
        self.with_client(|client| {
            let result = match self.key_mode {
                KeyMode::Account => {
                    if key.len() == 20 {
                        client.lookup_address(key)
                    } else {
                        client.lookup(key)
                    }
                }
                KeyMode::Storage => client.lookup(key),
                KeyMode::Names => {
                    if client.manifest.cuckoo.content != "names" {
                        Err("this server does not hold primary names".into())
                    } else {
                        let derived = client
                            .manifest
                            .cuckoo
                            .key_derivation
                            .key(key, client.manifest.cuckoo.key_size);
                        client.lookup(&derived)
                    }
                }
            };
            result
                .map(|found| found.map(|l| l.value))
                .map_err(PirProviderError::Client)
        })
    }

    fn lookup_name(
        &self,
        key: &[u8],
    ) -> Result<(Option<Vec<u8>>, kohaku_pir_rpc::StealthBroadcast), PirProviderError> {
        self.with_client(|client| {
            if client.manifest.cuckoo.content != "names" {
                return Err(PirProviderError::Client(
                    "this server does not hold primary names".into(),
                ));
            }
            let derived = client
                .manifest
                .cuckoo
                .key_derivation
                .key(key, client.manifest.cuckoo.key_size);
            let found = client.lookup(&derived).map_err(PirProviderError::Client)?;
            let stealth = crate::stealth::broadcast_from_lists(
                &client.stealth_registry,
                &client.stealth_texts,
            )
            .map_err(PirProviderError::Client)?;
            Ok((found.map(|lookup| lookup.value), stealth))
        })
    }
}

impl LookupBackend for ClearnetPirLookup {
    fn lookup(&self, key: &[u8]) -> Result<Option<Vec<u8>>, PirProviderError> {
        self.lookup_key(key)
    }

    fn lookup_names_batch(
        &self,
        keys: &[Vec<u8>],
    ) -> Result<kohaku_pir_rpc::NamesLookupBatch, PirProviderError> {
        if keys.is_empty() || !matches!(self.key_mode, KeyMode::Names) {
            return Ok(kohaku_pir_rpc::NamesLookupBatch {
                values: self.lookup_batch(keys)?,
                stealth: None,
            });
        }
        std::thread::scope(|s| {
            let handles: Vec<_> = keys
                .iter()
                .map(|key| s.spawn(|| self.lookup_name(key)))
                .collect();
            let mut values = Vec::with_capacity(keys.len());
            let mut stealth = None;
            for handle in handles {
                let (value, broadcast) = handle.join().expect("lookup worker panicked")?;
                stealth = Some(broadcast);
                values.push(value);
            }
            Ok(kohaku_pir_rpc::NamesLookupBatch { values, stealth })
        })
    }

    fn lookup_batch(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>, PirProviderError> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        // Parallel clearnet lookups; pool caps concurrency.
        std::thread::scope(|s| {
            let handles: Vec<_> = keys
                .iter()
                .map(|key| s.spawn(|| self.lookup_key(key)))
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().expect("lookup worker panicked"))
                .collect()
        })
    }
}
