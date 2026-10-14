use std::sync::{Mutex, PoisonError};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::PirProviderError;

/// JSON-RPC fallback used for methods PIR cannot serve.
#[async_trait]
pub trait FallbackRpc: Send + Sync {
    /// Call `method` with `params` on the fallback endpoint.
    async fn request(&self, method: &str, params: Value) -> Result<Value, PirProviderError>;
}

/// HTTP JSON-RPC 2.0 client.
pub struct HttpFallback {
    client: reqwest::Client,
    url: reqwest::Url,
}

impl HttpFallback {
    /// Create a fallback client targeting `url`.
    ///
    /// # Errors
    ///
    /// Returns [`PirProviderError::InvalidUrl`] if `url` is not a valid HTTP URL.
    pub fn new(url: &str) -> Result<Self, PirProviderError> {
        let url =
            reqwest::Url::parse(url).map_err(|e| PirProviderError::InvalidUrl(e.to_string()))?;
        Ok(Self {
            client: reqwest::Client::new(),
            url,
        })
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RpcResponse {
    Success { result: Value },
    Failure { error: RpcErrorBody },
}

#[derive(Deserialize)]
struct RpcErrorBody {
    code: i64,
    message: String,
}

#[async_trait]
impl FallbackRpc for HttpFallback {
    async fn request(&self, method: &str, params: Value) -> Result<Value, PirProviderError> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });
        let text = self
            .client
            .post(self.url.clone())
            .json(&body)
            .send()
            .await?
            .text()
            .await?;
        match serde_json::from_str(&text)? {
            RpcResponse::Success { result } => Ok(result),
            RpcResponse::Failure { error } => Err(PirProviderError::Rpc {
                code: error.code,
                message: error.message,
            }),
        }
    }
}

/// In-memory fallback for tests. Records calls and returns scripted results.
#[derive(Default)]
pub struct MapFallback {
    /// `method → result` map. Missing methods return `"0x"`.
    pub responses: Mutex<std::collections::HashMap<String, Value>>,
    /// Recorded `(method, params)` pairs, oldest first.
    pub calls: Mutex<Vec<(String, Value)>>,
}

impl MapFallback {
    /// Script `method` to return `result`.
    pub fn set(&self, method: impl Into<String>, result: Value) {
        self.responses
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(method.into(), result);
    }

    /// Methods invoked so far.
    #[must_use]
    pub fn called_methods(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|(m, _)| m.clone())
            .collect()
    }
}

#[async_trait]
impl FallbackRpc for MapFallback {
    async fn request(&self, method: &str, params: Value) -> Result<Value, PirProviderError> {
        self.calls
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((method.to_string(), params));
        Ok(self
            .responses
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(method)
            .cloned()
            .unwrap_or(Value::String("0x".into())))
    }
}
