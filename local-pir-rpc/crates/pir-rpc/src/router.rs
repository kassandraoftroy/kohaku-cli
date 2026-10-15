use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use serde_json::Value;
use tracing::debug;

use crate::{
    CallPath, DatasetManifest, Decoded, FallbackRpc, LookupBackend, MapFallback, MapLookup,
    PirDecode, PirLane, PirOp, PirProviderError, PlannedOp, Route, RouteTable,
    lookup::StealthBroadcast,
    names::{
        RememberedName, decode_name_reverse, encode_forward, encode_namehash_result,
        encode_stealth_meta_result, encode_stealth_text_result, namehash,
    },
    routes::{encode_bytes, encode_qty, encode_uint256, encode_zero, parse_address_param},
    tokens::parse_storage_value,
};

/// How long a served primary name is remembered for the follow-up forward check.
const NAME_CACHE_TTL: Duration = Duration::from_mins(1);

struct CachedAddress {
    address: [u8; 20],
    at: Instant,
}

struct NameCache {
    /// `(system byte, namehash)` → address.
    by_hash: HashMap<(u8, [u8; 32]), CachedAddress>,
    /// Lowercased ENS name → address.
    by_ens_name: HashMap<String, CachedAddress>,
}

impl NameCache {
    fn new() -> Self {
        Self {
            by_hash: HashMap::new(),
            by_ens_name: HashMap::new(),
        }
    }

    fn prune(&mut self, now: Instant) {
        self.by_hash
            .retain(|_, entry| now.duration_since(entry.at) < NAME_CACHE_TTL);
        self.by_ens_name
            .retain(|_, entry| now.duration_since(entry.at) < NAME_CACHE_TTL);
    }
}

/// Hybrid router: PIR allowlist + JSON-RPC fallback.
pub struct PirRouter {
    /// Account-table PIR backend.
    lookup: Arc<dyn LookupBackend>,
    /// Optional token-storage PIR backend.
    tokens_lookup: Option<Arc<dyn LookupBackend>>,
    /// Optional primary-name PIR backend.
    names_lookup: Option<Arc<dyn LookupBackend>>,
    fallback: Arc<dyn FallbackRpc>,
    routes: RouteTable,
    /// Names returned from PIR, so the next forward `eth_call` stays off the RPC.
    name_cache: Mutex<NameCache>,
    /// ERC-6538 registry and stealth text records from the last names lookup.
    stealth_cache: Mutex<Option<StealthSnapshot>>,
}

struct StealthSnapshot {
    broadcast: StealthBroadcast,
    at: Instant,
}

impl PirRouter {
    /// Wrap a lookup backend with HTTP JSON-RPC fallback.
    ///
    /// `lookup` is how PIR bytes are fetched (remote `pir-client` wrapper, or
    /// a test map). `rpc_url` is the ordinary Ethereum node.
    ///
    /// # Errors
    ///
    /// Returns [`PirProviderError::InvalidUrl`] if `rpc_url` is not a valid HTTP URL.
    pub fn with_rpc(
        lookup: Arc<dyn LookupBackend>,
        rpc_url: &str,
        datasets: Vec<DatasetManifest>,
    ) -> Result<Self, PirProviderError> {
        Self::with_rpc_dual(lookup, None, rpc_url, datasets)
    }

    /// Like [`with_rpc`](Self::with_rpc) with a separate token-storage PIR backend.
    ///
    /// # Errors
    ///
    /// Returns [`PirProviderError::InvalidUrl`] if `rpc_url` is not a valid HTTP URL.
    pub fn with_rpc_dual(
        accounts: Arc<dyn LookupBackend>,
        tokens: Option<Arc<dyn LookupBackend>>,
        rpc_url: &str,
        datasets: Vec<DatasetManifest>,
    ) -> Result<Self, PirProviderError> {
        Ok(Self::from_parts_lanes(
            accounts,
            tokens,
            None,
            Arc::new(crate::HttpFallback::new(rpc_url)?),
            datasets,
        ))
    }

    /// Like [`with_rpc_dual`](Self::with_rpc_dual) plus a primary-name PIR backend.
    ///
    /// # Errors
    ///
    /// Returns [`PirProviderError::InvalidUrl`] if `rpc_url` is not a valid HTTP URL.
    pub fn with_rpc_lanes(
        accounts: Arc<dyn LookupBackend>,
        tokens: Option<Arc<dyn LookupBackend>>,
        names: Option<Arc<dyn LookupBackend>>,
        rpc_url: &str,
        datasets: Vec<DatasetManifest>,
    ) -> Result<Self, PirProviderError> {
        Ok(Self::from_parts_lanes(
            accounts,
            tokens,
            names,
            Arc::new(crate::HttpFallback::new(rpc_url)?),
            datasets,
        ))
    }

    /// Build a router from injected backends (tests, custom transports).
    #[must_use]
    pub fn from_parts(
        lookup: Arc<dyn LookupBackend>,
        fallback: Arc<dyn FallbackRpc>,
        datasets: Vec<DatasetManifest>,
    ) -> Self {
        Self::from_parts_dual(lookup, None, fallback, datasets)
    }

    /// Build a router with separate account and token PIR backends.
    #[must_use]
    pub fn from_parts_dual(
        lookup: Arc<dyn LookupBackend>,
        tokens_lookup: Option<Arc<dyn LookupBackend>>,
        fallback: Arc<dyn FallbackRpc>,
        datasets: Vec<DatasetManifest>,
    ) -> Self {
        Self::from_parts_lanes(lookup, tokens_lookup, None, fallback, datasets)
    }

    /// Build a router with account, token, and name PIR backends.
    #[must_use]
    pub fn from_parts_lanes(
        lookup: Arc<dyn LookupBackend>,
        tokens_lookup: Option<Arc<dyn LookupBackend>>,
        names_lookup: Option<Arc<dyn LookupBackend>>,
        fallback: Arc<dyn FallbackRpc>,
        datasets: Vec<DatasetManifest>,
    ) -> Self {
        Self {
            lookup,
            tokens_lookup,
            names_lookup,
            fallback,
            routes: RouteTable::from_datasets(datasets),
            name_cache: Mutex::new(NameCache::new()),
            stealth_cache: Mutex::new(None),
        }
    }

    /// Remember the stealth lists from a names lookup. `None` leaves the cache.
    pub fn store_stealth(&self, stealth: Option<StealthBroadcast>) {
        let Some(broadcast) = stealth else {
            return;
        };
        let mut cache = self
            .stealth_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *cache = Some(StealthSnapshot {
            broadcast,
            at: Instant::now(),
        });
    }

    fn fresh_stealth(&self) -> Option<StealthBroadcast> {
        let mut cache = self
            .stealth_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        match cache.as_ref() {
            Some(snapshot) if now.duration_since(snapshot.at) < NAME_CACHE_TTL => {
                Some(snapshot.broadcast.clone())
            }
            _ => {
                *cache = None;
                None
            }
        }
    }

    /// Convenience constructor for in-memory tests.
    #[must_use]
    pub fn mock(lookup: MapLookup, fallback: MapFallback, datasets: Vec<DatasetManifest>) -> Self {
        Self::from_parts(Arc::new(lookup), Arc::new(fallback), datasets)
    }

    /// Routing table used for this router.
    #[must_use]
    pub const fn routes(&self) -> &RouteTable {
        &self.routes
    }

    /// Classify one JSON-RPC method into a PIR op or fallback.
    ///
    /// # Errors
    ///
    /// Returns [`PirProviderError::InvalidParams`] when a PIR-routed method has
    /// a malformed address / key.
    pub fn plan_request(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<PlannedOp, PirProviderError> {
        let params = normalize_params(params);
        match self.routes.classify(method, &params) {
            Route::AccountBalance => {
                let key = parse_address_param(&params)?.to_vec();
                Ok(PlannedOp::Pir(PirOp {
                    lane: PirLane::Account,
                    key,
                    decode: PirDecode::AccountBalance,
                    holder: None,
                    token_index: None,
                }))
            }
            Route::AccountNonce => {
                let key = parse_address_param(&params)?.to_vec();
                Ok(PlannedOp::Pir(PirOp {
                    lane: PirLane::Account,
                    key,
                    decode: PirDecode::AccountNonce,
                    holder: None,
                    token_index: None,
                }))
            }
            Route::AccountCode => {
                let key = parse_address_param(&params)?.to_vec();
                Ok(PlannedOp::Pir(PirOp {
                    lane: PirLane::Account,
                    key,
                    decode: PirDecode::AccountCode,
                    holder: None,
                    token_index: None,
                }))
            }
            Route::NameReverse { system, address } => Ok(PlannedOp::Pir(PirOp {
                lane: PirLane::Names,
                key: address.to_vec(),
                decode: PirDecode::NameReverse { system },
                holder: None,
                token_index: None,
            })),
            Route::Namehash { name } => Ok(PlannedOp::Local(encode_namehash_result(&name))),
            Route::NameForward(forward) => {
                if let Some(address) = self.cached_forward(&forward) {
                    Ok(PlannedOp::Local(encode_forward(&forward, &address)))
                } else {
                    Ok(PlannedOp::Fallback)
                }
            }
            Route::StealthMeta {
                registrant,
                scheme_id,
            } => Ok(self.plan_stealth_meta(registrant, scheme_id)),
            Route::StealthText { system, node } => Ok(self.plan_stealth_text(system, node)),
            Route::TokenBalance(m) => {
                let token_index = crate::tokens::PIR_TOKENS
                    .iter()
                    .position(|t| t.symbol == m.token.symbol);
                Ok(PlannedOp::Pir(PirOp {
                    lane: PirLane::TokenStorage,
                    key: m.key,
                    decode: PirDecode::TokenBalance {
                        flag_in_top_bit: m.token.flag_in_top_bit,
                    },
                    holder: Some(m.holder),
                    token_index,
                }))
            }
            Route::Call(m) => Ok(PlannedOp::Pir(PirOp {
                lane: PirLane::Account,
                key: m.key,
                decode: PirDecode::Call {
                    value_encoding: m.value_encoding,
                },
                holder: None,
                token_index: None,
            })),
            Route::Fallback => Ok(PlannedOp::Fallback),
        }
    }

    /// Classify many requests (same order as input).
    pub fn plan_requests<S: AsRef<str>>(
        &self,
        items: &[(S, Value)],
    ) -> Vec<Result<PlannedOp, PirProviderError>> {
        items
            .iter()
            .map(|(method, params)| self.plan_request(method.as_ref(), params))
            .collect()
    }

    /// Execute PIR ops via one [`LookupBackend::lookup_batch`], then decode.
    ///
    /// Duplicate `(lane, key)` pairs share a single physical lookup.
    ///
    /// A PIR miss is **not** an error: account methods return `0x0`.
    ///
    /// # Errors
    ///
    /// Returns when the batch lookup worker fails. Per-item decode failures are
    /// returned inside the `Vec`.
    pub async fn execute_pir(
        &self,
        ops: &[PirOp],
    ) -> Result<Vec<Result<Decoded, PirProviderError>>, PirProviderError> {
        if ops.is_empty() {
            return Ok(Vec::new());
        }

        let mut account_ops = Vec::new();
        let mut token_ops = Vec::new();
        let mut name_ops = Vec::new();
        let mut account_idx = Vec::new();
        let mut token_idx = Vec::new();
        let mut name_idx = Vec::new();
        for (i, op) in ops.iter().enumerate() {
            match op.lane {
                PirLane::Account => {
                    account_idx.push(i);
                    account_ops.push(op.clone());
                }
                PirLane::TokenStorage => {
                    token_idx.push(i);
                    token_ops.push(op.clone());
                }
                PirLane::Names => {
                    name_idx.push(i);
                    name_ops.push(op.clone());
                }
            }
        }

        let account_values = self
            .lookup_lane_blocking(Arc::clone(&self.lookup), &account_ops)
            .await?;
        let token_values = if token_ops.is_empty() {
            Vec::new()
        } else {
            let tokens = self.tokens_lookup.as_ref().ok_or_else(|| {
                PirProviderError::Client(
                    "token PIR ops planned but no tokens lookup configured".into(),
                )
            })?;
            self.lookup_lane_blocking(Arc::clone(tokens), &token_ops)
                .await?
        };
        let name_values = if name_ops.is_empty() {
            Vec::new()
        } else {
            let names = self.names_lookup.as_ref().ok_or_else(|| {
                PirProviderError::Client(
                    "name PIR ops planned but no names lookup configured".into(),
                )
            })?;
            self.lookup_names_lane(Arc::clone(names), &name_ops).await?
        };

        let mut raw: Vec<Option<Vec<u8>>> = vec![None; ops.len()];
        for (j, &i) in account_idx.iter().enumerate() {
            raw[i] = account_values[j].clone();
        }
        for (j, &i) in token_idx.iter().enumerate() {
            raw[i] = token_values[j].clone();
        }
        for (j, &i) in name_idx.iter().enumerate() {
            raw[i] = name_values[j].clone();
        }

        Ok(ops
            .iter()
            .enumerate()
            .map(|(i, op)| self.decode_op(op, raw[i].as_deref()))
            .collect())
    }

    /// Dispatch one JSON-RPC method.
    ///
    /// # Errors
    ///
    /// Returns [`PirProviderError`] on PIR failure, invalid params, or fallback
    /// RPC/HTTP errors. A PIR miss is **not** an error: account methods return
    /// `0x0`.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, PirProviderError> {
        self.request_with_path(method, params)
            .await
            .map(|(value, _)| value)
    }

    /// Like [`request`](Self::request), also reporting whether the answer came
    /// from PIR, fallback RPC, or a local computation.
    ///
    /// # Errors
    ///
    /// Returns [`PirProviderError`] on PIR failure, invalid params, or fallback
    /// RPC/HTTP errors. A PIR miss is **not** an error: account methods return
    /// `0x0`.
    pub async fn request_with_path(
        &self,
        method: &str,
        params: Value,
    ) -> Result<(Value, CallPath), PirProviderError> {
        let params = normalize_params(&params);
        match self.plan_request(method, &params)? {
            PlannedOp::Local(value) => Ok((value, CallPath::Local)),
            PlannedOp::Fallback => {
                debug!(method, "fallback RPC");
                let value = self.fallback.request(method, params).await?;
                Ok((value, CallPath::Fallback))
            }
            PlannedOp::Pir(op)
                if (op.lane == PirLane::TokenStorage && self.tokens_lookup.is_none())
                    || (op.lane == PirLane::Names && self.names_lookup.is_none()) =>
            {
                debug!(method, ?op.lane, "PIR lane unavailable; fallback RPC");
                let value = self.fallback.request(method, params).await?;
                Ok((value, CallPath::Fallback))
            }
            PlannedOp::Pir(op) => {
                let mut out = self.execute_pir(std::slice::from_ref(&op)).await?;
                match out
                    .pop()
                    .unwrap_or_else(|| Ok(Decoded::Value(encode_qty(0))))?
                {
                    Decoded::Value(value) => Ok((value, CallPath::Pir)),
                    Decoded::NeedsFallback => {
                        debug!(method, "name did not fit; fallback RPC");
                        let value = self.fallback.request(method, params).await?;
                        Ok((value, CallPath::Fallback))
                    }
                }
            }
        }
    }

    async fn lookup_lane_blocking(
        &self,
        lookup: Arc<dyn LookupBackend>,
        ops: &[PirOp],
    ) -> Result<Vec<Option<Vec<u8>>>, PirProviderError> {
        if ops.is_empty() {
            return Ok(Vec::new());
        }
        let (unique_keys, remap) = dedupe_keys(ops);
        let values =
            tokio::task::spawn_blocking(move || lookup.lookup_batch(&unique_keys)).await??;
        Ok(remap.into_iter().map(|i| values[i].clone()).collect())
    }

    async fn lookup_names_lane(
        &self,
        lookup: Arc<dyn LookupBackend>,
        ops: &[PirOp],
    ) -> Result<Vec<Option<Vec<u8>>>, PirProviderError> {
        if ops.is_empty() {
            return Ok(Vec::new());
        }
        let (unique_keys, remap) = dedupe_keys(ops);
        let batch =
            tokio::task::spawn_blocking(move || lookup.lookup_names_batch(&unique_keys)).await??;
        self.store_stealth(batch.stealth);
        Ok(remap.into_iter().map(|i| batch.values[i].clone()).collect())
    }

    /// Decode one op and remember any real names for a later forward check.
    ///
    /// # Errors
    ///
    /// Returns [`PirProviderError::Client`] when the value bytes cannot be parsed.
    pub fn decode_op(&self, op: &PirOp, value: Option<&[u8]>) -> Result<Decoded, PirProviderError> {
        if let Some(decoded) = self.decode_stealth(op, value) {
            return Ok(decoded);
        }
        let (decoded, remember) = decode_with_names(op, value)?;
        if !remember.is_empty() {
            self.remember_names(&remember);
        }
        Ok(decoded)
    }

    /// Stealth answers read the sidecar, not the PIR value. `None` means this
    /// op is not a stealth call.
    fn decode_stealth(&self, op: &PirOp, value: Option<&[u8]>) -> Option<Decoded> {
        match op.decode {
            PirDecode::StealthMeta {
                registrant,
                scheme_id,
            } => {
                if let Ok((_, remember)) =
                    decode_name_reverse(crate::names::NameSystem::Ens, registrant, value)
                    && !remember.is_empty()
                {
                    self.remember_names(&remember);
                }
                let meta = self
                    .fresh_stealth()
                    .map(|bc| meta_bytes(&bc, &registrant, scheme_id))
                    .unwrap_or_default();
                Some(Decoded::Value(encode_stealth_meta_result(&meta)))
            }
            PirDecode::StealthText { system, node } => {
                Some(self.stealth_text_decoded(system, node))
            }
            _ => None,
        }
    }

    fn plan_stealth_meta(&self, registrant: [u8; 20], scheme_id: Option<u64>) -> PlannedOp {
        let Some(scheme_id) = scheme_id else {
            return PlannedOp::Local(encode_stealth_meta_result(&[]));
        };
        if let Some(bc) = self.fresh_stealth() {
            PlannedOp::Local(encode_stealth_meta_result(&meta_bytes(
                &bc,
                &registrant,
                scheme_id,
            )))
        } else {
            PlannedOp::Pir(PirOp {
                lane: PirLane::Names,
                key: registrant.to_vec(),
                decode: PirDecode::StealthMeta {
                    registrant,
                    scheme_id,
                },
                holder: None,
                token_index: None,
            })
        }
    }

    fn plan_stealth_text(&self, system: crate::names::NameSystem, node: [u8; 32]) -> PlannedOp {
        if self.fresh_stealth().is_some() {
            match self.stealth_text_decoded(system, node) {
                Decoded::Value(value) => PlannedOp::Local(value),
                Decoded::NeedsFallback => PlannedOp::Fallback,
            }
        } else {
            PlannedOp::Pir(PirOp {
                lane: PirLane::Names,
                key: vec![0u8; 20],
                decode: PirDecode::StealthText { system, node },
                holder: None,
                token_index: None,
            })
        }
    }

    fn stealth_text_decoded(&self, system: crate::names::NameSystem, node: [u8; 32]) -> Decoded {
        let Some(bc) = self.fresh_stealth() else {
            return if self.name_is_remembered(system, &node) {
                Decoded::Value(encode_stealth_text_result(system, ""))
            } else {
                Decoded::NeedsFallback
            };
        };
        if let Some(value) = bc
            .texts
            .iter()
            .find(|t| t.node == node)
            .map(|t| t.value.clone())
        {
            Decoded::Value(encode_stealth_text_result(system, &value))
        } else if self.name_is_remembered(system, &node) {
            Decoded::Value(encode_stealth_text_result(system, ""))
        } else {
            Decoded::NeedsFallback
        }
    }

    fn name_is_remembered(&self, system: crate::names::NameSystem, node: &[u8; 32]) -> bool {
        let mut cache = self
            .name_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        cache.prune(now);
        cache.by_hash.contains_key(&(system as u8, *node))
    }

    fn remember_names(&self, names: &[RememberedName]) {
        let mut cache = self
            .name_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        cache.prune(now);
        for hit in names {
            let lower = hit.name.to_ascii_lowercase();
            let hash = namehash(&lower);
            cache.by_hash.insert(
                (hit.system as u8, hash),
                CachedAddress {
                    address: hit.address,
                    at: now,
                },
            );
            if hit.system == crate::names::NameSystem::Ens {
                cache.by_ens_name.insert(
                    lower,
                    CachedAddress {
                        address: hit.address,
                        at: now,
                    },
                );
            }
        }
    }

    fn cached_forward(&self, forward: &crate::names::NameForward) -> Option<[u8; 20]> {
        let mut cache = self
            .name_cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let now = Instant::now();
        cache.prune(now);
        match forward {
            crate::names::NameForward::TokenId { system, token_id } => cache
                .by_hash
                .get(&(*system as u8, *token_id))
                .map(|hit| hit.address),
            crate::names::NameForward::EnsName { name } => cache
                .by_ens_name
                .get(&name.to_ascii_lowercase())
                .map(|hit| hit.address),
        }
    }
}

/// Deduplicate ops by `(lane, key)`. Returns unique keys (lookup order) and a
/// remap from op index → unique key index.
pub fn dedupe_keys(ops: &[PirOp]) -> (Vec<Vec<u8>>, Vec<usize>) {
    let mut index_of: HashMap<(PirLane, Vec<u8>), usize> = HashMap::new();
    let mut unique = Vec::new();
    let mut remap = Vec::with_capacity(ops.len());
    for op in ops {
        let k = (op.lane, op.key.clone());
        if let Some(&i) = index_of.get(&k) {
            remap.push(i);
        } else {
            let i = unique.len();
            index_of.insert(k, i);
            unique.push(op.key.clone());
            remap.push(i);
        }
    }
    (unique, remap)
}

fn normalize_params(params: &Value) -> Value {
    if params.is_null() {
        Value::Array(Vec::new())
    } else {
        params.clone()
    }
}

/// Decode raw PIR bytes for one planned op.
///
/// A miss (`None`) yields the zero encoding for that op (never an error),
/// except a name that did not fit, which is [`Decoded::NeedsFallback`].
///
/// # Errors
///
/// Returns [`PirProviderError::Client`] when account, storage, or name blobs
/// cannot be parsed.
pub fn decode_pir(op: &PirOp, value: Option<&[u8]>) -> Result<Decoded, PirProviderError> {
    decode_with_names(op, value).map(|(decoded, _)| decoded)
}

fn decode_with_names(
    op: &PirOp,
    value: Option<&[u8]>,
) -> Result<(Decoded, Vec<RememberedName>), PirProviderError> {
    let value_json = |bytes_result: Result<Value, PirProviderError>| {
        bytes_result.map(|v| (Decoded::Value(v), Vec::new()))
    };
    match (&op.decode, value) {
        (PirDecode::AccountBalance, Some(raw)) => {
            let acct = parse_account_bytes(raw)
                .ok_or_else(|| PirProviderError::Client("account value is not 40 bytes".into()))?;
            value_json(Ok(encode_qty(acct.balance)))
        }
        (PirDecode::AccountNonce, Some(raw)) => {
            let acct = parse_account_bytes(raw)
                .ok_or_else(|| PirProviderError::Client("account value is not 40 bytes".into()))?;
            value_json(Ok(encode_qty(u128::from(acct.nonce))))
        }
        (PirDecode::AccountCode, Some(raw)) => {
            let acct = parse_account_bytes(raw)
                .ok_or_else(|| PirProviderError::Client("account value is not 40 bytes".into()))?;
            value_json(Ok(encode_bytes(&account_code(acct.delegate))))
        }
        (PirDecode::AccountCode, None) => value_json(Ok(encode_bytes(&[]))),
        (PirDecode::AccountBalance | PirDecode::AccountNonce, None) => {
            value_json(Ok(encode_qty(0)))
        }
        (PirDecode::NameReverse { system }, raw) => {
            let address: [u8; 20] = op.key.as_slice().try_into().map_err(|_| {
                PirProviderError::Client("name lookup key is not a 20-byte address".into())
            })?;
            decode_name_reverse(*system, address, raw)
        }
        (PirDecode::TokenBalance { flag_in_top_bit }, Some(raw)) => {
            let mut word = parse_storage_value(raw).ok_or_else(|| {
                PirProviderError::Client("token value is not a 40-byte storage cell".into())
            })?;
            if *flag_in_top_bit {
                word[0] &= 0x7f;
            }
            value_json(Ok(encode_uint256(&word)))
        }
        (PirDecode::TokenBalance { .. }, None) => value_json(Ok(encode_uint256(&[]))),
        (PirDecode::Call { value_encoding }, Some(raw)) => {
            value_json(Ok(match value_encoding.as_str() {
                "bytes" | "account" => encode_bytes(raw),
                _ => encode_uint256(raw),
            }))
        }
        (PirDecode::Call { value_encoding }, None) => value_json(Ok(encode_zero(value_encoding))),
        (PirDecode::StealthMeta { .. } | PirDecode::StealthText { .. }, _) => Err(
            PirProviderError::Client("stealth decode is handled by the router".into()),
        ),
    }
}

fn meta_bytes(broadcast: &StealthBroadcast, registrant: &[u8; 20], scheme_id: u64) -> Vec<u8> {
    broadcast
        .registry
        .iter()
        .find(|entry| entry.scheme_id == scheme_id && entry.registrant == *registrant)
        .map(|entry| entry.meta.clone())
        .unwrap_or_default()
}

fn account_code(delegate: Option<[u8; 20]>) -> Vec<u8> {
    match delegate {
        Some(delegate) => {
            let mut code = vec![0xef, 0x01, 0x00];
            code.extend_from_slice(&delegate);
            code
        }
        None => Vec::new(),
    }
}

fn parse_account_bytes(v: &[u8]) -> Option<AccountView> {
    if v.len() != 40 {
        return None;
    }
    let delegate: [u8; 20] = v[..20].try_into().ok()?;
    let mut balance = [0u8; 16];
    balance[4..].copy_from_slice(&v[20..32]);
    Some(AccountView {
        balance: u128::from_be_bytes(balance),
        nonce: u64::from_be_bytes(v[32..40].try_into().ok()?),
        delegate: (delegate != [0u8; 20]).then_some(delegate),
    })
}

struct AccountView {
    balance: u128,
    nonce: u64,
    delegate: Option<[u8; 20]>,
}

#[cfg(test)]
struct RecordingLookup {
    inner: MapLookup,
    batches: std::sync::Arc<std::sync::Mutex<Vec<usize>>>,
}

#[cfg(test)]
impl LookupBackend for RecordingLookup {
    fn lookup(&self, key: &[u8]) -> Result<Option<Vec<u8>>, PirProviderError> {
        self.inner.lookup(key)
    }

    fn lookup_batch(&self, keys: &[Vec<u8>]) -> Result<Vec<Option<Vec<u8>>>, PirProviderError> {
        self.batches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(keys.len());
        self.inner.lookup_batch(keys)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{
        DatasetManifest,
        routes::encode_uint256,
        tokens::{PIR_TOKENS, parse_storage_value},
    };

    fn account_bytes(balance: u128, nonce: u64) -> Vec<u8> {
        let mut v = vec![0u8; 40];
        let be = balance.to_be_bytes();
        v[20..32].copy_from_slice(&be[4..]);
        v[32..40].copy_from_slice(&nonce.to_be_bytes());
        v
    }

    fn pir_value(item: &Result<Decoded, PirProviderError>) -> &Value {
        match item.as_ref().expect("decode") {
            Decoded::Value(v) => v,
            Decoded::NeedsFallback => panic!("expected a decoded value"),
        }
    }

    fn storage_cell(word: [u8; 32]) -> Vec<u8> {
        let mut v = vec![0u8; 40];
        v[8..].copy_from_slice(&word);
        v
    }

    fn addr(n: u8) -> [u8; 20] {
        let mut a = [0u8; 20];
        a[19] = n;
        a
    }

    fn addr_hex(n: u8) -> String {
        format!("0x{}", hex::encode(addr(n)))
    }

    #[tokio::test]
    async fn get_balance_uses_pir_not_fallback() {
        let lookup = MapLookup::default();
        lookup.insert(addr(1), account_bytes(0x0163_4578_5d8a_0000, 7));
        let fallback = MapFallback::default();
        fallback.set("eth_getBalance", json!("0xdead"));
        let router = PirRouter::mock(lookup, fallback, Vec::new());

        let got = router
            .request("eth_getBalance", json!([addr_hex(1), "latest"]))
            .await
            .unwrap();
        assert_eq!(got, json!("0x16345785d8a0000"));
    }

    #[tokio::test]
    async fn get_nonce_uses_pir() {
        let lookup = MapLookup::default();
        lookup.insert(addr(1), account_bytes(1, 9));
        let router = PirRouter::mock(lookup, MapFallback::default(), Vec::new());
        let got = router
            .request("eth_getTransactionCount", json!([addr_hex(1)]))
            .await
            .unwrap();
        assert_eq!(got, json!("0x9"));
    }

    #[tokio::test]
    async fn missing_account_is_zero_not_fallback() {
        let fallback = MapFallback::default();
        fallback.set("eth_getBalance", json!("0xdead"));
        let router = PirRouter::mock(MapLookup::default(), fallback, Vec::new());
        let got = router
            .request("eth_getBalance", json!([addr_hex(9), "latest"]))
            .await
            .unwrap();
        assert_eq!(got, json!("0x0"));
    }

    #[tokio::test]
    async fn get_logs_uses_fallback() {
        let fallback = MapFallback::default();
        fallback.set("eth_getLogs", json!([]));
        let router = PirRouter::mock(MapLookup::default(), fallback, Vec::new());
        let got = router.request("eth_getLogs", json!([{}])).await.unwrap();
        assert_eq!(got, json!([]));
    }

    #[tokio::test]
    async fn unknown_eth_call_uses_fallback() {
        let fallback = MapFallback::default();
        fallback.set("eth_call", json!("0x01"));
        let router = PirRouter::mock(MapLookup::default(), fallback, Vec::new());
        let params = json!([{
            "to": addr_hex(3),
            "data": "0xdeadbeef"
        }, "latest"]);
        let got = router.request("eth_call", params).await.unwrap();
        assert_eq!(got, json!("0x01"));
    }

    #[tokio::test]
    async fn usdc_balance_of_uses_token_pir() {
        let holder = addr(2);
        let token = &PIR_TOKENS[0];
        let key = token.balance_key(&holder);
        let mut word = [0u8; 32];
        word[0] = 0x80; // blacklist bit
        word[31] = 42;
        let tokens = Arc::new(MapLookup::default());
        tokens.insert(key.as_slice(), storage_cell(word));
        let fallback = MapFallback::default();
        fallback.set("eth_call", json!("0xdead"));
        let router = PirRouter::from_parts_dual(
            Arc::new(MapLookup::default()),
            Some(tokens),
            Arc::new(fallback),
            Vec::new(),
        );

        let data = crate::routes::balance_of_data_hex(&holder);
        let params = json!([{ "to": token.address, "data": data }, "latest"]);
        let got = router.request("eth_call", params).await.unwrap();
        let mut cleared = word;
        cleared[0] = 0;
        assert_eq!(got, encode_uint256(&cleared));
        assert_eq!(parse_storage_value(&storage_cell(word)).unwrap()[31], 42);
    }

    #[tokio::test]
    async fn matched_eth_call_uses_pir() {
        let to = addr(8);
        let holder = addr(2);
        let mut packed = Vec::from(to);
        packed.extend_from_slice(&holder);
        let key = alloy::primitives::keccak256(&packed);

        let lookup = MapLookup::default();
        lookup.insert(key.as_slice(), 42u128.to_be_bytes());

        let datasets = vec![DatasetManifest {
            id: "erc20_balances".into(),
            selectors: vec!["0x70a08231".into()],
            contracts: vec![addr_hex(8)],
            key_scheme: "token_holder".into(),
            value_encoding: "uint256".into(),
            ..DatasetManifest::default()
        }];
        let fallback = MapFallback::default();
        fallback.set("eth_call", json!("0xdead"));
        let router = PirRouter::mock(lookup, fallback, datasets);

        let data = format!("0x70a08231{:0>64}", hex::encode(holder));
        let params = json!([{ "to": addr_hex(8), "data": data }, "latest"]);
        let got = router.request("eth_call", params).await.unwrap();
        assert_eq!(got, encode_uint256(&42u128.to_be_bytes()));
    }

    #[tokio::test]
    async fn historical_get_balance_uses_fallback() {
        let fallback = MapFallback::default();
        fallback.set("eth_getBalance", json!("0xabc"));
        let lookup = MapLookup::default();
        lookup.insert(addr(1), account_bytes(1, 0));
        let router = PirRouter::mock(lookup, fallback, Vec::new());
        let got = router
            .request("eth_getBalance", json!([addr_hex(1), "0x10"]))
            .await
            .unwrap();
        assert_eq!(got, json!("0xabc"));
    }

    #[tokio::test]
    async fn execute_pir_dedupes_same_account_key() {
        let lookup = MapLookup::default();
        lookup.insert(addr(1), account_bytes(10, 3));
        let router = PirRouter::mock(lookup, MapFallback::default(), Vec::new());
        let ops = vec![
            PirOp {
                lane: PirLane::Account,
                key: addr(1).to_vec(),
                decode: PirDecode::AccountBalance,
                holder: None,
                token_index: None,
            },
            PirOp {
                lane: PirLane::Account,
                key: addr(1).to_vec(),
                decode: PirDecode::AccountNonce,
                holder: None,
                token_index: None,
            },
        ];
        let out = router.execute_pir(&ops).await.unwrap();
        assert_eq!(pir_value(&out[0]), &json!("0xa"));
        assert_eq!(pir_value(&out[1]), &json!("0x3"));
    }

    #[tokio::test]
    async fn execute_pir_batches_lookups() {
        let lookup = MapLookup::default();
        lookup.insert(addr(1), account_bytes(10, 1));
        lookup.insert(addr(2), account_bytes(20, 2));
        let router = PirRouter::mock(lookup, MapFallback::default(), Vec::new());
        let ops = vec![
            PirOp {
                lane: PirLane::Account,
                key: addr(1).to_vec(),
                decode: PirDecode::AccountBalance,
                holder: None,
                token_index: None,
            },
            PirOp {
                lane: PirLane::Account,
                key: addr(2).to_vec(),
                decode: PirDecode::AccountNonce,
                holder: None,
                token_index: None,
            },
        ];
        let out = router.execute_pir(&ops).await.unwrap();
        assert_eq!(pir_value(&out[0]), &json!("0xa"));
        assert_eq!(pir_value(&out[1]), &json!("0x2"));
    }

    #[test]
    fn plan_request_splits_pir_and_fallback() {
        let router = PirRouter::mock(MapLookup::default(), MapFallback::default(), Vec::new());
        match router
            .plan_request("eth_getBalance", &json!([addr_hex(1), "latest"]))
            .unwrap()
        {
            PlannedOp::Pir(op) => {
                assert_eq!(op.key, addr(1));
                assert_eq!(op.lane, PirLane::Account);
            }
            PlannedOp::Fallback | PlannedOp::Local(_) => panic!("expected PIR"),
        }
        assert!(matches!(
            router.plan_request("eth_getLogs", &json!([{}])).unwrap(),
            PlannedOp::Fallback
        ));
        match router
            .plan_request("eth_getCode", &json!([addr_hex(1), "latest"]))
            .unwrap()
        {
            PlannedOp::Pir(op) => {
                assert_eq!(op.lane, PirLane::Account);
                assert_eq!(op.decode, PirDecode::AccountCode);
                assert_eq!(op.key, addr(1));
            }
            other => panic!("expected PIR getCode, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn balance_nonce_and_code_share_one_lookup() {
        let delegate = [0xab; 20];
        let mut value = account_bytes(0x0102, 7);
        value[..20].copy_from_slice(&delegate);
        let lookup = MapLookup::default();
        lookup.insert(addr(1), value);
        let batches = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recording = std::sync::Arc::new(RecordingLookup {
            inner: lookup,
            batches: std::sync::Arc::clone(&batches),
        });
        let router = PirRouter::from_parts(
            recording.clone(),
            std::sync::Arc::new(MapFallback::default()),
            Vec::new(),
        );
        let ops = vec![
            PirOp {
                lane: PirLane::Account,
                key: addr(1).to_vec(),
                decode: PirDecode::AccountBalance,
                holder: None,
                token_index: None,
            },
            PirOp {
                lane: PirLane::Account,
                key: addr(1).to_vec(),
                decode: PirDecode::AccountNonce,
                holder: None,
                token_index: None,
            },
            PirOp {
                lane: PirLane::Account,
                key: addr(1).to_vec(),
                decode: PirDecode::AccountCode,
                holder: None,
                token_index: None,
            },
        ];
        let out = router.execute_pir(&ops).await.unwrap();
        assert_eq!(pir_value(&out[0]), &json!("0x102"));
        assert_eq!(pir_value(&out[1]), &json!("0x7"));
        let mut code = vec![0xef, 0x01, 0x00];
        code.extend_from_slice(&delegate);
        assert_eq!(
            pir_value(&out[2]),
            &json!(format!("0x{}", hex::encode(code)))
        );
        let batches = batches.lock().unwrap();
        assert_eq!(batches.as_slice(), &[1], "one lookup for three fields");
    }

    #[tokio::test]
    async fn plain_eoa_code_is_empty() {
        let lookup = MapLookup::default();
        lookup.insert(addr(1), account_bytes(5, 1));
        let router = PirRouter::mock(lookup, MapFallback::default(), Vec::new());
        let got = router
            .request("eth_getCode", json!([addr_hex(1), "latest"]))
            .await
            .unwrap();
        assert_eq!(got, json!("0x"));
    }

    #[tokio::test]
    async fn historical_get_code_uses_fallback() {
        let fallback = MapFallback::default();
        fallback.set("eth_getCode", json!("0x6080"));
        let router = PirRouter::mock(MapLookup::default(), fallback, Vec::new());
        let got = router
            .request("eth_getCode", json!([addr_hex(1), "0x10"]))
            .await
            .unwrap();
        assert_eq!(got, json!("0x6080"));
    }

    #[tokio::test]
    async fn gns_reverse_then_forward_stays_on_pir() {
        let mut value = vec![0u8; 40];
        let name = b"banteg.gwei";
        value[0] = 2;
        value[1] = name.len() as u8;
        value[2..2 + name.len()].copy_from_slice(name);
        let names = MapLookup::default();
        names.insert(addr(4), value);
        let fallback = MapFallback::default();
        fallback.set("eth_call", json!("0xdead"));
        let router = PirRouter::from_parts_lanes(
            std::sync::Arc::new(MapLookup::default()),
            None,
            Some(std::sync::Arc::new(names)),
            std::sync::Arc::new(fallback),
            Vec::new(),
        );
        let gns = "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6";
        let reverse = crate::names::gns_reverse_calldata(&addr(4));
        let (got, path) = router
            .request_with_path(
                "eth_call",
                json!([{ "to": gns, "data": format!("0x{}", hex::encode(reverse)) }, "latest"]),
            )
            .await
            .unwrap();
        assert_eq!(path, CallPath::Pir);
        let text = got.as_str().unwrap();
        assert!(text.contains(&hex::encode(b"banteg.gwei")));

        let hash = crate::names::namehash("banteg.gwei");
        let resolve = crate::names::gns_resolve_calldata(&hash);
        let (got, path) = router
            .request_with_path(
                "eth_call",
                json!([{ "to": gns, "data": format!("0x{}", hex::encode(resolve)) }, "latest"]),
            )
            .await
            .unwrap();
        assert_eq!(path, CallPath::Local);
        let mut word = [0u8; 32];
        word[12..].copy_from_slice(&addr(4));
        assert_eq!(got, json!(format!("0x{}", hex::encode(word))));
    }

    #[tokio::test]
    async fn name_too_long_falls_back() {
        let mut value = vec![0u8; 40];
        value[0] = 0x82;
        let names = MapLookup::default();
        names.insert(addr(4), value);
        let fallback = MapFallback::default();
        fallback.set("eth_call", json!("0xfromrpc"));
        let router = PirRouter::from_parts_lanes(
            std::sync::Arc::new(MapLookup::default()),
            None,
            Some(std::sync::Arc::new(names)),
            std::sync::Arc::new(fallback),
            Vec::new(),
        );
        let gns = "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6";
        let reverse = crate::names::gns_reverse_calldata(&addr(4));
        let (got, path) = router
            .request_with_path(
                "eth_call",
                json!([{ "to": gns, "data": format!("0x{}", hex::encode(reverse)) }, "latest"]),
            )
            .await
            .unwrap();
        assert_eq!(path, CallPath::Fallback);
        assert_eq!(got, json!("0xfromrpc"));
    }

    #[tokio::test]
    async fn compute_id_is_local() {
        let router = PirRouter::mock(MapLookup::default(), MapFallback::default(), Vec::new());
        let gns = "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6";
        let data = crate::names::gns_compute_id_calldata("banteg.gwei");
        let (got, path) = router
            .request_with_path(
                "eth_call",
                json!([{ "to": gns, "data": format!("0x{}", hex::encode(data)) }, "latest"]),
            )
            .await
            .unwrap();
        assert_eq!(path, CallPath::Local);
        assert_eq!(
            got,
            json!(format!(
                "0x{}",
                hex::encode(crate::names::namehash("banteg.gwei"))
            ))
        );
    }

    fn eth_call(to: &str, data: &[u8]) -> Value {
        json!([{ "to": to, "data": format!("0x{}", hex::encode(data)) }, "latest"])
    }

    fn stealth_router(names: MapLookup) -> PirRouter {
        let fallback = MapFallback::default();
        fallback.set("eth_call", json!("0xdead"));
        PirRouter::from_parts_lanes(
            std::sync::Arc::new(MapLookup::default()),
            None,
            Some(std::sync::Arc::new(names)),
            std::sync::Arc::new(fallback),
            Vec::new(),
        )
    }

    #[tokio::test]
    async fn stealth_meta_comes_from_the_names_sidecar() {
        let names = MapLookup::default();
        let meta = vec![0x02, 0x11, 0x22];
        *names.stealth.lock().unwrap() = Some(crate::StealthBroadcast {
            registry: vec![crate::StealthEntry {
                registrant: addr(4),
                scheme_id: 1,
                meta: meta.clone(),
            }],
            texts: vec![],
        });
        let router = stealth_router(names);
        let registry = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538";
        let (got, path) = router
            .request_with_path(
                "eth_call",
                eth_call(registry, &crate::names::stealth_meta_calldata(&addr(4), 1)),
            )
            .await
            .unwrap();
        assert_eq!(path, CallPath::Pir);
        assert_eq!(got, encode_stealth_meta_result(&meta));

        let (got, path) = router
            .request_with_path(
                "eth_call",
                eth_call(registry, &crate::names::stealth_meta_calldata(&addr(9), 1)),
            )
            .await
            .unwrap();
        assert_eq!(path, CallPath::Local);
        assert_eq!(got, encode_stealth_meta_result(&[]));
    }

    #[tokio::test]
    async fn stealth_text_uses_the_list_or_a_remembered_name() {
        let mut value = vec![0u8; 40];
        let name = b"banteg.gwei";
        value[0] = 2;
        value[1] = name.len() as u8;
        value[2..2 + name.len()].copy_from_slice(name);
        let names = MapLookup::default();
        names.insert(addr(4), value);
        let listed = crate::names::namehash("vitalik.eth");
        let remembered = crate::names::namehash("banteg.gwei");
        *names.stealth.lock().unwrap() = Some(crate::StealthBroadcast {
            registry: vec![],
            texts: vec![crate::StealthText {
                node: listed,
                value: "st:eth:0x03".into(),
            }],
        });
        let router = stealth_router(names);
        let gns = "0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6";
        let reverse = crate::names::gns_reverse_calldata(&addr(4));
        let (_, path) = router
            .request_with_path("eth_call", eth_call(gns, &reverse))
            .await
            .unwrap();
        assert_eq!(path, CallPath::Pir);

        let universal = "0xeeeeeeee14d718c2b47d9923deab1335e144eeee";
        let listed_call = crate::names::resolve_gateways_text_calldata(
            "vitalik.eth",
            &listed,
            "stealth-address-scheme-1",
        );
        let (got, path) = router
            .request_with_path("eth_call", eth_call(universal, &listed_call))
            .await
            .unwrap();
        assert_eq!(path, CallPath::Local);
        assert_eq!(
            got,
            encode_stealth_text_result(crate::names::NameSystem::Ens, "st:eth:0x03")
        );

        let missing = crate::names::gns_text_calldata(&remembered, "stealth-address-scheme-1");
        let (got, path) = router
            .request_with_path("eth_call", eth_call(gns, &missing))
            .await
            .unwrap();
        assert_eq!(path, CallPath::Local);
        assert_eq!(
            got,
            encode_stealth_text_result(crate::names::NameSystem::Gns, "")
        );

        let avatar = crate::names::gns_text_calldata(&remembered, "avatar");
        let (got, path) = router
            .request_with_path("eth_call", eth_call(gns, &avatar))
            .await
            .unwrap();
        assert_eq!(path, CallPath::Fallback);
        assert_eq!(got, json!("0xdead"));

        let unknown = crate::names::namehash("alice.eth");
        let unknown_call = crate::names::resolve_gateways_text_calldata(
            "alice.eth",
            &unknown,
            "stealth-address-scheme-1",
        );
        let (got, path) = router
            .request_with_path("eth_call", eth_call(universal, &unknown_call))
            .await
            .unwrap();
        assert_eq!(path, CallPath::Fallback);
        assert_eq!(got, json!("0xdead"));
    }

    #[tokio::test]
    async fn same_batch_names_lookup_fills_stealth_before_decode() {
        let mut value = vec![0u8; 40];
        let name = b"banteg.gwei";
        value[0] = 2;
        value[1] = name.len() as u8;
        value[2..2 + name.len()].copy_from_slice(name);
        let names = MapLookup::default();
        names.insert(addr(4), value);
        let meta = vec![0x02, 0xaa];
        *names.stealth.lock().unwrap() = Some(crate::StealthBroadcast {
            registry: vec![crate::StealthEntry {
                registrant: addr(4),
                scheme_id: 1,
                meta: meta.clone(),
            }],
            texts: vec![],
        });
        let router = stealth_router(names);
        let ops = vec![
            PirOp {
                lane: PirLane::Names,
                key: addr(4).to_vec(),
                decode: PirDecode::NameReverse {
                    system: crate::names::NameSystem::Gns,
                },
                holder: None,
                token_index: None,
            },
            PirOp {
                lane: PirLane::Names,
                key: addr(4).to_vec(),
                decode: PirDecode::StealthMeta {
                    registrant: addr(4),
                    scheme_id: 1,
                },
                holder: None,
                token_index: None,
            },
        ];
        let out = router.execute_pir(&ops).await.unwrap();
        let text = pir_value(&out[0]).as_str().unwrap();
        assert!(text.contains(&hex::encode(b"banteg.gwei")));
        assert_eq!(pir_value(&out[1]), &encode_stealth_meta_result(&meta));
    }

    #[tokio::test]
    async fn stealth_without_names_lane_falls_back() {
        let fallback = MapFallback::default();
        fallback.set("eth_call", json!("0xdead"));
        let router = PirRouter::mock(MapLookup::default(), fallback, Vec::new());
        let registry = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538";
        let (got, path) = router
            .request_with_path(
                "eth_call",
                eth_call(registry, &crate::names::stealth_meta_calldata(&addr(4), 1)),
            )
            .await
            .unwrap();
        assert_eq!(path, CallPath::Fallback);
        assert_eq!(got, json!("0xdead"));
    }
}
