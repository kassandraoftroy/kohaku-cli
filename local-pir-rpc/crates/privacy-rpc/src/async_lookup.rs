use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use kohaku_pir_rpc::{LookupBackend, NamesLookupBatch, PirProviderError, StealthBroadcast};
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tracing::{debug, info};
use url::Url;

use crate::TorRpcBackend;

/// Async PIR key lookup used by the privacy orchestrator.
///
/// Unlike [`LookupBackend`] (sync / `spawn_blocking`), this is async so Tor HTTP
/// can drive the PIR server without blocking the runtime.
#[async_trait]
pub trait AsyncLookupBackend: Send + Sync {
    /// Look up many PIR keys (order-preserving).
    async fn lookup_batch(
        &self,
        keys: &[Vec<u8>],
    ) -> Result<Vec<Option<Vec<u8>>>, PirProviderError>;

    /// Names-lane batch. Default drops the sidecar.
    async fn lookup_names_batch(
        &self,
        keys: &[Vec<u8>],
    ) -> Result<NamesLookupBatch, PirProviderError> {
        Ok(NamesLookupBatch {
            values: self.lookup_batch(keys).await?,
            stealth: None,
        })
    }
}

/// Default TTL for cached PIR values (covers a sequential balances scan).
pub const DEFAULT_PIR_CACHE_TTL: Duration = Duration::from_secs(60);

/// Caches PIR results so four-token padding is not re-fetched on every sequential
/// `balanceOf` HTTP request for the same holder.
pub struct CachingAsyncLookup {
    inner: Arc<dyn AsyncLookupBackend>,
    ttl: Duration,
    entries: Mutex<HashMap<Vec<u8>, (Instant, Option<Vec<u8>>)>>,
    /// Sidecar from the last names fetch, reused on a full cache hit.
    stealth: Mutex<Option<StealthBroadcast>>,
}

impl CachingAsyncLookup {
    /// Wrap `inner` with a TTL cache.
    #[must_use]
    pub fn new(inner: Arc<dyn AsyncLookupBackend>, ttl: Duration) -> Self {
        Self {
            inner,
            ttl,
            entries: Mutex::new(HashMap::new()),
            stealth: Mutex::new(None),
        }
    }

    /// Wrap with [`DEFAULT_PIR_CACHE_TTL`].
    #[must_use]
    pub fn with_default_ttl(inner: Arc<dyn AsyncLookupBackend>) -> Arc<Self> {
        info!(
            ttl_secs = DEFAULT_PIR_CACHE_TTL.as_secs(),
            "PIR result cache enabled"
        );
        Arc::new(Self::new(inner, DEFAULT_PIR_CACHE_TTL))
    }
}

#[async_trait]
impl AsyncLookupBackend for CachingAsyncLookup {
    async fn lookup_batch(
        &self,
        keys: &[Vec<u8>],
    ) -> Result<Vec<Option<Vec<u8>>>, PirProviderError> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let now = Instant::now();
        let mut cached: Vec<Option<Option<Vec<u8>>>> = vec![None; keys.len()];
        let mut miss_keys = Vec::new();
        let mut miss_at = Vec::new();

        {
            let mut map = self.entries.lock().await;
            map.retain(|_, (t, _)| now.duration_since(*t) < self.ttl);
            for (i, key) in keys.iter().enumerate() {
                if let Some((_, v)) = map.get(key) {
                    cached[i] = Some(v.clone());
                } else {
                    miss_at.push(i);
                    miss_keys.push(key.clone());
                }
            }
        }

        let hits = keys.len() - miss_keys.len();
        if !miss_keys.is_empty() {
            info!(hits, misses = miss_keys.len(), "PIR cache: fetching misses");
            let fetched = self.inner.lookup_batch(&miss_keys).await?;
            let mut map = self.entries.lock().await;
            for (j, idx) in miss_at.into_iter().enumerate() {
                let value = fetched[j].clone();
                map.insert(miss_keys[j].clone(), (now, value.clone()));
                cached[idx] = Some(value);
            }
        } else {
            // Includes cached PIR-absent (`None`) entries from an earlier pad.
            info!(hits, "PIR cache: all hits");
        }

        let out: Vec<Option<Vec<u8>>> = cached
            .into_iter()
            .map(|slot| slot.expect("filled"))
            .collect();
        let pir_absent = out.iter().filter(|v| v.is_none()).count();
        if pir_absent > 0 {
            debug!(
                pir_absent,
                total = out.len(),
                "PIR values absent in this batch (will encode as zero)"
            );
        }
        Ok(out)
    }

    async fn lookup_names_batch(
        &self,
        keys: &[Vec<u8>],
    ) -> Result<NamesLookupBatch, PirProviderError> {
        if keys.is_empty() {
            return Ok(NamesLookupBatch::default());
        }
        let now = Instant::now();
        let mut cached: Vec<Option<Option<Vec<u8>>>> = vec![None; keys.len()];
        let mut miss_keys = Vec::new();
        let mut miss_at = Vec::new();
        {
            let mut map = self.entries.lock().await;
            map.retain(|_, (t, _)| now.duration_since(*t) < self.ttl);
            for (i, key) in keys.iter().enumerate() {
                if let Some((_, v)) = map.get(key) {
                    cached[i] = Some(v.clone());
                } else {
                    miss_at.push(i);
                    miss_keys.push(key.clone());
                }
            }
        }
        let stealth = if miss_keys.is_empty() {
            self.stealth.lock().await.clone()
        } else {
            let fetched = self.inner.lookup_names_batch(&miss_keys).await?;
            if fetched.stealth.is_some() {
                *self.stealth.lock().await = fetched.stealth.clone();
            }
            let mut map = self.entries.lock().await;
            for (j, idx) in miss_at.into_iter().enumerate() {
                let value = fetched.values[j].clone();
                map.insert(miss_keys[j].clone(), (now, value.clone()));
                cached[idx] = Some(value);
            }
            self.stealth.lock().await.clone()
        };
        let values = cached
            .into_iter()
            .map(|slot| slot.expect("filled"))
            .collect();
        Ok(NamesLookupBatch { values, stealth })
    }
}

/// Bridge a sync [`LookupBackend`] into [`AsyncLookupBackend`] via `spawn_blocking`.
///
/// Useful for in-memory tests (`MapLookup`). Does **not** send traffic over Tor.
pub struct SyncLookupAdapter {
    inner: Arc<dyn LookupBackend>,
}

impl SyncLookupAdapter {
    /// Wrap a sync lookup backend.
    #[must_use]
    pub fn new(inner: Arc<dyn LookupBackend>) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl AsyncLookupBackend for SyncLookupAdapter {
    async fn lookup_batch(
        &self,
        keys: &[Vec<u8>],
    ) -> Result<Vec<Option<Vec<u8>>>, PirProviderError> {
        let inner = Arc::clone(&self.inner);
        let keys = keys.to_vec();
        tokio::task::spawn_blocking(move || inner.lookup_batch(&keys)).await?
    }

    async fn lookup_names_batch(
        &self,
        keys: &[Vec<u8>],
    ) -> Result<NamesLookupBatch, PirProviderError> {
        let inner = Arc::clone(&self.inner);
        let keys = keys.to_vec();
        tokio::task::spawn_blocking(move || inner.lookup_names_batch(&keys)).await?
    }
}

/// PIR lookups over **shared** Tor HTTP (no circuit isolation).
///
/// Posts a JSON batch to `{pir_base}/lookup`:
///
/// ```json
/// {"keys":["0x…","0x…"]}
/// ```
///
/// Expects:
///
/// ```json
/// {"values":[null,"0x…"]}
/// ```
///
/// This is the Tor underlay seam for PIR. Production wallets should replace the
/// body codec with inspire-gpu-serving `pir-client` crypto while keeping Tor as
/// the HTTP transport (`http_post` / shared circuits only).
pub struct TorPirLookup {
    tor: Arc<dyn TorRpcBackend>,
    lookup_url: Url,
}

impl TorPirLookup {
    /// Build a lookup client targeting `pir_base` (e.g. `https://pir.example`).
    ///
    /// # Errors
    ///
    /// Returns when `pir_base` is not a valid URL.
    pub fn new(tor: Arc<dyn TorRpcBackend>, pir_base: &str) -> Result<Self, crate::PrivacyError> {
        let mut lookup_url =
            Url::parse(pir_base).map_err(|e| crate::PrivacyError::InvalidUrl(e.to_string()))?;
        let path = lookup_url.path().trim_end_matches('/');
        let path = if path.is_empty() || path == "/" {
            "/lookup".to_string()
        } else {
            format!("{path}/lookup")
        };
        lookup_url.set_path(&path);
        Ok(Self { tor, lookup_url })
    }

    /// Endpoint used for batch lookups (including `/lookup`).
    #[must_use]
    pub const fn lookup_url(&self) -> &Url {
        &self.lookup_url
    }
}

#[async_trait]
impl AsyncLookupBackend for TorPirLookup {
    async fn lookup_batch(
        &self,
        keys: &[Vec<u8>],
    ) -> Result<Vec<Option<Vec<u8>>>, PirProviderError> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let body = json!({
            "keys": keys.iter().map(|k| format!("0x{}", hex::encode(k))).collect::<Vec<_>>(),
        });
        let bytes =
            serde_json::to_vec(&body).map_err(|e| PirProviderError::Client(e.to_string()))?;
        let headers = vec![("content-type".into(), "application/json".into())];
        let resp = self
            .tor
            .http_post(&self.lookup_url, &headers, &bytes)
            .await
            .map_err(PirProviderError::Client)?;
        parse_lookup_response(&resp, keys.len())
    }
}

fn parse_lookup_response(
    body: &[u8],
    expected: usize,
) -> Result<Vec<Option<Vec<u8>>>, PirProviderError> {
    let value: Value =
        serde_json::from_slice(body).map_err(|e| PirProviderError::Client(e.to_string()))?;
    let values = value
        .get("values")
        .and_then(Value::as_array)
        .ok_or_else(|| PirProviderError::Client("PIR response missing values[]".into()))?;
    if values.len() != expected {
        return Err(PirProviderError::Client(format!(
            "PIR response length {} != request length {expected}",
            values.len()
        )));
    }
    values
        .iter()
        .map(|v| match v {
            Value::Null => Ok(None),
            Value::String(s) => {
                let raw = s
                    .strip_prefix("0x")
                    .or_else(|| s.strip_prefix("0X"))
                    .unwrap_or(s);
                let bytes = hex::decode(raw)
                    .map_err(|e| PirProviderError::Client(format!("PIR value hex: {e}")))?;
                Ok(Some(bytes))
            }
            other => Err(PirProviderError::Client(format!(
                "PIR value must be hex string or null, got {other}"
            ))),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use kohaku_pir_rpc::MapLookup;

    use super::*;

    #[test]
    fn lookup_url_appends_path() {
        let tor: Arc<dyn TorRpcBackend> = Arc::new(crate::mock::MockTorRpc::default());
        let lookup = TorPirLookup::new(tor, "https://pir.example").unwrap();
        assert_eq!(lookup.lookup_url().as_str(), "https://pir.example/lookup");
    }

    #[test]
    fn parses_batch_response() {
        let body = br#"{"values":[null,"0x0102"]}"#;
        let out = parse_lookup_response(body, 2).unwrap();
        assert_eq!(out[0], None);
        assert_eq!(out[1], Some(vec![1, 2]));
    }

    struct CountingLookup {
        inner: SyncLookupAdapter,
        hits: AtomicUsize,
    }

    #[async_trait]
    impl AsyncLookupBackend for CountingLookup {
        async fn lookup_batch(
            &self,
            keys: &[Vec<u8>],
        ) -> Result<Vec<Option<Vec<u8>>>, PirProviderError> {
            self.hits.fetch_add(keys.len(), Ordering::SeqCst);
            self.inner.lookup_batch(keys).await
        }
    }

    #[tokio::test]
    async fn cache_avoids_repeat_fetches() {
        let map = MapLookup::default();
        map.insert([1u8; 20], vec![9]);
        let counting = Arc::new(CountingLookup {
            inner: SyncLookupAdapter::new(Arc::new(map)),
            hits: AtomicUsize::new(0),
        });
        let cached = CachingAsyncLookup::new(counting.clone(), Duration::from_secs(60));
        let key = vec![1u8; 20];
        let a = cached
            .lookup_batch(std::slice::from_ref(&key))
            .await
            .unwrap();
        let b = cached
            .lookup_batch(std::slice::from_ref(&key))
            .await
            .unwrap();
        assert_eq!(a, b);
        assert_eq!(counting.hits.load(Ordering::SeqCst), 1);
    }
}
