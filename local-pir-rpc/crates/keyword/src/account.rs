//! The value an account table holds for an address: its balance, its nonce,
//! and the contract it delegates to under EIP-7702, packed into the table's
//! 40-byte value.
//!
//! ```text
//! [delegate: 20 bytes][balance, BE: 12 bytes][nonce, BE: 8 bytes]
//! ```
//!
//! An externally owned account's code is either empty or the 23-byte
//! designator `0xef0100 ‖ delegate` that EIP-7702 writes, so the delegate is
//! all of it. Twenty zero bytes mean no delegation: delegating to the zero
//! address clears the code rather than storing it. A contract's code does not
//! fit and reads as none, so the value answers `eth_getCode` only for an
//! address known to be an EOA, such as a wallet's own.
//!
//! Twelve bytes hold any balance there is, since all the ether in existence is
//! below 2^87 wei.

pub const ACCOUNT_VALUE_SIZE: usize = 40;

/// What EIP-7702 puts in front of the delegate's address in an account's code.
pub const DELEGATION_PREFIX: [u8; 3] = [0xef, 0x01, 0x00];

/// The largest balance the value can hold, 2^96 - 1 wei.
pub const MAX_BALANCE: u128 = (1 << 96) - 1;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AccountValue {
    pub balance: u128,
    pub nonce: u64,
    /// The contract this account delegates its code to, if it does.
    pub delegate: Option<[u8; 20]>,
}

impl AccountValue {
    /// A balance past [`MAX_BALANCE`] cannot occur on mainnet and is held as
    /// that maximum.
    pub fn pack(&self) -> [u8; ACCOUNT_VALUE_SIZE] {
        let mut value = [0u8; ACCOUNT_VALUE_SIZE];
        if let Some(delegate) = self.delegate {
            value[..20].copy_from_slice(&delegate);
        }
        value[20..32].copy_from_slice(&self.balance.min(MAX_BALANCE).to_be_bytes()[4..]);
        value[32..40].copy_from_slice(&self.nonce.to_be_bytes());
        value
    }

    pub fn unpack(value: &[u8]) -> Option<AccountValue> {
        if value.len() != ACCOUNT_VALUE_SIZE {
            return None;
        }
        let delegate: [u8; 20] = value[..20].try_into().unwrap();
        let mut balance = [0u8; 16];
        balance[4..].copy_from_slice(&value[20..32]);
        Some(AccountValue {
            balance: u128::from_be_bytes(balance),
            nonce: u64::from_be_bytes(value[32..40].try_into().unwrap()),
            delegate: (delegate != [0u8; 20]).then_some(delegate),
        })
    }

    /// The account's code as `eth_getCode` returns it, for an EOA: empty, or
    /// the designator pointing at its delegate.
    pub fn code(&self) -> Vec<u8> {
        match self.delegate {
            Some(delegate) => [&DELEGATION_PREFIX[..], &delegate[..]].concat(),
            None => Vec::new(),
        }
    }
}

/// The delegate an account's code names, if the code is an EIP-7702
/// designator. Any other code, a contract's included, names none.
pub fn delegate_from_code(code: &[u8]) -> Option<[u8; 20]> {
    if code.len() != 23 || code[..3] != DELEGATION_PREFIX {
        return None;
    }
    let delegate: [u8; 20] = code[3..].try_into().unwrap();
    (delegate != [0u8; 20]).then_some(delegate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex20(s: &str) -> [u8; 20] {
        hex::decode(s).unwrap().try_into().unwrap()
    }

    #[test]
    fn round_trips_with_and_without_a_delegate() {
        let plain = AccountValue { balance: 660_443_672_139_059_381, nonce: 116_692, delegate: None };
        assert_eq!(AccountValue::unpack(&plain.pack()), Some(plain));
        let delegated = AccountValue {
            balance: 100_000_000_000_000_000_000_000_000, // 10^8 ether, past 2^86
            nonce: 545_279,
            delegate: Some(hex20("63c0c19a282a1b52b07dd5a65b58948a07dae32b")),
        };
        assert_eq!(AccountValue::unpack(&delegated.pack()), Some(delegated));
    }

    /// Without a delegate the first twenty bytes stay zero, and the balance
    /// sits right-aligned before the nonce.
    #[test]
    fn layout_is_delegate_then_balance_then_nonce() {
        let value = AccountValue {
            balance: 0x0102,
            nonce: 7,
            delegate: Some([0xaa; 20]),
        }
        .pack();
        assert_eq!(&value[..20], &[0xaa; 20]);
        assert_eq!(&value[20..32], &[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2]);
        assert_eq!(&value[32..40], &7u64.to_be_bytes());
        let plain = AccountValue { balance: 5, nonce: 0, delegate: None }.pack();
        assert!(plain[..31].iter().all(|&b| b == 0));
    }

    #[test]
    fn a_balance_past_96_bits_is_held_at_the_maximum() {
        let value = AccountValue { balance: u128::MAX, nonce: 0, delegate: None }.pack();
        assert_eq!(AccountValue::unpack(&value).unwrap().balance, MAX_BALANCE);
    }

    /// The designator from a mainnet trace (block 26,153,120).
    #[test]
    fn reads_a_designator_and_nothing_else() {
        let code = hex::decode("ef010063c0c19a282a1b52b07dd5a65b58948a07dae32b").unwrap();
        let delegate = delegate_from_code(&code).unwrap();
        assert_eq!(delegate, hex20("63c0c19a282a1b52b07dd5a65b58948a07dae32b"));
        let value = AccountValue { balance: 0, nonce: 1, delegate: Some(delegate) };
        assert_eq!(value.code(), code);
        assert_eq!(AccountValue::default().code(), Vec::<u8>::new());

        assert_eq!(delegate_from_code(&[]), None);
        assert_eq!(delegate_from_code(&code[..22]), None);
        assert_eq!(delegate_from_code(&[0x60; 23]), None); // a contract
        let mut zero = vec![0xef, 0x01, 0x00];
        zero.extend_from_slice(&[0u8; 20]);
        assert_eq!(delegate_from_code(&zero), None);
    }
}
