//! CLI for private lookups against a pir-server.
//!
//!   pir-client --server http://host:8080 lookup 0xADDRESS
//!   pir-client --server http://host:8080 synthetic 12345
//!   pir-client --server http://host:8080 canary
//!   pir-client --server http://host:8080 manifest
//!   pir-client --server http://host:8081 tokens 0xHOLDER   (a storage server)
//!   pir-client --server http://host:8092 names 0xADDRESS   (a name server)

use clap::{Parser, Subcommand};
use pir_client::{parse_account_value, PirClient, Source, TOKENS};
use pir_keyword::cuckoo::address_from_index;
use pir_keyword::names::{NameEntry, NameSystem};
use std::time::Instant;

#[derive(Parser)]
#[command(name = "pir-client", about = "Private lookups against a pir-server")]
struct Cli {
    /// Server base URL, e.g. http://127.0.0.1:8080
    #[clap(long)]
    server: String,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Look up an Ethereum address (0x... 20 bytes).
    Lookup { address: String },
    /// Look up synthetic account i (address = SHAKE-256(i), for demo DBs).
    Synthetic { index: usize },
    /// Retrieve the canary: which snapshot block is this server answering from?
    Canary,
    /// Print the current generation manifest.
    Manifest,
    /// Look up an address's balances of every token a storage server holds
    /// (USDC, USDT, DAI, WETH), always all of them.
    Tokens { holder: String },
    /// Look up an address's ENS, GNS and WNS primary names, and its stealth
    /// meta-address from the ERC-6538 registry (a name server).
    Names { address: String },
}

fn main() {
    let cli = Cli::parse();
    let mut client = PirClient::connect(&cli.server).unwrap_or_else(|e| {
        eprintln!("connect failed: {}", e);
        std::process::exit(1);
    });

    match cli.cmd {
        Cmd::Manifest => {
            println!("{}", client.manifest.to_json());
        }
        Cmd::Canary => {
            let t0 = Instant::now();
            match client.canary_block().unwrap_or_else(die) {
                Some(block) => println!(
                    "canary: serving snapshot of block #{} ({:.0} ms)",
                    block,
                    t0.elapsed().as_secs_f64() * 1e3
                ),
                None => println!("canary entry not found (server without canary?)"),
            }
        }
        Cmd::Lookup { address } => {
            let key = parse_address(&address);
            run_lookup(&mut client, &key);
        }
        Cmd::Tokens { holder } => {
            let holder = parse_address(&holder);
            for token in TOKENS {
                let t0 = Instant::now();
                let found = client.token_balance(&token, &holder).unwrap_or_else(die);
                let ms = t0.elapsed().as_secs_f64() * 1e3;
                let source = match found.source {
                    Some(Source::Snapshot { block }) => format!("PIR (snapshot block #{block})"),
                    Some(Source::Sidecar { block }) => format!("sidecar (block #{block})"),
                    None => format!("empty slot (snapshot block #{})", client.last_snapshot_block),
                };
                println!(
                    "{:<5} {:>28}  {}, {:.0} ms",
                    token.symbol,
                    format_units(&found.balance, token.decimals),
                    source,
                    ms
                );
            }
        }
        Cmd::Names { address } => {
            let address = parse_address(&address);
            let t0 = Instant::now();
            let found = client.names(&address).unwrap_or_else(die);
            let ms = t0.elapsed().as_secs_f64() * 1e3;
            for system in NameSystem::ALL {
                let shown = match found.names.get(system) {
                    Some(NameEntry::Name(n)) => {
                        // Its stealth text record came with the lookup too.
                        let text = client.stealth_text_of(n).unwrap_or_else(die);
                        if text.is_empty() {
                            n.clone()
                        } else {
                            format!("{n}  (stealth-address-scheme-1: {text})")
                        }
                    }
                    Some(NameEntry::TooLong) => "(a name too long for the table)".into(),
                    None => "-".into(),
                };
                println!("{:<4} {}", system.label(), shown);
            }
            // The registry came whole with the lookup, so this asks nothing more.
            let meta = client.stealth_meta_address_of(&address, 1).unwrap_or_else(die);
            if meta.is_empty() {
                println!("stealth meta-address (ERC-6538, scheme 1): -");
            } else {
                println!("stealth meta-address (ERC-6538, scheme 1): 0x{}", hex::encode(meta));
            }
            match found.source {
                Some(Source::Snapshot { block }) => println!("source: PIR (snapshot block #{block}), {ms:.0} ms"),
                Some(Source::Sidecar { block }) => println!("source: sidecar (block #{block}), {ms:.0} ms"),
                None => println!(
                    "source: no entry (proven at snapshot block #{}), {ms:.0} ms",
                    client.last_snapshot_block
                ),
            }
        }
        Cmd::Synthetic { index } => {
            let key = address_from_index(index);
            println!("address: 0x{}", hex::encode(&key));
            run_lookup(&mut client, &key);
        }
    }
}

fn run_lookup(client: &mut PirClient, address: &[u8]) {
    let t0 = Instant::now();
    match client.lookup_address(address).unwrap_or_else(die) {
        Some(l) => {
            let ms = t0.elapsed().as_secs_f64() * 1e3;
            match parse_account_value(&l.value) {
                Some(a) => {
                    println!("balance: {} wei\nnonce:   {}", a.balance, a.nonce);
                    match a.delegate {
                        Some(d) => println!("code:    0x{} (delegates to 0x{})", hex::encode(a.code()), hex::encode(d)),
                        None => println!("code:    none (if an EOA)"),
                    }
                }
                None => println!("value: 0x{}", hex::encode(&l.value)),
            }
            match l.source {
                Source::Snapshot { block } => println!(
                    "source:  PIR (snapshot block #{}), {:.0} ms",
                    block, ms
                ),
                Source::Sidecar { block } => {
                    println!("source:  sidecar broadcast (block #{}), {:.0} ms", block, ms)
                }
            }
        }
        None => {
            println!(
                "not found (proven non-membership at snapshot block #{}), {:.0} ms",
                client.last_snapshot_block,
                t0.elapsed().as_secs_f64() * 1e3
            );
        }
    }
}

fn parse_address(s: &str) -> [u8; 20] {
    let bytes = hex::decode(s.strip_prefix("0x").unwrap_or(s)).unwrap_or_else(|e| {
        eprintln!("bad address hex: {}", e);
        std::process::exit(1);
    });
    bytes.try_into().unwrap_or_else(|b: Vec<u8>| {
        eprintln!("an address is 20 bytes, got {}", b.len());
        std::process::exit(1);
    })
}

/// A big-endian amount in whole units, e.g. 1500000 at 6 decimals is "1.5".
fn format_units(amount: &[u8; 32], decimals: u32) -> String {
    if amount[..16].iter().any(|&b| b != 0) {
        return format!("0x{}", hex::encode(amount));
    }
    let raw = u128::from_be_bytes(amount[16..].try_into().unwrap());
    let unit = 10u128.pow(decimals);
    let fraction = format!("{:0width$}", raw % unit, width = decimals as usize);
    let fraction = fraction.trim_end_matches('0');
    if fraction.is_empty() {
        format!("{}", raw / unit)
    } else {
        format!("{}.{}", raw / unit, fraction)
    }
}

fn die<T>(e: String) -> T {
    eprintln!("error: {}", e);
    std::process::exit(1);
}
