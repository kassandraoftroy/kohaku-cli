//! Hardcoded mainnet ERC-20s served by inspire token/storage PIR (`:18091`).
//!
//! Key/value layout matches `pir_keyword::storage` / `pir_client::TOKENS`.

use alloy::primitives::keccak256;

/// An ERC-20 whose `balanceOf` is answered by the token PIR storage table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PirToken {
    /// Symbol (USDC, …).
    pub symbol: &'static str,
    /// Contract address (lowercase 0x-hex).
    pub address: &'static str,
    /// Storage slot of the balances mapping.
    pub balances_slot: u64,
    /// When true, clear the top bit of the storage word (USDC blacklist).
    pub flag_in_top_bit: bool,
}

/// The four tokens kohaku-cli syncs by default.
pub const PIR_TOKENS: [PirToken; 4] = [
    PirToken {
        symbol: "USDC",
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        balances_slot: 9,
        flag_in_top_bit: true,
    },
    PirToken {
        symbol: "USDT",
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        balances_slot: 2,
        flag_in_top_bit: false,
    },
    PirToken {
        symbol: "DAI",
        address: "0x6b175474e89094c44da98b954eedeac495271d0f",
        balances_slot: 2,
        flag_in_top_bit: false,
    },
    PirToken {
        symbol: "WETH",
        address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        balances_slot: 3,
        flag_in_top_bit: false,
    },
];

/// ERC-20 `balanceOf(address)` selector.
pub const BALANCE_OF_SELECTOR: [u8; 4] = [0x70, 0xa0, 0x82, 0x31];

/// Default PIR key size for inspire storage tables.
pub const STORAGE_KEY_SIZE: usize = 20;

impl PirToken {
    /// Contract as 20 raw bytes.
    #[must_use]
    pub fn contract(&self) -> [u8; 20] {
        let digits = self.address.strip_prefix("0x").unwrap_or(self.address);
        let bytes = hex::decode(digits).expect("static token address");
        bytes.try_into().expect("20 bytes")
    }

    /// PIR lookup key for `balanceOf(holder)` (20-byte storage key).
    #[must_use]
    pub fn balance_key(&self, holder: &[u8; 20]) -> Vec<u8> {
        let slot = mapping_slot(holder, self.balances_slot);
        storage_key(&self.contract(), &slot, STORAGE_KEY_SIZE)
    }

    /// Apply USDC-style top-bit masking to a 32-byte storage word.
    #[must_use]
    pub fn balance_from_word(&self, mut word: [u8; 32]) -> [u8; 32] {
        if self.flag_in_top_bit {
            word[0] &= 0x7f;
        }
        word
    }
}

/// Look up a hardcoded PIR token by contract address.
#[must_use]
pub fn pir_token_by_contract(contract: &[u8; 20]) -> Option<&'static PirToken> {
    PIR_TOKENS.iter().find(|t| t.contract() == *contract)
}

/// Solidity mapping slot: `keccak256(pad32(key) ‖ pad32(mapping))`.
#[must_use]
pub fn mapping_slot(key: &[u8; 20], mapping: u64) -> [u8; 32] {
    let mut preimage = [0u8; 64];
    preimage[12..32].copy_from_slice(key);
    preimage[56..].copy_from_slice(&mapping.to_be_bytes());
    *keccak256(&preimage)
}

/// Inspire storage-table key: `keccak256(keccak256(contract) ‖ keccak256(slot))` cut to `key_size`.
#[must_use]
pub fn storage_key(contract: &[u8; 20], slot: &[u8; 32], key_size: usize) -> Vec<u8> {
    let contract_hash = keccak256(contract);
    let slot_hash = keccak256(slot);
    let mut input = [0u8; 64];
    input[..32].copy_from_slice(contract_hash.as_slice());
    input[32..].copy_from_slice(slot_hash.as_slice());
    keccak256(&input).as_slice()[..key_size.min(32)].to_vec()
}

/// Unpack a 40-byte storage cell to a 32-byte word.
#[must_use]
pub fn parse_storage_value(value: &[u8]) -> Option<[u8; 32]> {
    if value.len() != 40 {
        return None;
    }
    value[8..].try_into().ok()
}

/// Build ABI calldata for `balanceOf(holder)`.
#[must_use]
pub fn balance_of_calldata(holder: &[u8; 20]) -> Vec<u8> {
    let mut data = Vec::with_capacity(36);
    data.extend_from_slice(&BALANCE_OF_SELECTOR);
    data.extend_from_slice(&[0u8; 12]);
    data.extend_from_slice(holder);
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(hex_str: &str) -> [u8; 20] {
        hex::decode(hex_str).unwrap().try_into().unwrap()
    }

    #[test]
    fn usdc_balance_slot_and_key_match_inspire() {
        let holder = address("88e6a0c2ddd26feeb64f039a2c41296fcb3f5640");
        let usdc = &PIR_TOKENS[0];
        let slot = mapping_slot(&holder, usdc.balances_slot);
        assert_eq!(
            hex::encode(slot),
            "1f21a62c4538bacf2aabeca410f0fe63151869f172e03c0e00357ba26a341eff"
        );
        assert_eq!(
            hex::encode(usdc.balance_key(&holder)),
            "d6a3e40d689f6d6eec2db745e1a538aac45c7e87"
        );
    }

    #[test]
    fn clears_usdc_blacklist_bit() {
        let usdc = &PIR_TOKENS[0];
        let mut word = [0u8; 32];
        word[0] = 0x80;
        word[31] = 7;
        assert_eq!(usdc.balance_from_word(word)[0], 0);
        assert_eq!(usdc.balance_from_word(word)[31], 7);
    }
}
