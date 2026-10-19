//! The value a name table holds for an address: its primary names in ENS, GNS
//! and WNS, packed into the table's 40-byte value.
//!
//! The table is keyed by the address itself. A wallet asks once and gets all
//! three systems back, which is also what kohaku-cli asks for (it walks
//! GNS, ENS and WNS in turn). Each name a system holds is one record:
//!
//! ```text
//! [system: 1 byte][length: 1 byte][UTF-8 name: length bytes]
//! ```
//!
//! in the order ENS, GNS, WNS, and zero bytes after the last one. An address
//! with no name in any system holds all zeros, which reads the same as an
//! address the table does not hold at all.
//!
//! A name too long to fit leaves a two-byte record with [`TOO_LONG`] set in
//! the system byte and length 0, so a client knows a name exists and can ask
//! for it some other way, rather than reading "no name". About 0.26% of
//! addresses with a name hold one that does not fit (measured over 912,609 on
//! 2026-10-08), mostly `0x<address>.eth` names, which are 46 bytes.

use crate::storage::keccak256;

pub const NAME_VALUE_SIZE: usize = 40;

/// The ENS namehash of a name, which GNS and WNS also use as a name's id.
/// The name is taken as given: normalizing it (ENSIP-15) is the caller's
/// part.
pub fn namehash(name: &str) -> [u8; 32] {
    let mut node = [0u8; 32];
    if name.is_empty() {
        return node;
    }
    for label in name.rsplit('.') {
        let mut input = [0u8; 64];
        input[..32].copy_from_slice(&node);
        input[32..].copy_from_slice(&keccak256(label.as_bytes()));
        node = keccak256(&input);
    }
    node
}

/// Set in a record's system byte when the name did not fit.
pub const TOO_LONG: u8 = 0x80;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum NameSystem {
    Ens = 1,
    Gns = 2,
    Wns = 3,
}

impl NameSystem {
    pub const ALL: [NameSystem; 3] = [NameSystem::Ens, NameSystem::Gns, NameSystem::Wns];

    fn from_byte(b: u8) -> Option<NameSystem> {
        match b {
            1 => Some(NameSystem::Ens),
            2 => Some(NameSystem::Gns),
            3 => Some(NameSystem::Wns),
            _ => None,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            NameSystem::Ens => "ENS",
            NameSystem::Gns => "GNS",
            NameSystem::Wns => "WNS",
        }
    }
}

/// What a table holds for one system.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NameEntry {
    Name(String),
    /// A name exists but did not fit the value.
    TooLong,
}

/// An address's primary names, one slot per system.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Names {
    pub ens: Option<NameEntry>,
    pub gns: Option<NameEntry>,
    pub wns: Option<NameEntry>,
}

impl Names {
    pub fn get(&self, system: NameSystem) -> &Option<NameEntry> {
        match system {
            NameSystem::Ens => &self.ens,
            NameSystem::Gns => &self.gns,
            NameSystem::Wns => &self.wns,
        }
    }

    pub fn get_mut(&mut self, system: NameSystem) -> &mut Option<NameEntry> {
        match system {
            NameSystem::Ens => &mut self.ens,
            NameSystem::Gns => &mut self.gns,
            NameSystem::Wns => &mut self.wns,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.ens.is_none() && self.gns.is_none() && self.wns.is_none()
    }

    /// Pack into a value. Names are written in system order. One that would
    /// leave no room for the two-byte records of the systems after it becomes
    /// a [`TOO_LONG`] record instead, so every system that has a name is
    /// always represented.
    pub fn pack(&self) -> Vec<u8> {
        let mut out = vec![0u8; NAME_VALUE_SIZE];
        let present: Vec<(NameSystem, &NameEntry)> = NameSystem::ALL
            .iter()
            .filter_map(|&s| self.get(s).as_ref().map(|e| (s, e)))
            .collect();
        let mut at = 0;
        for (i, (system, entry)) in present.iter().enumerate() {
            let reserve = 2 * (present.len() - i - 1);
            let bytes: &[u8] = match entry {
                NameEntry::Name(name) => name.as_bytes(),
                NameEntry::TooLong => &[],
            };
            let fits = matches!(entry, NameEntry::Name(_))
                && bytes.len() <= 255
                && at + 2 + bytes.len() + reserve <= NAME_VALUE_SIZE;
            if fits {
                out[at] = *system as u8;
                out[at + 1] = bytes.len() as u8;
                out[at + 2..at + 2 + bytes.len()].copy_from_slice(bytes);
                at += 2 + bytes.len();
            } else {
                out[at] = *system as u8 | TOO_LONG;
                at += 2;
            }
        }
        out
    }

    /// Read a value back. All zeros is no name in any system.
    pub fn unpack(value: &[u8]) -> Result<Names, String> {
        let mut names = Names::default();
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
                NameEntry::Name(
                    String::from_utf8(bytes.to_vec()).map_err(|_| "name is not UTF-8")?,
                )
            };
            *names.get_mut(system) = Some(entry);
            at += 2 + if tag & TOO_LONG != 0 { 0 } else { len };
        }
        Ok(names)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// GNS ids are namehashes: these two are the ids GNS's `TextChanged`
    /// events carried for the names on mainnet.
    #[test]
    fn namehash_matches_gns_ids() {
        assert_eq!(namehash(""), [0u8; 32]);
        assert_eq!(
            hex::encode(namehash("tatsumaki.gwei")),
            "8f224d39e7a640341fcb23099f85eced686f1c693deb24f61678952f167bade6"
        );
        assert_eq!(
            hex::encode(namehash("addr.reverse")),
            "91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2"
        );
    }

    fn name(s: &str) -> Option<NameEntry> {
        Some(NameEntry::Name(s.into()))
    }

    #[test]
    fn no_name_is_all_zeros() {
        let v = Names::default().pack();
        assert_eq!(v, vec![0u8; NAME_VALUE_SIZE]);
        assert_eq!(Names::unpack(&v).unwrap(), Names::default());
    }

    #[test]
    fn names_round_trip_in_system_order() {
        let n = Names {
            ens: name("vitalik.eth"),
            gns: name("banteg.gwei"),
            wns: name("baer.wei"),
        };
        let v = n.pack();
        assert_eq!(v.len(), NAME_VALUE_SIZE);
        assert_eq!(&v[..13], b"\x01\x0bvitalik.eth");
        assert_eq!(Names::unpack(&v).unwrap(), n);
    }

    #[test]
    fn a_long_name_leaves_a_marker_and_the_others_still_fit() {
        let long = "0xc45d53f9b22eb501c772ddd371bdfe8a433de4e6.eth"; // 46 bytes
        let n = Names {
            ens: name(long),
            gns: name("bibi.gwei"),
            wns: None,
        };
        let back = Names::unpack(&n.pack()).unwrap();
        assert_eq!(back.ens, Some(NameEntry::TooLong));
        assert_eq!(back.gns, name("bibi.gwei"));
        assert_eq!(back.wns, None);
    }

    #[test]
    fn a_name_that_fits_alone_gives_way_to_the_markers_after_it() {
        // 37 bytes: fits on its own (2 + 37 = 39) but not with a WNS record.
        let n = Names {
            ens: name("abcdefghijklmnopqrstuvwxyz0123456.eth"),
            gns: None,
            wns: name("roll.wei"),
        };
        let back = Names::unpack(&n.pack()).unwrap();
        assert_eq!(back.ens, Some(NameEntry::TooLong));
        assert_eq!(back.wns, name("roll.wei"));
        let alone = Names { wns: None, ..n };
        assert_eq!(Names::unpack(&alone.pack()).unwrap(), alone);
    }

    #[test]
    fn multibyte_names_count_bytes() {
        let n = Names {
            ens: name("엄마.eth"),
            ..Default::default()
        };
        assert_eq!(n.pack()[1] as usize, "엄마.eth".len());
        assert_eq!(Names::unpack(&n.pack()).unwrap(), n);
    }

    #[test]
    fn garbage_is_rejected() {
        let mut v = vec![0u8; NAME_VALUE_SIZE];
        v[0] = 9;
        v[1] = 1;
        assert!(Names::unpack(&v).is_err());
        v[0] = 1;
        v[1] = 60;
        assert!(Names::unpack(&v).is_err());
    }
}
