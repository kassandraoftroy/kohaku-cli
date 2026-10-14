use std::fmt;

use kohaku_pir_rpc::PirProviderError;

/// Errors from the privacy orchestrator.
#[derive(Debug, thiserror::Error)]
pub enum PrivacyError {
    /// PIR planning or lookup failed.
    #[error(transparent)]
    Pir(#[from] PirProviderError),
    /// Tor / Alloy transport failed.
    #[error("transport: {0}")]
    Transport(String),
    /// Builder was missing a required slot.
    #[error("builder: {0}")]
    Builder(String),
    /// Invalid URL.
    #[error("invalid URL: {0}")]
    InvalidUrl(String),
}

impl PrivacyError {
    /// JSON-RPC error code (`-32602` params, else `-32603` or passthrough).
    #[must_use]
    pub fn rpc_code(&self) -> i64 {
        match self {
            Self::Pir(e) => e.rpc_code(),
            _ => -32603,
        }
    }
}

impl From<alloy::transports::TransportError> for PrivacyError {
    fn from(value: alloy::transports::TransportError) -> Self {
        Self::Transport(value.to_string())
    }
}

impl From<PrivacyError> for alloy::transports::TransportError {
    fn from(value: PrivacyError) -> Self {
        alloy::transports::TransportErrorKind::custom(RpcErr(value))
    }
}

#[derive(Debug)]
struct RpcErr(PrivacyError);

impl fmt::Display for RpcErr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for RpcErr {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}
