use std::sync::Arc;

use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use kohaku_pir_rpc::{DatasetManifest, MapFallback, MapLookup, PirRouter};
use kohaku_tor_rpc::TorRpc;
use url::Url;

use crate::{
    AsyncLookupBackend, DefaultIsolationPolicy, IsolationPolicy, LiveTorRpc, PrivacyConnect,
    PrivacyError, PrivacyTransport, StateVerifier, SyncLookupAdapter, TorPirLookup, TorRpcBackend,
};

/// Mix-and-match builder for the privacy orchestrator.
///
/// `TorPIR` preset: `.tor(...).pir_over_tor(accounts_url, token_url, datasets).connect()`.
/// Future Helios+Tor: `.tor(...).verifier(helios).connect()` without PIR.
pub struct PrivacyBuilder {
    rpc_url: Url,
    tor: Option<Arc<dyn TorRpcBackend>>,
    accounts_lookup: Option<Arc<dyn AsyncLookupBackend>>,
    tokens_lookup: Option<Arc<dyn AsyncLookupBackend>>,
    names_lookup: Option<Arc<dyn AsyncLookupBackend>>,
    /// When set, build [`TorPirLookup`] for accounts at `build_transport` time.
    pir_accounts_url: Option<String>,
    /// Optional token-storage PIR URL.
    pir_tokens_url: Option<String>,
    datasets: Vec<DatasetManifest>,
    isolation: Arc<dyn IsolationPolicy>,
    verifier: Option<Arc<dyn StateVerifier>>,
}

impl PrivacyBuilder {
    /// Start a builder targeting `rpc_url` for fallback Ethereum JSON-RPC.
    ///
    /// # Errors
    ///
    /// Returns [`PrivacyError::InvalidUrl`] when the URL cannot be parsed.
    pub fn new(rpc_url: &str) -> Result<Self, PrivacyError> {
        let rpc_url = Url::parse(rpc_url).map_err(|e| PrivacyError::InvalidUrl(e.to_string()))?;
        Ok(Self {
            rpc_url,
            tor: None,
            accounts_lookup: None,
            tokens_lookup: None,
            names_lookup: None,
            pir_accounts_url: None,
            pir_tokens_url: None,
            datasets: Vec::new(),
            isolation: Arc::new(DefaultIsolationPolicy),
            verifier: None,
        })
    }

    /// Use a live [`TorRpc`] for all egress.
    #[must_use]
    pub fn tor(mut self, tor: TorRpc) -> Self {
        self.tor = Some(Arc::new(LiveTorRpc::new(tor)));
        self
    }

    /// Inject a custom Tor backend (tests, alternate transports).
    #[must_use]
    pub fn tor_backend(mut self, tor: Arc<dyn TorRpcBackend>) -> Self {
        self.tor = Some(tor);
        self
    }

    /// Enable PIR over **shared Tor** to account and optional token PIR bases.
    ///
    /// `token_pir_url`: `None` keeps ERC-20 `balanceOf` on fallback RPC (still
    /// Multicall-packed). Pass `Some(url)` for the inspire storage table (`:18091`).
    #[must_use]
    pub fn pir_over_tor(
        mut self,
        accounts_pir_url: &str,
        token_pir_url: Option<&str>,
        datasets: Vec<DatasetManifest>,
    ) -> Self {
        self.pir_accounts_url = Some(accounts_pir_url.to_string());
        self.pir_tokens_url = token_pir_url.map(str::to_string);
        self.accounts_lookup = None;
        self.tokens_lookup = None;
        self.datasets = datasets;
        self
    }

    /// Enable PIR with custom async lookups (e.g. inspire crypto pools).
    #[must_use]
    pub fn pir_lookup(
        mut self,
        accounts: Arc<dyn AsyncLookupBackend>,
        tokens: Option<Arc<dyn AsyncLookupBackend>>,
        names: Option<Arc<dyn AsyncLookupBackend>>,
        datasets: Vec<DatasetManifest>,
    ) -> Self {
        self.accounts_lookup = Some(accounts);
        self.tokens_lookup = tokens;
        self.names_lookup = names;
        self.pir_accounts_url = None;
        self.pir_tokens_url = None;
        self.datasets = datasets;
        self
    }

    /// Override the default shared / isolated-by-EOA policy.
    #[must_use]
    pub fn isolation_policy(mut self, policy: Arc<dyn IsolationPolicy>) -> Self {
        self.isolation = policy;
        self
    }

    /// Attach an optional lightclient verifier (Helios / Colibri later).
    #[must_use]
    pub fn verifier(mut self, verifier: Arc<dyn StateVerifier>) -> Self {
        self.verifier = Some(verifier);
        self
    }

    /// Build the [`PrivacyTransport`].
    ///
    /// # Errors
    ///
    /// Returns when Tor was not configured, or a PIR URL is invalid.
    pub fn build_transport(self) -> Result<PrivacyTransport, PrivacyError> {
        let tor = self
            .tor
            .ok_or_else(|| PrivacyError::Builder("tor backend is required".into()))?;

        let (accounts_lookup, tokens_lookup, names_lookup) =
            if let Some(accounts_url) = self.pir_accounts_url {
                let accounts = Arc::new(TorPirLookup::new(Arc::clone(&tor), &accounts_url)?)
                    as Arc<dyn AsyncLookupBackend>;
                let tokens = self
                    .pir_tokens_url
                    .map(|u| {
                        TorPirLookup::new(Arc::clone(&tor), &u)
                            .map(|l| Arc::new(l) as Arc<dyn AsyncLookupBackend>)
                    })
                    .transpose()?;
                (Some(accounts), tokens, self.names_lookup)
            } else {
                (self.accounts_lookup, self.tokens_lookup, self.names_lookup)
            };

        // Router is used for plan/classify only; its sync LookupBackend is inert.
        let router = Arc::new(PirRouter::from_parts(
            Arc::new(MapLookup::default()),
            Arc::new(MapFallback::default()),
            self.datasets,
        ));
        Ok(PrivacyTransport::new(
            router,
            accounts_lookup,
            tokens_lookup,
            names_lookup,
            tor,
            self.rpc_url,
            self.isolation,
            self.verifier,
        ))
    }

    /// Build a type-erased Alloy provider.
    ///
    /// # Errors
    ///
    /// Returns when the transport cannot be built or Alloy connect fails.
    pub async fn connect(self) -> Result<DynProvider, PrivacyError> {
        let transport = self.build_transport()?;
        ProviderBuilder::default()
            .connect_with(&PrivacyConnect::new(transport))
            .await
            .map(Provider::erased)
            .map_err(|e| PrivacyError::Transport(e.to_string()))
    }
}

/// Convenience: Tor + PIR-over-Tor → [`DynProvider`].
///
/// # Errors
///
/// Returns when a URL is invalid or Alloy connect fails.
pub async fn connect_tor_pir(
    tor: TorRpc,
    accounts_pir_url: &str,
    token_pir_url: Option<&str>,
    rpc_url: &str,
    datasets: Vec<DatasetManifest>,
) -> Result<DynProvider, PrivacyError> {
    PrivacyBuilder::new(rpc_url)?
        .tor(tor)
        .pir_over_tor(accounts_pir_url, token_pir_url, datasets)
        .connect()
        .await
}

/// Test helper: sync [`MapLookup`](kohaku_pir_rpc::MapLookup) as async PIR (no Tor HTTP).
#[must_use]
pub fn sync_pir_lookup(
    lookup: Arc<dyn kohaku_pir_rpc::LookupBackend>,
) -> Arc<dyn AsyncLookupBackend> {
    Arc::new(SyncLookupAdapter::new(lookup))
}
