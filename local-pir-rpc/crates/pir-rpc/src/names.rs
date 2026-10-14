//! Primary-name `eth_call`s (ENS, GNS, WNS) answered from one names-table value.
//!
//! The value is `[system][length][utf-8]` records in ENS, GNS, WNS order. A
//! system byte with the top bit set and length 0 means the name did not fit.

use alloy::primitives::keccak256;
use serde_json::Value;

use crate::PirProviderError;

/// ENS Universal Resolver. `reverseWithGateways` / `resolveWithGateways`.
const UNIVERSAL_RESOLVER: [u8; 20] = [
    0xee, 0xee, 0xee, 0xee, 0x14, 0xd7, 0x18, 0xc2, 0xb4, 0x7d, 0x99, 0x23, 0xde, 0xab, 0x13, 0x35,
    0xe1, 0x44, 0xee, 0xee,
];
/// GNS registry (`*.gwei`).
const GNS: [u8; 20] = [
    0x9d, 0x51, 0xd5, 0x07, 0xbc, 0x72, 0x64, 0xd4, 0xfe, 0x8a, 0xd1, 0xcf, 0x7f, 0xe1, 0x91, 0x93,
    0x3a, 0x0a, 0x81, 0xd6,
];
/// WNS registry (`*.wei`).
const WNS: [u8; 20] = [
    0x00, 0x00, 0x00, 0x00, 0x00, 0x69, 0x67, 0x60, 0xe1, 0x5f, 0x26, 0x5e, 0x82, 0x8d, 0xb6, 0x44,
    0xa0, 0xc2, 0x42, 0xeb,
];

const REVERSE_WITH_GATEWAYS: [u8; 4] = [0xb7, 0xd6, 0xca, 0x64];
const RESOLVE_WITH_GATEWAYS: [u8; 4] = [0xa1, 0x47, 0x28, 0x44];
const REVERSE_RESOLVE: [u8; 4] = [0x9a, 0xf8, 0xb7, 0xaa];
const COMPUTE_ID: [u8; 4] = [0xfb, 0x02, 0x19, 0x39];
const RESOLVE: [u8; 4] = [0x4f, 0x89, 0x6d, 0x4f];
/// `addr(bytes32)` inside `resolveWithGateways` calldata.
const ADDR_SELECTOR: [u8; 4] = [0x3b, 0x3b, 0x57, 0xde];
/// `text(bytes32,string)` inside `resolveWithGateways`, and the same selector
/// is not used on GNS/WNS (`text(uint256,string)` is [`TEXT_UINT`]).
const TEXT_BYTES32: [u8; 4] = [0x59, 0xd1, 0xd4, 0x3c];
/// `text(uint256,string)` on GNS and WNS.
const TEXT_UINT: [u8; 4] = [0x30, 0x8e, 0x33, 0x86];
/// `stealthMetaAddressOf(address,uint256)` on the ERC-6538 registry.
const STEALTH_META: [u8; 4] = [0x7a, 0xa8, 0xb5, 0xad];
/// ERC-6538 registry.
const ERC6538: [u8; 20] = [
    0x65, 0x38, 0xe6, 0xbf, 0x4b, 0x0e, 0xbd, 0x30, 0xa8, 0xea, 0x09, 0x30, 0x27, 0xac, 0x24, 0x22,
    0xce, 0x5d, 0x65, 0x38,
];
/// Only this text key is answered from the names sidecar.
const STEALTH_TEXT_KEY: &str = "stealth-address-scheme-1";

const TOO_LONG: u8 = 0x80;

/// Which naming system a record or call belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NameSystem {
    /// ENS (`*.eth`), system byte 1.
    Ens = 1,
    /// GNS (`*.gwei`), system byte 2.
    Gns = 2,
    /// WNS (`*.wei`), system byte 3.
    Wns = 3,
}

impl NameSystem {
    fn from_byte(b: u8) -> Option<Self> {
        match b {
            1 => Some(Self::Ens),
            2 => Some(Self::Gns),
            3 => Some(Self::Wns),
            _ => None,
        }
    }

    fn all() -> [Self; 3] {
        [Self::Ens, Self::Gns, Self::Wns]
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum NameEntry {
    Name(String),
    TooLong,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Names {
    ens: Option<NameEntry>,
    gns: Option<NameEntry>,
    wns: Option<NameEntry>,
}

impl Names {
    fn get(&self, system: NameSystem) -> Option<&NameEntry> {
        match system {
            NameSystem::Ens => self.ens.as_ref(),
            NameSystem::Gns => self.gns.as_ref(),
            NameSystem::Wns => self.wns.as_ref(),
        }
    }

    fn set(&mut self, system: NameSystem, entry: NameEntry) {
        let slot = match system {
            NameSystem::Ens => &mut self.ens,
            NameSystem::Gns => &mut self.gns,
            NameSystem::Wns => &mut self.wns,
        };
        *slot = Some(entry);
    }

    fn unpack(value: &[u8]) -> Result<Self, String> {
        let mut names = Self::default();
        let mut at = 0;
        while at + 2 <= value.len() && value[at] != 0 {
            let tag = value[at];
            let len = value[at + 1] as usize;
            let system = NameSystem::from_byte(tag & !TOO_LONG)
                .ok_or_else(|| format!("unknown name system byte 0x{tag:02x}"))?;
            let entry = if tag & TOO_LONG != 0 {
                NameEntry::TooLong
            } else {
                let bytes = value
                    .get(at + 2..at + 2 + len)
                    .ok_or("name runs past the end of the value")?;
                NameEntry::Name(String::from_utf8(bytes.to_vec()).map_err(|_| "name is not UTF-8")?)
            };
            names.set(system, entry);
            at += 2 + if tag & TOO_LONG != 0 { 0 } else { len };
        }
        Ok(names)
    }
}

/// A forward check that can be answered from a name we already returned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NameForward {
    /// `resolve(uint256)` on GNS or WNS.
    TokenId {
        /// GNS or WNS.
        system: NameSystem,
        /// `computeId` / namehash of the name.
        token_id: [u8; 32],
    },
    /// `resolveWithGateways` on the Universal Resolver for an ENS name.
    EnsName {
        /// Lowercased DNS name from the calldata.
        name: String,
    },
}

/// An `eth_call` the names table (or a local namehash) can answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ClassifiedName {
    /// Reverse lookup. The key is the address.
    Reverse {
        /// Which system's name to return.
        system: NameSystem,
        /// Address inside the call.
        address: [u8; 20],
    },
    /// `computeId(string)` — pure, no lookup.
    Namehash {
        /// Name argument, as passed.
        name: String,
    },
    /// Forward resolution of a name this middleware already served.
    Forward(NameForward),
    /// `stealthMetaAddressOf(registrant, schemeId)` on the ERC-6538 registry.
    ///
    /// `scheme_id` is `None` when the calldata integer does not fit in `u64`
    /// and therefore cannot be in the registry.
    StealthMeta {
        /// Registrant argument.
        registrant: [u8; 20],
        /// Scheme id, when it fits in `u64`.
        scheme_id: Option<u64>,
    },
    /// `text(..., "stealth-address-scheme-1")` on ENS, GNS, or WNS.
    StealthText {
        /// Which resolver the call is on.
        system: NameSystem,
        /// Namehash (ENS node or GNS/WNS token id).
        node: [u8; 32],
    },
}

/// A real name found in a value, remembered so the follow-up forward call
/// does not go to the RPC.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RememberedName {
    /// System the name belongs to.
    pub system: NameSystem,
    /// Name text from the table.
    pub name: String,
    /// Address the lookup was for.
    pub address: [u8; 20],
}

/// Match a names `eth_call`. `None` means this call is not a primary-name read.
#[must_use]
pub fn match_name_call(to: &[u8; 20], data: &[u8]) -> Option<ClassifiedName> {
    if data.len() < 4 {
        return None;
    }
    let selector: [u8; 4] = data[..4].try_into().ok()?;
    if selector == REVERSE_WITH_GATEWAYS && *to == UNIVERSAL_RESOLVER {
        let coin = abi_word(data, 1)?;
        if !word_is_u64(&coin, 60) {
            return None;
        }
        let bytes = abi_dyn_bytes(data, 0)?;
        let address = address_from_reverse_bytes(&bytes)?;
        return Some(ClassifiedName::Reverse {
            system: NameSystem::Ens,
            address,
        });
    }
    if selector == RESOLVE_WITH_GATEWAYS && *to == UNIVERSAL_RESOLVER {
        return match_resolve_gateways(data);
    }
    if selector == STEALTH_META && *to == ERC6538 {
        let registrant = arg0_address(data)?;
        let scheme_word = abi_word(data, 1)?;
        return Some(ClassifiedName::StealthMeta {
            registrant,
            scheme_id: word_as_u64(&scheme_word),
        });
    }
    let system = if *to == GNS {
        NameSystem::Gns
    } else if *to == WNS {
        NameSystem::Wns
    } else {
        return None;
    };
    if selector == REVERSE_RESOLVE {
        let address = arg0_address(data)?;
        return Some(ClassifiedName::Reverse { system, address });
    }
    if selector == COMPUTE_ID {
        let name = abi_string(data)?;
        return Some(ClassifiedName::Namehash { name });
    }
    if selector == RESOLVE {
        let token_id = abi_word(data, 0)?;
        return Some(ClassifiedName::Forward(NameForward::TokenId {
            system,
            token_id,
        }));
    }
    if selector == TEXT_UINT {
        if abi_string_at(data, 1)?.as_str() != STEALTH_TEXT_KEY {
            return None;
        }
        let node = abi_word(data, 0)?;
        return Some(ClassifiedName::StealthText { system, node });
    }
    None
}

fn match_resolve_gateways(data: &[u8]) -> Option<ClassifiedName> {
    let inner = abi_dyn_bytes(data, 1)?;
    if inner.len() < 4 {
        return None;
    }
    if inner[..4] == ADDR_SELECTOR {
        let packet = abi_dyn_bytes(data, 0)?;
        let name = dns_name(&packet)?.to_ascii_lowercase();
        if name.is_empty() {
            return None;
        }
        return Some(ClassifiedName::Forward(NameForward::EnsName { name }));
    }
    if inner[..4] == TEXT_BYTES32 && abi_string_at(&inner, 1)?.as_str() == STEALTH_TEXT_KEY {
        let node = abi_word(&inner, 0)?;
        return Some(ClassifiedName::StealthText {
            system: NameSystem::Ens,
            node,
        });
    }
    None
}

/// ENS namehash after ASCII lowercasing.
#[must_use]
pub fn namehash(name: &str) -> [u8; 32] {
    let name = name.trim_matches('.').to_ascii_lowercase();
    let mut node = [0u8; 32];
    if name.is_empty() {
        return node;
    }
    for label in name.rsplit('.') {
        let label_hash = keccak256(label.as_bytes());
        let mut packed = [0u8; 64];
        packed[..32].copy_from_slice(&node);
        packed[32..].copy_from_slice(label_hash.as_slice());
        node.copy_from_slice(keccak256(packed).as_slice());
    }
    node
}

/// JSON-RPC result for `computeId`.
#[must_use]
pub fn encode_namehash_result(name: &str) -> Value {
    encode_hex(&namehash(name))
}

/// Decode a names-table value for one reverse call.
///
/// A real name is returned ABI-encoded and listed in `remember` (every system
/// in the value, not only the one asked). [`NameEntry::TooLong`] for the asked
/// system is `NeedsFallback` so the original `eth_call` can go to the RPC.
///
/// # Errors
///
/// Returns [`PirProviderError::Client`] when the value is not a name record.
pub fn decode_name_reverse(
    system: NameSystem,
    address: [u8; 20],
    raw: Option<&[u8]>,
) -> Result<(crate::plan::Decoded, Vec<RememberedName>), PirProviderError> {
    let Some(raw) = raw else {
        return Ok((
            crate::plan::Decoded::Value(encode_reverse(system, "")),
            Vec::new(),
        ));
    };
    let names = Names::unpack(raw).map_err(PirProviderError::Client)?;
    let mut remember = Vec::new();
    for sys in NameSystem::all() {
        if let Some(NameEntry::Name(name)) = names.get(sys) {
            remember.push(RememberedName {
                system: sys,
                name: name.clone(),
                address,
            });
        }
    }
    match names.get(system) {
        Some(NameEntry::TooLong) => Ok((crate::plan::Decoded::NeedsFallback, remember)),
        Some(NameEntry::Name(name)) => Ok((
            crate::plan::Decoded::Value(encode_reverse(system, name)),
            remember,
        )),
        None => Ok((
            crate::plan::Decoded::Value(encode_reverse(system, "")),
            remember,
        )),
    }
}

/// ABI result for a cached forward resolution.
#[must_use]
pub fn encode_forward(forward: &NameForward, address: &[u8; 20]) -> Value {
    match forward {
        NameForward::TokenId { .. } => encode_hex(&address_word(address)),
        NameForward::EnsName { .. } => encode_hex(&encode_bytes_and_address(address)),
    }
}

fn encode_reverse(system: NameSystem, name: &str) -> Value {
    let bytes = match system {
        NameSystem::Ens => encode_string_two_addresses(name),
        NameSystem::Gns | NameSystem::Wns => encode_abi_string(name),
    };
    encode_hex(&bytes)
}

fn encode_hex(bytes: &[u8]) -> Value {
    Value::String(format!("0x{}", hex::encode(bytes)))
}

/// ABI `bytes` result for `stealthMetaAddressOf`.
#[must_use]
pub(crate) fn encode_stealth_meta_result(meta: &[u8]) -> Value {
    encode_hex(&encode_dynamic_bytes(meta))
}

/// ABI result for a `stealth-address-scheme-1` text call.
#[must_use]
pub(crate) fn encode_stealth_text_result(system: NameSystem, value: &str) -> Value {
    let bytes = match system {
        NameSystem::Ens => encode_gateway_text(value),
        NameSystem::Gns | NameSystem::Wns => encode_abi_string(value),
    };
    encode_hex(&bytes)
}

fn encode_dynamic_bytes(raw: &[u8]) -> Vec<u8> {
    let mut out = u256_word(32);
    out.extend_from_slice(&u256_word(raw.len() as u64));
    out.extend_from_slice(raw);
    out.extend(std::iter::repeat_n(0, pad32(raw.len())));
    out
}

fn encode_gateway_text(value: &str) -> Vec<u8> {
    let inner = encode_abi_string(value);
    let mut out = u256_word(0x40);
    out.extend_from_slice(&address_word(&[0u8; 20]));
    out.extend_from_slice(&u256_word(inner.len() as u64));
    out.extend_from_slice(&inner);
    out.extend(std::iter::repeat_n(0, pad32(inner.len())));
    out
}

fn encode_abi_string(s: &str) -> Vec<u8> {
    let raw = s.as_bytes();
    let mut out = u256_word(32);
    out.extend_from_slice(&u256_word(raw.len() as u64));
    out.extend_from_slice(raw);
    out.extend(std::iter::repeat_n(0, pad32(raw.len())));
    out
}

fn encode_string_two_addresses(name: &str) -> Vec<u8> {
    let raw = name.as_bytes();
    let mut out = u256_word(0x60);
    out.extend_from_slice(&address_word(&[0u8; 20]));
    out.extend_from_slice(&address_word(&[0u8; 20]));
    out.extend_from_slice(&u256_word(raw.len() as u64));
    out.extend_from_slice(raw);
    out.extend(std::iter::repeat_n(0, pad32(raw.len())));
    out
}

fn encode_bytes_and_address(address: &[u8; 20]) -> Vec<u8> {
    let mut out = u256_word(0x40);
    out.extend_from_slice(&address_word(&[0u8; 20]));
    out.extend_from_slice(&u256_word(32));
    out.extend_from_slice(&address_word(address));
    out
}

fn pad32(len: usize) -> usize {
    (32 - (len % 32)) % 32
}

fn u256_word(n: u64) -> Vec<u8> {
    let mut w = vec![0u8; 32];
    w[24..].copy_from_slice(&n.to_be_bytes());
    w
}

fn address_word(addr: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(addr);
    w
}

fn abi_word(data: &[u8], index: usize) -> Option<[u8; 32]> {
    let start = 4 + index * 32;
    data.get(start..start + 32)?.try_into().ok()
}

fn word_as_usize(word: &[u8; 32]) -> Option<usize> {
    if word[..24].iter().any(|b| *b != 0) {
        return None;
    }
    let n = u64::from_be_bytes(word[24..].try_into().ok()?);
    usize::try_from(n).ok()
}

fn word_is_u64(word: &[u8; 32], n: u64) -> bool {
    word_as_u64(word) == Some(n)
}

fn word_as_u64(word: &[u8; 32]) -> Option<u64> {
    if word[..24].iter().any(|b| *b != 0) {
        return None;
    }
    Some(u64::from_be_bytes(word[24..].try_into().ok()?))
}

fn abi_dyn_bytes(data: &[u8], head_index: usize) -> Option<Vec<u8>> {
    let offset = word_as_usize(&abi_word(data, head_index)?)?;
    let at = 4 + offset;
    let len = word_as_usize(&data.get(at..at + 32)?.try_into().ok()?)?;
    data.get(at + 32..at + 32 + len).map(<[u8]>::to_vec)
}

fn abi_string(data: &[u8]) -> Option<String> {
    abi_string_at(data, 0)
}

fn abi_string_at(data: &[u8], head_index: usize) -> Option<String> {
    let bytes = abi_dyn_bytes(data, head_index)?;
    String::from_utf8(bytes).ok()
}

fn arg0_address(data: &[u8]) -> Option<[u8; 20]> {
    let word = abi_word(data, 0)?;
    word[12..].try_into().ok()
}

fn address_from_reverse_bytes(bytes: &[u8]) -> Option<[u8; 20]> {
    if bytes.len() == 20 {
        return bytes.try_into().ok();
    }
    let name = dns_name(bytes)?;
    let mut parts = name.split('.');
    let label = parts.next()?;
    if parts.next() == Some("addr")
        && parts.next() == Some("reverse")
        && parts.next().is_none()
        && label.len() == 40
    {
        return hex::decode(label).ok()?.try_into().ok();
    }
    None
}

fn dns_name(packet: &[u8]) -> Option<String> {
    let mut labels = Vec::new();
    let mut i = 0;
    while i < packet.len() && packet[i] != 0 {
        let len = packet[i] as usize;
        if len == 0 || i + 1 + len > packet.len() {
            return None;
        }
        let label = std::str::from_utf8(&packet[i + 1..i + 1 + len]).ok()?;
        labels.push(label.to_ascii_lowercase());
        i += 1 + len;
    }
    if labels.is_empty() {
        return None;
    }
    Some(labels.join("."))
}

#[cfg(test)]
pub(crate) fn gns_reverse_calldata(address: &[u8; 20]) -> Vec<u8> {
    let mut data = REVERSE_RESOLVE.to_vec();
    data.extend_from_slice(&address_word(address));
    data
}

#[cfg(test)]
pub(crate) fn gns_resolve_calldata(token_id: &[u8; 32]) -> Vec<u8> {
    let mut data = RESOLVE.to_vec();
    data.extend_from_slice(token_id);
    data
}

#[cfg(test)]
pub(crate) fn stealth_meta_calldata(registrant: &[u8; 20], scheme_id: u64) -> Vec<u8> {
    let mut data = STEALTH_META.to_vec();
    data.extend_from_slice(&address_word(registrant));
    data.extend_from_slice(&u256_word(scheme_id));
    data
}

#[cfg(test)]
pub(crate) fn gns_text_calldata(token_id: &[u8; 32], key: &str) -> Vec<u8> {
    let raw = key.as_bytes();
    let mut data = TEXT_UINT.to_vec();
    data.extend_from_slice(token_id);
    data.extend_from_slice(&u256_word(0x40));
    data.extend_from_slice(&u256_word(raw.len() as u64));
    data.extend_from_slice(raw);
    data.extend(std::iter::repeat_n(0, pad32(raw.len())));
    data
}

#[cfg(test)]
pub(crate) fn resolve_gateways_text_calldata(name: &str, node: &[u8; 32], key: &str) -> Vec<u8> {
    let raw = key.as_bytes();
    let mut inner = TEXT_BYTES32.to_vec();
    inner.extend_from_slice(node);
    inner.extend_from_slice(&u256_word(0x40));
    inner.extend_from_slice(&u256_word(raw.len() as u64));
    inner.extend_from_slice(raw);
    inner.extend(std::iter::repeat_n(0, pad32(raw.len())));
    let packet = dns_packet(name);
    let name_off = 0x60u64;
    let data_off = name_off + 32 + padded_len(packet.len()) as u64;
    let gw_off = data_off + 32 + padded_len(inner.len()) as u64;
    let mut data = RESOLVE_WITH_GATEWAYS.to_vec();
    data.extend_from_slice(&u256_word(name_off));
    data.extend_from_slice(&u256_word(data_off));
    data.extend_from_slice(&u256_word(gw_off));
    data.extend_from_slice(&u256_word(packet.len() as u64));
    data.extend_from_slice(&packet);
    data.extend(std::iter::repeat_n(0, pad32(packet.len())));
    data.extend_from_slice(&u256_word(inner.len() as u64));
    data.extend_from_slice(&inner);
    data.extend(std::iter::repeat_n(0, pad32(inner.len())));
    data.extend_from_slice(&u256_word(0));
    data
}

#[cfg(test)]
pub(crate) fn gns_compute_id_calldata(name: &str) -> Vec<u8> {
    let mut data = COMPUTE_ID.to_vec();
    data.extend(encode_abi_string(name));
    data
}

#[cfg(test)]
pub(crate) fn reverse_gateways_calldata(address: &[u8; 20]) -> Vec<u8> {
    // head: bytes offset, coinType 60, string[] offset. Then the 20-byte
    // address and an empty gateway array.
    let mut data = REVERSE_WITH_GATEWAYS.to_vec();
    data.extend_from_slice(&u256_word(0x60));
    data.extend_from_slice(&u256_word(60));
    data.extend_from_slice(&u256_word(0xa0));
    data.extend_from_slice(&u256_word(20));
    data.extend_from_slice(address);
    data.extend(std::iter::repeat_n(0, 12));
    data.extend_from_slice(&u256_word(0));
    data
}

#[cfg(test)]
pub(crate) fn resolve_gateways_calldata(name: &str) -> Vec<u8> {
    let packet = dns_packet(name);
    let mut inner = ADDR_SELECTOR.to_vec();
    inner.extend_from_slice(&[0u8; 32]);
    // head: name offset, data offset, gateways offset.
    let name_off = 0x60u64;
    let data_off = name_off + 32 + padded_len(packet.len()) as u64;
    let gw_off = data_off + 32 + padded_len(inner.len()) as u64;
    let mut data = RESOLVE_WITH_GATEWAYS.to_vec();
    data.extend_from_slice(&u256_word(name_off));
    data.extend_from_slice(&u256_word(data_off));
    data.extend_from_slice(&u256_word(gw_off));
    data.extend_from_slice(&u256_word(packet.len() as u64));
    data.extend_from_slice(&packet);
    data.extend(std::iter::repeat_n(0, pad32(packet.len())));
    data.extend_from_slice(&u256_word(inner.len() as u64));
    data.extend_from_slice(&inner);
    data.extend(std::iter::repeat_n(0, pad32(inner.len())));
    data.extend_from_slice(&u256_word(0));
    data
}

#[cfg(test)]
fn padded_len(len: usize) -> usize {
    len + pad32(len)
}

#[cfg(test)]
fn dns_packet(name: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for label in name.split('.').filter(|l| !l.is_empty()) {
        let bytes = label.as_bytes();
        out.push(bytes.len() as u8);
        out.extend_from_slice(bytes);
    }
    out.push(0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eth_namehash_matches_ens() {
        let got = namehash("eth");
        let expect =
            hex::decode("93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae")
                .unwrap();
        assert_eq!(got.as_slice(), expect.as_slice());
    }

    #[test]
    fn reverse_gateways_extracts_address_and_coin_type() {
        let mut address = [0u8; 20];
        address[19] = 7;
        let data = reverse_gateways_calldata(&address);
        match match_name_call(&UNIVERSAL_RESOLVER, &data) {
            Some(ClassifiedName::Reverse {
                system: NameSystem::Ens,
                address: got,
            }) => assert_eq!(got, address),
            other => panic!("expected ENS reverse, got {other:?}"),
        }
    }

    #[test]
    fn resolve_gateways_extracts_the_name() {
        let data = resolve_gateways_calldata("vitalik.eth");
        match match_name_call(&UNIVERSAL_RESOLVER, &data) {
            Some(ClassifiedName::Forward(NameForward::EnsName { name })) => {
                assert_eq!(name, "vitalik.eth");
            }
            other => panic!("expected ENS forward, got {other:?}"),
        }
    }

    #[test]
    fn stealth_meta_extracts_registrant_and_scheme() {
        let mut registrant = [0u8; 20];
        registrant[19] = 4;
        let data = stealth_meta_calldata(&registrant, 1);
        match match_name_call(&ERC6538, &data) {
            Some(ClassifiedName::StealthMeta {
                registrant: got,
                scheme_id: Some(1),
            }) => assert_eq!(got, registrant),
            other => panic!("expected stealth meta, got {other:?}"),
        }
    }

    #[test]
    fn gns_text_matches_only_the_stealth_key() {
        let node = namehash("banteg.gwei");
        let data = gns_text_calldata(&node, STEALTH_TEXT_KEY);
        match match_name_call(&GNS, &data) {
            Some(ClassifiedName::StealthText {
                system: NameSystem::Gns,
                node: got,
            }) => assert_eq!(got, node),
            other => panic!("expected GNS text, got {other:?}"),
        }
        let other = gns_text_calldata(&node, "avatar");
        assert!(match_name_call(&GNS, &other).is_none());
    }
}
