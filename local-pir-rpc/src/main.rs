mod clearnet_pir;
mod ports;
mod server;
mod stealth;
mod tor_pir_client;

use std::sync::Arc;

use clap::Parser;
use clearnet_pir::{ClearnetPirLookup, KeyMode as ClearnetKeyMode};
use kohaku_pir_rpc::{PirRouter, PirTransport};
use kohaku_privacy_rpc::{CachingAsyncLookup, PrivacyBuilder};
use server::Backend;
use tor_pir_client::{KeyMode as TorKeyMode, TorPirClientLookup, DEFAULT_POOL_SIZE};
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(
    name = "local-pir-rpc",
    about = "localhost JSON-RPC facade: Tor+PIR (default) or clearnet pir-rpc"
)]
struct Args {
    /// Bind address for the Ethereum JSON-RPC HTTP server.
    #[arg(long, default_value = "127.0.0.1:8545")]
    listen: String,

    /// Account PIR HTTP base URL, with an explicit port (e.g. `http://host:18090`).
    /// Tokens are the same URL at port+1, primary names at port+2.
    #[arg(long, env = "PIR_URL")]
    pir_url: String,

    /// Fallback Ethereum JSON-RPC URL.
    #[arg(long, env = "ETH_RPC_URL")]
    rpc_url: String,

    /// Concurrent PIR client pool size (per PIR server).
    #[arg(long, env = "PIR_POOL_SIZE", default_value_t = DEFAULT_POOL_SIZE)]
    pir_pool_size: usize,

    /// Disable Tor: PIR and fallback RPC go clearnet via `kohaku-pir-rpc` only.
    /// Default (flag unset): all egress via Tor (`kohaku-privacy-rpc`).
    #[arg(long, default_value_t = false)]
    without_tor: bool,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();
    if args.pir_url.trim().is_empty() {
        error!("--pir-url / PIR_URL is required");
        std::process::exit(1);
    }
    if args.rpc_url.trim().is_empty() {
        error!("--rpc-url / ETH_RPC_URL is required");
        std::process::exit(1);
    }

    let urls = match ports::derive_pir_urls(&args.pir_url) {
        Ok(urls) => urls,
        Err(e) => {
            error!(error = %e, "PIR URL");
            std::process::exit(1);
        }
    };

    let backend = if args.without_tor {
        build_clearnet(&args, &urls)
    } else {
        build_tor(&args, &urls).await
    };

    let app = axum::Router::new()
        .route("/", axum::routing::post(server::handle_rpc))
        .with_state(backend);

    let listener = match tokio::net::TcpListener::bind(&args.listen).await {
        Ok(l) => l,
        Err(e) => {
            error!(error = %e, listen = %args.listen, "bind failed");
            std::process::exit(1);
        }
    };
    info!(
        listen = %args.listen,
        accounts = %urls.accounts,
        tokens = %urls.tokens,
        names = %urls.names,
        fallback = %args.rpc_url,
        without_tor = args.without_tor,
        pir_pool_size = args.pir_pool_size,
        "local-pir-rpc listening"
    );

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        error!(error = %e, "server exited with error");
        std::process::exit(1);
    }
}

fn build_clearnet(args: &Args, urls: &ports::PirUrls) -> Arc<Backend> {
    info!(
        accounts = %urls.accounts,
        tokens = %urls.tokens,
        names = %urls.names,
        pool = args.pir_pool_size,
        "clearnet mode: connecting PirClient pools (no Tor)"
    );
    let accounts = connect_clearnet(&urls.accounts, args.pir_pool_size, ClearnetKeyMode::Account);
    let tokens = connect_clearnet(&urls.tokens, args.pir_pool_size, ClearnetKeyMode::Storage);
    let names = connect_clearnet(&urls.names, args.pir_pool_size, ClearnetKeyMode::Names);

    let router = match PirRouter::with_rpc_lanes(
        accounts,
        Some(tokens),
        Some(names),
        &args.rpc_url,
        Vec::new(),
    ) {
        Ok(r) => Arc::new(r),
        Err(e) => {
            error!(error = %e, "PirRouter::with_rpc_lanes failed");
            std::process::exit(1);
        }
    };
    Arc::new(Backend::Clearnet(PirTransport::new(router)))
}

fn connect_clearnet(
    url: &str,
    pool: usize,
    mode: ClearnetKeyMode,
) -> Arc<dyn kohaku_pir_rpc::LookupBackend> {
    match ClearnetPirLookup::connect_with_mode(url, pool, mode) {
        Ok(lookup) => {
            info!(pool = lookup.pool_size(), %url, ?mode, "clearnet PIR pool ready");
            lookup
        }
        Err(e) => {
            error!(error = %e, %url, ?mode, "PirClient::connect failed");
            std::process::exit(1);
        }
    }
}

async fn build_tor(args: &Args, urls: &ports::PirUrls) -> Arc<Backend> {
    info!("bootstrapping Tor (Arti)…");
    let tor = match kohaku_tor_rpc::TorRpc::connect().await {
        Ok(t) => t,
        Err(e) => {
            error!(error = %e, "Tor bootstrap failed");
            std::process::exit(1);
        }
    };
    info!("Tor ready");

    info!(
        accounts = %urls.accounts,
        tokens = %urls.tokens,
        names = %urls.names,
        pool = args.pir_pool_size,
        "connecting PIR pools over Tor"
    );
    let accounts = connect_tor(
        tor.clone(),
        &urls.accounts,
        args.pir_pool_size,
        TorKeyMode::Account,
    )
    .await;
    let tokens = connect_tor(
        tor.clone(),
        &urls.tokens,
        args.pir_pool_size,
        TorKeyMode::Storage,
    )
    .await;
    let names = connect_tor(
        tor.clone(),
        &urls.names,
        args.pir_pool_size,
        TorKeyMode::Names,
    )
    .await;

    let transport = match PrivacyBuilder::new(&args.rpc_url) {
        Ok(builder) => builder
            .tor(tor)
            .pir_lookup(accounts, Some(tokens), Some(names), Vec::new())
            .build_transport(),
        Err(e) => Err(e),
    };
    match transport {
        Ok(t) => Arc::new(Backend::Tor(t)),
        Err(e) => {
            error!(error = %e, "PrivacyBuilder failed");
            std::process::exit(1);
        }
    }
}

async fn connect_tor(
    tor: kohaku_tor_rpc::TorRpc,
    url: &str,
    pool: usize,
    mode: TorKeyMode,
) -> Arc<dyn kohaku_privacy_rpc::AsyncLookupBackend> {
    match TorPirClientLookup::connect_with_mode(tor, url, pool, mode).await {
        Ok(lookup) => {
            info!(pool = lookup.pool_size(), %url, ?mode, "Tor PIR pool ready");
            CachingAsyncLookup::with_default_ttl(lookup)
        }
        Err(e) => {
            error!(error = %e, %url, ?mode, "PIR manifest over Tor failed");
            std::process::exit(1);
        }
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("shutting down");
}
