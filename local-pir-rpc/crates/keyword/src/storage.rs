//! Keys and values for a table of contract storage slots.
//!
//! A node's storage table holds each slot under two hashes, keccak256 of the
//! contract's address and keccak256 of the slot, and neither can be turned
//! back. So the table is keyed by those hashes too: the key of a slot is
//! keccak256(keccak256(contract) ‖ keccak256(slot)), cut to the key size. A
//! client asking about a slot knows the contract and the slot (a token balance
//! is a mapping entry, whose slot it computes), so it hashes the same way.

use sha3::{Digest, Keccak256};

/// Zero bytes in front of the slot's 32-byte value, which keep a storage cell
/// at the 40-byte value width of an account cell.
pub const VALUE_PADDING: usize = 8;

/// The lookup key of `slot` in `contract`'s storage.
pub fn storage_key(contract: &[u8; 20], slot: &[u8; 32], key_size: usize) -> Vec<u8> {
    storage_key_from_hashes(&keccak256(contract), &keccak256(slot), key_size)
}

/// The same key, from the two hashes a node's storage table holds.
pub fn storage_key_from_hashes(
    contract_hash: &[u8; 32],
    slot_hash: &[u8; 32],
    key_size: usize,
) -> Vec<u8> {
    let mut input = [0u8; 64];
    input[..32].copy_from_slice(contract_hash);
    input[32..].copy_from_slice(slot_hash);
    keccak256(&input)[..key_size.min(32)].to_vec()
}

/// The cell value for a slot holding `word`, a 32-byte big-endian integer.
pub fn storage_value(word: &[u8; 32]) -> Vec<u8> {
    let mut value = vec![0u8; VALUE_PADDING + 32];
    value[VALUE_PADDING..].copy_from_slice(word);
    value
}

/// The slot's 32-byte value back out of a cell value.
pub fn parse_storage_value(value: &[u8]) -> Option<[u8; 32]> {
    if value.len() != VALUE_PADDING + 32 {
        return None;
    }
    value[VALUE_PADDING..].try_into().ok()
}

/// Where Solidity keeps a mapping's entry for `key`: keccak256 of the key and
/// of the mapping's own slot number, each left-padded to 32 bytes. A token's
/// `balanceOf(holder)` reads the holder's entry in its balances mapping.
pub fn mapping_slot(key: &[u8; 20], mapping: u64) -> [u8; 32] {
    let mut preimage = [0u8; 64];
    preimage[12..32].copy_from_slice(key);
    preimage[56..].copy_from_slice(&mapping.to_be_bytes());
    keccak256(&preimage)
}

pub fn keccak256(bytes: &[u8]) -> [u8; 32] {
    Keccak256::digest(bytes).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(hex_str: &str) -> [u8; 20] {
        hex::decode(hex_str).unwrap().try_into().unwrap()
    }

    const USDC: &str = "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    /// Holds USDC; its balance is the entry in the mapping at slot 9.
    const HOLDER: &str = "88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";

    /// Both vectors were computed by a node (`web3_sha3`), independently of
    /// this code.
    #[test]
    fn a_usdc_balance_slot_and_its_key() {
        let slot = mapping_slot(&address(HOLDER), 9);
        assert_eq!(
            hex::encode(slot),
            "1f21a62c4538bacf2aabeca410f0fe63151869f172e03c0e00357ba26a341eff"
        );
        assert_eq!(
            hex::encode(storage_key(&address(USDC), &slot, 20)),
            "d6a3e40d689f6d6eec2db745e1a538aac45c7e87"
        );
    }

    /// The dump only has the two hashes, the follower and the client have the
    /// contract and the slot, and all three have to land on the same key.
    #[test]
    fn the_key_from_hashes_is_the_key_from_the_slot() {
        let contract = address(USDC);
        let slot = mapping_slot(&address(HOLDER), 9);
        assert_eq!(
            storage_key_from_hashes(&keccak256(&contract), &keccak256(&slot), 20),
            storage_key(&contract, &slot, 20)
        );
    }

    #[test]
    fn values_round_trip_behind_the_padding() {
        let mut word = [0u8; 32];
        word[0] = 0x80; // USDC's blacklist bit
        word[31] = 7;
        let value = storage_value(&word);
        assert_eq!(value.len(), 40);
        assert!(value[..VALUE_PADDING].iter().all(|&b| b == 0));
        assert_eq!(parse_storage_value(&value), Some(word));
        assert_eq!(parse_storage_value(&value[1..]), None);
    }
}
