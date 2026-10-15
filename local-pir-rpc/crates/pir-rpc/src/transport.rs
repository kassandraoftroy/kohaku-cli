use std::{borrow::Cow, sync::Arc, task};

use alloy::{
    rpc::json_rpc::{
        ErrorPayload, RequestPacket, Response, ResponsePacket, ResponsePayload, SerializedRequest,
    },
    transports::{
        BoxTransport, TransportConnect, TransportError, TransportErrorKind, TransportFut,
    },
};
use serde_json::{Value, value::RawValue};
use tower::Service;

use crate::{CallPath, CallTrace, PirProviderError, PirRouter};

/// Alloy transport that dispatches each JSON-RPC item through [`PirRouter`].
#[derive(Clone)]
pub struct PirTransport {
    router: Arc<PirRouter>,
}

impl PirTransport {
    /// Wrap an existing router.
    #[must_use]
    pub const fn new(router: Arc<PirRouter>) -> Self {
        Self { router }
    }

    /// Underlying hybrid router (classify / plan).
    #[must_use]
    pub fn router(&self) -> &PirRouter {
        &self.router
    }

    /// Dispatch a packet and report the path that answered each call.
    ///
    /// # Errors
    ///
    /// Returns when a request cannot be serialized into a transport response.
    pub async fn call_logged(
        &self,
        req: RequestPacket,
    ) -> Result<(ResponsePacket, Vec<CallTrace>), alloy::transports::TransportError> {
        self.clone().handle(req).await
    }

    async fn handle(
        self,
        req: RequestPacket,
    ) -> Result<(ResponsePacket, Vec<CallTrace>), alloy::transports::TransportError> {
        match req {
            RequestPacket::Single(req) => {
                let (resp, trace) = self.map_request(req).await?;
                Ok((ResponsePacket::Single(resp), vec![trace]))
            }
            RequestPacket::Batch(reqs) => {
                let mut out = Vec::with_capacity(reqs.len());
                let mut traces = Vec::with_capacity(reqs.len());
                for req in reqs {
                    let (resp, trace) = self.map_request(req).await?;
                    out.push(resp);
                    traces.push(trace);
                }
                Ok((ResponsePacket::Batch(out), traces))
            }
        }
    }

    async fn map_request(
        &self,
        req: SerializedRequest,
    ) -> Result<(alloy::rpc::json_rpc::Response, CallTrace), alloy::transports::TransportError>
    {
        let method = req.method().to_string();
        let params = req
            .params()
            .map(|raw| serde_json::from_str(raw.get()))
            .transpose()
            .map_err(TransportErrorKind::custom)?
            .unwrap_or(Value::Array(Vec::new()));
        let id = req.id().clone();
        let trace_method = method.clone();
        match self.router.request_with_path(&method, params).await {
            Ok((value, path)) => Ok((
                Response {
                    id,
                    payload: ResponsePayload::Success(to_raw(&value)?),
                },
                CallTrace {
                    method: trace_method,
                    path,
                },
            )),
            Err(PirProviderError::Rpc { code, message }) => Ok((
                Response {
                    id,
                    payload: ResponsePayload::Failure(ErrorPayload {
                        code,
                        message: Cow::Owned(message),
                        data: None,
                    }),
                },
                CallTrace {
                    method: trace_method,
                    path: CallPath::Fallback,
                },
            )),
            Err(e) => Ok((
                Response {
                    id,
                    payload: ResponsePayload::Failure(ErrorPayload {
                        code: e.rpc_code(),
                        message: Cow::Owned(e.to_string()),
                        data: None,
                    }),
                },
                CallTrace {
                    method: trace_method,
                    path: CallPath::Fallback,
                },
            )),
        }
    }
}

fn to_raw(value: &Value) -> Result<Box<RawValue>, TransportError> {
    let s = serde_json::to_string(value).map_err(TransportErrorKind::custom)?;
    RawValue::from_string(s).map_err(TransportErrorKind::custom)
}

impl Service<RequestPacket> for PirTransport {
    type Response = ResponsePacket;
    type Error = TransportError;
    type Future = TransportFut<'static>;

    fn poll_ready(&mut self, _cx: &mut task::Context<'_>) -> task::Poll<Result<(), Self::Error>> {
        task::Poll::Ready(Ok(()))
    }

    fn call(&mut self, req: RequestPacket) -> Self::Future {
        let transport = self.clone();
        Box::pin(async move { transport.handle(req).await.map(|(packet, _)| packet) })
    }
}

/// [`TransportConnect`] wrapper so [`ProviderBuilder::connect_with`] works.
#[derive(Clone)]
pub struct PirConnect {
    router: Arc<PirRouter>,
}

impl PirConnect {
    /// Connect using an already-built router.
    #[must_use]
    pub const fn new(router: Arc<PirRouter>) -> Self {
        Self { router }
    }
}

impl TransportConnect for PirConnect {
    fn is_local(&self) -> bool {
        true
    }

    async fn get_transport(&self) -> Result<BoxTransport, TransportError> {
        Ok(BoxTransport::new(PirTransport::new(Arc::clone(
            &self.router,
        ))))
    }
}

/// Build a type-erased alloy provider from a lookup backend and fallback RPC.
///
/// # Errors
///
/// Returns [`PirProviderError`] if the fallback URL is invalid or the alloy
/// transport fails to start.
pub async fn connect_provider(
    lookup: Arc<dyn crate::LookupBackend>,
    rpc_url: &str,
    datasets: Vec<crate::DatasetManifest>,
) -> Result<alloy::providers::DynProvider, PirProviderError> {
    let router = Arc::new(PirRouter::with_rpc(lookup, rpc_url, datasets)?);
    alloy::providers::ProviderBuilder::default()
        .connect_with(&PirConnect::new(router))
        .await
        .map(alloy::providers::Provider::erased)
        .map_err(|e| PirProviderError::Transport(e.to_string()))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use alloy::{
        primitives::Address,
        providers::{Provider, ProviderBuilder},
    };
    use serde_json::json;

    use super::*;
    use crate::{MapFallback, MapLookup, PirRouter};

    fn account_bytes(balance: u128, nonce: u64) -> Vec<u8> {
        let mut v = vec![0u8; 40];
        let be = balance.to_be_bytes();
        v[20..32].copy_from_slice(&be[4..]);
        v[32..40].copy_from_slice(&nonce.to_be_bytes());
        v
    }

    #[tokio::test]
    async fn alloy_get_balance_hits_pir() {
        let lookup = MapLookup::default();
        let mut addr_bytes = [0u8; 20];
        addr_bytes[19] = 7;
        lookup.insert(addr_bytes, account_bytes(99, 1));
        let fallback = MapFallback::default();
        fallback.set("eth_chainId", json!("0x1"));
        fallback.set("eth_getBalance", json!("0xdead"));
        let router = Arc::new(PirRouter::mock(lookup, fallback, Vec::new()));
        let provider: alloy::providers::DynProvider = ProviderBuilder::default()
            .connect_with(&PirConnect::new(router))
            .await
            .unwrap()
            .erased();
        let bal = provider
            .get_balance(Address::from(addr_bytes))
            .await
            .unwrap();
        assert_eq!(bal, alloy::primitives::U256::from(99u64));
    }
}
