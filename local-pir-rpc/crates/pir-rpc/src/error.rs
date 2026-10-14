use std::fmt;

/// Errors from the hybrid PIR / JSON-RPC router.
#[derive(Debug, thiserror::Error)]
pub enum PirProviderError {
    /// Blocking PIR lookup / connect task panicked.
    #[error("PIR worker task failed: {0}")]
    Join(#[from] tokio::task::JoinError),
    /// Lookup backend failed (connect, lookup, extract).
    #[error("PIR client: {0}")]
    Client(String),
    /// Fallback HTTP failed.
    #[error("fallback RPC HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    /// JSON (de)serialization failed.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// The fallback node returned a JSON-RPC error object.
    #[error("RPC error {code}: {message}")]
    Rpc {
        /// JSON-RPC error code.
        code: i64,
        /// JSON-RPC error message.
        message: String,
    },
    /// Method params were the wrong shape for a PIR-routed call.
    #[error("invalid params: {0}")]
    InvalidParams(String),
    /// Fallback URL could not be parsed.
    #[error("invalid RPC URL: {0}")]
    InvalidUrl(String),
    /// Alloy transport failed to start.
    #[error("transport: {0}")]
    Transport(String),
}

impl PirProviderError {
    /// JSON-RPC error code for this failure (`-32602` params, `-32603` else).
    #[must_use]
    pub const fn rpc_code(&self) -> i64 {
        match self {
            Self::InvalidParams(_) => -32602,
            Self::Rpc { code, .. } => *code,
            _ => -32603,
        }
    }
}

impl From<PirProviderError> for alloy::transports::TransportError {
    fn from(value: PirProviderError) -> Self {
        alloy::transports::TransportErrorKind::custom(RpcErr(value))
    }
}

#[derive(Debug)]
struct RpcErr(PirProviderError);

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
