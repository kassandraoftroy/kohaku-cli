use async_trait::async_trait;
use serde_json::Value;

use crate::PrivacyError;

/// Optional post-fetch (or rewrite) hook for lightclients (Helios, Colibri).
///
/// Reserved for a later milestone; the orchestrator holds an
/// `Option<Arc<dyn StateVerifier>>` so combinations do not need new types.
#[async_trait]
pub trait StateVerifier: Send + Sync {
    /// Validate or transform a successful JSON-RPC result.
    async fn verify(
        &self,
        method: &str,
        params: &Value,
        result: Value,
    ) -> Result<Value, PrivacyError>;
}
