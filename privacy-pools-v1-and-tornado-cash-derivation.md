# Seed-derived note secrets for Privacy Pools v1 and Tornado Cash

This document explains how Kohaku derives private note secrets from a seed phrase using deterministic signatures. It is for wallet implementers who need to reproduce those notes, integrate a hardware wallet, or recover an existing wallet. It includes exact encodings, test vectors, and a runnable verifier.

## Why derive secrets from signatures?

Hardware wallets generally cannot run the required zero-knowledge prover, so the host needs the note secrets to create proofs. A compatible hardware wallet can produce a deterministic signature without exporting its seed or account private key. The host derives the note secrets from that signature and proves off-device. The exported signature is therefore sensitive note material, while the account private key stays on the device.

## Scope and conventions

This describes the signature-derived scheme used for new Kohaku shields, checked against `@kohaku-eth/privacy-pools@0.1.0-alpha.37` and `@kohaku-eth/tornado-cash@0.1.0-alpha.34`, and the nonce-allocation changes prepared for `kohaku-cli@0.1.5` on 2026-11-04. The short legacy appendix describes the older HD-derived notes that the CLI still supports.

**“Privacy Pools” in this document always means Privacy Pools v1. Nothing here specifies Privacy Pools v2; its derivation has not been finalized.** The exact EIP-712 strings below intentionally retain the implemented names, such as `PrivacyPools Keychain`.

- `K` means Ethereum **Keccak-256**, not NIST SHA3-256.
- `||` means byte concatenation, with no separators or ABI encoding unless stated.
- `UTF8(s)` means the bytes of the exact, case-sensitive string, without a terminator.
- `BE_n(x)` and `LE_n(x)` encode an unsigned integer in exactly `n` bytes, big-endian or little-endian.
- `intBE(b)` and `intLE(b)` interpret bytes as unsigned integers in that byte order.
- `first31(b)` takes bytes at offsets `[0, 31)`: the **first** 31 bytes, not the last 31 bytes or a reduction modulo a field.
- An apostrophe in an HD path means hardened BIP-32 derivation.
- The application note `nonce` is an index. It is **not** an Ethereum transaction nonce or ECDSA's internal signing nonce `k`.

## 1. Seed phrase → signing identity

Kohaku's software keystore uses ordinary secp256k1 BIP-32 derivation from a BIP-39 seed. Despite the helper package's name, this path does not use Railgun's Baby Jubjub key derivation.

First compute the 64-byte seed:

```text
seed = PBKDF2-HMAC-SHA512(
  password = UTF8(NFKD(mnemonic)),
  salt     = UTF8("mnemonic" + NFKD(bip39Passphrase)),
  rounds   = 2048,
  dkLen    = 64
)
```

The current CLI uses an **empty BIP-39 passphrase**. Its wallet-encryption password protects files and does not enter this derivation. See [BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki).

Use the seed for standard [BIP-32](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki) secp256k1 derivation. Its master material is `HMAC-SHA512(key = UTF8("Bitcoin seed"), data = seed)`: the left 32 bytes give the master private scalar and the right 32 bytes give the chain code, subject to BIP-32's validity rules.

The protocol signing identities are:

```text
Privacy Pools v1: m/28784'/1'/accountIndex'
Tornado Cash:    m/29795'/1'/accountIndex'
```

The CLI currently uses `accountIndex = 0`. A note index does not select another HD child: the same protocol signing identity signs different typed messages. These are separate keys from the usual public Ethereum account path `m/44'/60'/0'/0/index`.

## 2. Deterministic signatures and canonical bytes

Sign the [EIP-712](https://eips.ethereum.org/EIPS/eip-712) digest using secp256k1 ECDSA with the RFC-6979 deterministic signing behavior reproduced by the verifier below:

```text
digest = K(0x1901 || domainSeparator || hashStruct(message))
sigma  = deterministicECDSA(signingPrivateKey, digest)
```

Do not apply a `personal_sign` / Ethereum signed-message prefix. EIP-712 handles its own prefix and encodings. Its integers, including `uint64` message fields, occupy 32-byte ABI words in the struct hash.

For both protocols, convert the signature to the same 64-byte core:

```text
n    = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141
sLow = min(s, n - s)
RS   = BE_32(r) || BE_32(sLow)
```

The recovery identifier `v` is excluded. The vectors show the software signer's 65-byte `r || s || v` output and the 64-byte `RS` consumed by secret derivation. A hardware-wallet adapter must parse its device's signature format correctly before supplying the SDK's expected serialization.

A compatible signer must reproduce these canonical signature bytes across sessions. Being able to sign EIP-712 messages is not, by itself, enough. The SDK signs the first envelope twice per manager session to check determinism; leave that check enabled and do not enable viem's `setSignEntropy`.

## 3. Privacy Pools v1

### Signing envelope

```text
domain.name              = "PrivacyPools Keychain"
domain.version           = "1"
domain.chainId           = chainId
domain.verifyingContract = entrypointAddress
domain.salt              = K(UTF8("privacypools"))

primaryType = "PrivacyPoolNote"
message     = { depositIndex: uint64, secretIndex: uint64 }
```

The exact type strings are:

```text
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)
PrivacyPoolNote(uint64 depositIndex,uint64 secretIndex)
```

The chain and **entrypoint** are in the domain. The individual asset-pool address, asset, amount, and label are not in this signing envelope.

`depositIndex` identifies a deposit lineage across the entrypoint's asset pools. `secretIndex = 0` gives the initial deposit note; later indexes give that deposit's change-note secrets. In the SDK's withdrawal APIs, `withdrawIndex` is passed through as this `secretIndex`. Creating a change note uses the current note's index plus one.

### Secrets and commitments

```text
nullifier = intBE(first31(K(UTF8("nullifier") || RS)))
salt      = intBE(first31(K(UTF8("salt")      || RS)))

precommitment = Poseidon([nullifier, salt])
nullifierHash = Poseidon([nullifier])
commitment    = Poseidon([value, label, precommitment])
```

`value` is the note's value in base units. `label` comes from the protocol's deposit context and is retained through its change-note lineage. Neither is derived from the seed phrase alone. The commitment examples in the vectors use a **synthetic** label `42` and value `1000000000000000000`; they do not describe a real deposit or its fees.

Use the Poseidon implementation/parameters in `maci-crypto@2.5.0` / `@zk-kit/poseidon-cipher@0.3.2`, over the BN254 scalar field:

```text
q = 21888242871839275222246405745257275088548364400416034343698204186575808495617
Poseidon(inputs) = poseidonPerm([0, ...inputs])[0]
```

The permutation width depends on the number of inputs. Do not substitute another Poseidon parameter set or the different hash construction named Poseidon2.

The note-derived ephemeral EOA key is:

```text
ephemeralPrivateKey = BE_32(intBE(first31(K(UTF8("signer") || RS))))
```

This key is distinct from the HD signing identity. A flow that supplies an explicit wallet delegation path instead uses the key at that path directly; not every CLI withdrawal uses the note-derived EOA.

## 4. Tornado Cash

### Signing envelope

```text
domain.name    = "TornadoCash Keychain"
domain.version = "1"
domain.chainId = chainId
domain.salt    = K(UTF8("tornado"))

primaryType = "TornadoCashNote"
message     = { nonce: uint64 }
```

The exact type strings are:

```text
EIP712Domain(string name,string version,uint256 chainId,bytes32 salt)
TornadoCashNote(uint64 nonce)
```

**There is no `verifyingContract` field in this domain.** Omitting it is different from including the zero address. The pool address is mixed in after signing, not into the EIP-712 message or domain.

### Secrets and commitments

```text
N = first31(K(UTF8("nullifier") || BE_20(poolAddress) || RS))
S = first31(K(UTF8("secret")    || BE_20(poolAddress) || RS))

nullifier = intLE(N)
salt      = intLE(S)
preimage  = N || S                 // exactly 62 bytes

commitment    = PedersenX(preimage)
nullifierHash = PedersenX(N)
```

`S` is called `secret` in the Tornado hash tag and note preimage, but the SDK exposes its integer as `salt`. Unlike Privacy Pools v1, these secret integers are **little-endian** interpretations of the 31-byte hash slices. Do not reverse `N` or `S` before passing their original bytes to Pedersen.

`PedersenX(bytes)` means Tornado's Baby Jubjub Pedersen hash, returning the resulting point's x coordinate. The SDK uses `micro-zk-proofs@0.3.1`, specifically `Point.decode(pedersenHash(bytes)).x`; use that implementation or a verified compatible implementation, not an arbitrary curve/hash called Pedersen.

The note-derived ephemeral EOA key uses the same pool binding, but its key bytes are interpreted as a normal big-endian secp256k1 private key:

```text
T = first31(K(UTF8("signer") || BE_20(poolAddress) || RS))
ephemeralPrivateKey = 0x00 || T    // exactly 32 bytes
```

For an exported traditional Tornado note, the secret payload is the same `N || S`, serialized as:

```text
tornado-${currency}-${denomination}-${chainId}-0x${hex(N || S)}
```

The denomination/currency describe the destination pool. They are not additional secret-derivation inputs beyond its address.

## 5. Legacy HD-derived notes

The older `SecretManager` derives HD children instead of signatures. Its outputs are different from the signature-derived outputs for the same indexes. Preserve the original scheme when recovering an existing note.

For Privacy Pools v1, using `a = accountIndex`, `d = depositIndex`, and `s = secretIndex`:

```text
rawN = HDPrivateKey(m/28784'/1'/a'/0'/d'/s')
rawS = HDPrivateKey(m/28784'/1'/a'/1'/d'/s')
rawE = HDPrivateKey(m/28784'/1'/a'/2'/d'/s')

nullifier = Poseidon([chainId, entrypointAddress, intBE(rawN)])
salt      = Poseidon([chainId, entrypointAddress, intBE(rawS)])
ephemeralPrivateKey = BE_32(Poseidon([chainId, entrypointAddress, intBE(rawE)]))
```

The precommitment, nullifier hash, and final commitment then use the same Poseidon formulas as above.

For legacy Tornado HD notes, using `d = depositIndex`:

```text
rawN = HDPrivateKey(m/29795'/1'/a'/0'/d')
rawS = HDPrivateKey(m/29795'/1'/a'/1'/d')
rawE = HDPrivateKey(m/29795'/1'/a'/2'/d')

C(raw) = intLE(K(LE_32(intBE(raw)) || LE_8(chainId) || LE_20(poolAddress)))
nullifier = C(rawN) & (2^248 - 1)
salt      = C(rawS) & (2^248 - 1)
ephemeralPrivateKey = BE_32(C(rawE))
```

Encode the resulting nullifier/salt as 31 little-endian bytes each and use the same Tornado Pedersen formulas. The legacy derivation's chain and pool bytes are little-endian; the signature-derived Tornado pool bytes are big-endian.

Imported Tornado note strings are a separate case: their payload already contains the secrets and need not be reproducible from this wallet's phrase. The SDK's imported-note ephemeral key is `K(LE_31(nullifier) || UTF8("KOHAKU7702"))`.

## 6. Test vectors

**All keys, signatures, and notes below are public test data. Never fund them.**

The inputs are the mnemonic `test test test test test test test test test test test junk`, empty BIP-39 passphrase, `accountIndex = 0`, and Ethereum mainnet `chainId = 1`. The Privacy Pools v1 entrypoint is `0x6818809eefce719e480a7526d76bd3e561526b46`. The Tornado examples use the classic 0.1 ETH and 1 ETH pools.

The three Privacy Pools v1 signature vectors cover `(depositIndex, secretIndex) = (0,0), (0,1), (1,0)`. The Tornado vectors cover nonce 0 at two different pools, followed by nonce 1. The repeated-nonce pair deliberately demonstrates historical reuse: **the signature is identical, although the pool-bound secrets and commitments differ. It is not a recommended allocation pattern.**

Integer outputs such as `nullifier`, `salt`, and commitments are shown as 32-byte **big-endian numeric hex**. Fields ending in `Bytes31LE` instead contain the original byte sequences that Tornado interprets little-endian. Chain IDs and example values use decimal strings where needed for JSON.

```json
{
  "mnemonic": "test test test test test test test test test test test junk",
  "bip39Passphrase": "",
  "bip39Seed": "0x9dfc3c64c2f8bede1533b6a79f8570e5943e0b8fd1cf77107adf7b72cef42185d564a3aee24cab43f80e3c4538087d70fc824eabbad596a23c97b6ee8322ccc0",
  "bip32MasterPrivateKey": "0xada5f7928ef8f684afa7b06929b5d1f653e486b52077ba9d798eded96c851ade",
  "bip32MasterChainCode": "0xa6001a33d7f033eb872b5e95587fe2053a2df53d546ba932637f2ab7a8cff940",
  "signingIdentities": [
    {
      "protocol": "privacyPoolsV1",
      "path": "m/28784'/1'/0'",
      "privateKey": "0x6f969d170502f417b9eb371f6ca7b6d9b996710aa1dad07f45b38d47e0d32f6d",
      "address": "0xe73C1d0E11Ae7d18c982be6373ee4Abaa26bd5a0"
    },
    {
      "protocol": "tornadoCash",
      "path": "m/29795'/1'/0'",
      "privateKey": "0xf3baaac3dc7cbbf11599bb51a974d1634bcaf0842bbf1d5e55bf568a3b6ce439",
      "address": "0x55581298Be7fd04D2A286626e5934C3626360c31"
    }
  ],
  "domains": {
    "privacyPoolsV1": {
      "name": "PrivacyPools Keychain",
      "version": "1",
      "chainId": 1,
      "verifyingContract": "0x6818809eefce719e480a7526d76bd3e561526b46",
      "salt": "0xb6894604fd8d2640438ce98c9942ba07efb283528908c5d676845afe2a2edee2",
      "domainSeparator": "0x681fe94bd8a236817cdf067a731fb9824d1b182482cec7ad881a9a350136d5fa"
    },
    "tornadoCash": {
      "name": "TornadoCash Keychain",
      "version": "1",
      "chainId": "1",
      "salt": "0xc11237b977418c705d2b06da702566cbfab6ece8e4139395f03c66a91899af6f",
      "domainSeparator": "0x29894e214922a12cebe495eac0165e54143fa81758bef5d88461ee0f3e56a5b2"
    }
  },
  "privacyPoolsV1": [
    {
      "chainId": "1",
      "entrypointAddress": "0x6818809eefce719e480a7526d76bd3e561526b46",
      "depositIndex": 0,
      "secretIndex": 0,
      "eip712Digest": "0xc8c3d04b5f48f895608e8d4b853d1013885686407bb39e290086355e932d4ec6",
      "signature": "0x813f643b699d9d187df58492ccce0db79a1d316918cbc864a44ebf58ef1e3167307447fd7eaf063179a86cbf2be071bd215b88b3c2ceb74a73e7cc3f5db50f581b",
      "canonicalRS": "0x813f643b699d9d187df58492ccce0db79a1d316918cbc864a44ebf58ef1e3167307447fd7eaf063179a86cbf2be071bd215b88b3c2ceb74a73e7cc3f5db50f58",
      "nullifierBytes31": "0xd47f5a73641ee002071aee1b9ee8290eaacc8ff827eaf76aedd1d6065d7d03",
      "saltBytes31": "0xd17688277703da039f5c849a9cea6b62f5341447ed4bf7991d901d746e4063",
      "nullifier": "0x00d47f5a73641ee002071aee1b9ee8290eaacc8ff827eaf76aedd1d6065d7d03",
      "salt": "0x00d17688277703da039f5c849a9cea6b62f5341447ed4bf7991d901d746e4063",
      "precommitment": "0x113b746bad49d84f68934bc64dbba84ac91ffaefd22a145d77435da059a1f243",
      "nullifierHash": "0x11627b01152407007ddea5cb47781c59065ec8eb3e07d500fc0009c55ed961bf",
      "ephemeralPrivateKey": "0x003c11ce314d5c1e2aec5a0bab2525f3b64f79f203110909e2568d5e10526acf",
      "ephemeralAddress": "0x2Cb26931787f99385540260E278E628781fa47A2",
      "exampleValue": "1000000000000000000",
      "exampleLabel": "42",
      "exampleCommitment": "0x20412430009ce2db9d8549a1cdc5985810890d91218ea53392ac7ca113fccec8"
    },
    {
      "chainId": "1",
      "entrypointAddress": "0x6818809eefce719e480a7526d76bd3e561526b46",
      "depositIndex": 0,
      "secretIndex": 1,
      "eip712Digest": "0xc24874fead89fa059e27cccc1e359d4a07c7fd85d9ef8b8a8923e9a36d21fbe6",
      "signature": "0x396e7fc1e8d4b9f710c1255a5aced23011cd46a10b73863b51ad1796817673230e367bc975fdcad7c247f81805e96d9098d4e018d9fc246c9d73a23b4a159c331c",
      "canonicalRS": "0x396e7fc1e8d4b9f710c1255a5aced23011cd46a10b73863b51ad1796817673230e367bc975fdcad7c247f81805e96d9098d4e018d9fc246c9d73a23b4a159c33",
      "nullifierBytes31": "0x6720b4f3b26d4fe34d56e25deac76a657a4e58af189e0a29aacb8630f58945",
      "saltBytes31": "0xc388a0be8116db2281931cddb0f67aeab846e0c4abd7e3ca7dd90c3d76e900",
      "nullifier": "0x006720b4f3b26d4fe34d56e25deac76a657a4e58af189e0a29aacb8630f58945",
      "salt": "0x00c388a0be8116db2281931cddb0f67aeab846e0c4abd7e3ca7dd90c3d76e900",
      "precommitment": "0x2e8b55f741d17e8b885f5bf8181474b595ec5ecfe474c7d78a71546f7f66d217",
      "nullifierHash": "0x1070be8863d9282ac5bf7a22c1430fa6ad7743b24ff5a81c1b27c3605b788ad9",
      "ephemeralPrivateKey": "0x005cade1cc3fa063d00b63796752f25f7080bad9b8add0dce0015b7184a844fa",
      "ephemeralAddress": "0xE40E1aad07767F64C92Cf76Bb35b98770e94d78f",
      "exampleValue": "1000000000000000000",
      "exampleLabel": "42",
      "exampleCommitment": "0x25c102bd62aedc7e3db32fa7a49d30e617f6c8fab80ff6ebbc44dadd6edf35ca"
    },
    {
      "chainId": "1",
      "entrypointAddress": "0x6818809eefce719e480a7526d76bd3e561526b46",
      "depositIndex": 1,
      "secretIndex": 0,
      "eip712Digest": "0x4e96dfb9f84834636dda8ca55cf05fdaff9ded5c073080ceb3293e307d193410",
      "signature": "0x3c09fe4393d43ae3838eeaa81bb7c518f6026ffdc56acccd35b6bc6602cf8c0e0f3a47a6c8af165688bec6c62004736067dc6767d36702fff67a7dc6b52363141b",
      "canonicalRS": "0x3c09fe4393d43ae3838eeaa81bb7c518f6026ffdc56acccd35b6bc6602cf8c0e0f3a47a6c8af165688bec6c62004736067dc6767d36702fff67a7dc6b5236314",
      "nullifierBytes31": "0xa6c3d4ff1c558f6cdac06a3f058d3d25094399f92c4278831397f64a80e58b",
      "saltBytes31": "0x3c4352ad1afc0fd614278fc473d49e76b00be83d5d50968e0e2d86e7588842",
      "nullifier": "0x00a6c3d4ff1c558f6cdac06a3f058d3d25094399f92c4278831397f64a80e58b",
      "salt": "0x003c4352ad1afc0fd614278fc473d49e76b00be83d5d50968e0e2d86e7588842",
      "precommitment": "0x04c5b7732140521fef722742e298ff03deb3b354893013052a4538d8b5b4051c",
      "nullifierHash": "0x2f4d7e710648da30275d01ee9a12d1561266fb5eed1cb3b297eabb3da5dd7b7e",
      "ephemeralPrivateKey": "0x003af0cd3653ca8143fbe7e1189106d122009bb77bb61b3f743638fae7da9dd6",
      "ephemeralAddress": "0x078ABbB7f2cd0B6235228753577543011aBc3740",
      "exampleValue": "1000000000000000000",
      "exampleLabel": "42",
      "exampleCommitment": "0x1f13542484e1564f84a454cf7d27164a90e486c81bb3de1fe2bf8552f3cec33c"
    }
  ],
  "tornadoCash": [
    {
      "chainId": "1",
      "poolAddress": "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
      "nonce": 0,
      "eip712Digest": "0x0689bc25b1186d35225f153ccbefbae815389ab73160fe51a84a8b2c407ec3f7",
      "signature": "0x1b6ec824c3055eacbee01023f7963bcbc41bf8d0ce1211605ddc88a29b62a5954d33b6355c3c8d3b9a3376dc5641d08af0522cc7b20d2a8c316315504de3a1dc1b",
      "canonicalRS": "0x1b6ec824c3055eacbee01023f7963bcbc41bf8d0ce1211605ddc88a29b62a5954d33b6355c3c8d3b9a3376dc5641d08af0522cc7b20d2a8c316315504de3a1dc",
      "nullifierBytes31LE": "0x2936e09f4693fb09e4a6dd32c68ee8fe50a5520c953ecc315933d8cb80f2ed",
      "secretBytes31LE": "0x6787d5c9f4b26151316a1cc7a5413c9a57c4f026e1ed7f8b54e45be39e84cf",
      "preimage62": "0x2936e09f4693fb09e4a6dd32c68ee8fe50a5520c953ecc315933d8cb80f2ed6787d5c9f4b26151316a1cc7a5413c9a57c4f026e1ed7f8b54e45be39e84cf",
      "nullifier": "0x00edf280cbd8335931cc3e950c52a550fee88ec632dda6e409fb93469fe03629",
      "salt": "0x00cf849ee35be4548b7fede126f0c4579a3c41a5c71c6a315161b2f4c9d58767",
      "commitment": "0x2904ed31a6f27f316cd1e118041329c86236a8d8db82c6944c31f2d613de62a2",
      "nullifierHash": "0x2cc71e53f3e0ce4a9ba885a69827e693e3bd8e13ecff07f3e3ff65d56c80106b",
      "ephemeralPrivateKey": "0x00076bafbd289e6c993eb74d576528507f7e4b9b5427368506bce8c55b8dc434",
      "ephemeralAddress": "0x5C789BED51B2Aa64C4b4EC53131a3401f8FcA694"
    },
    {
      "chainId": "1",
      "poolAddress": "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936",
      "nonce": 0,
      "eip712Digest": "0x0689bc25b1186d35225f153ccbefbae815389ab73160fe51a84a8b2c407ec3f7",
      "signature": "0x1b6ec824c3055eacbee01023f7963bcbc41bf8d0ce1211605ddc88a29b62a5954d33b6355c3c8d3b9a3376dc5641d08af0522cc7b20d2a8c316315504de3a1dc1b",
      "canonicalRS": "0x1b6ec824c3055eacbee01023f7963bcbc41bf8d0ce1211605ddc88a29b62a5954d33b6355c3c8d3b9a3376dc5641d08af0522cc7b20d2a8c316315504de3a1dc",
      "nullifierBytes31LE": "0xd13d07e706c8c4ded1e1d0cfe16df333ae6f8197bb6afe52b6f7725de7d289",
      "secretBytes31LE": "0x3d0bd9893d0398640a72be52823473376e739203b47928fec1988b83b6c100",
      "preimage62": "0xd13d07e706c8c4ded1e1d0cfe16df333ae6f8197bb6afe52b6f7725de7d2893d0bd9893d0398640a72be52823473376e739203b47928fec1988b83b6c100",
      "nullifier": "0x0089d2e75d72f7b652fe6abb97816fae33f36de1cfd0e1d1dec4c806e7073dd1",
      "salt": "0x0000c1b6838b98c1fe2879b40392736e3773348252be720a6498033d89d90b3d",
      "commitment": "0x063de91e46f3680f79585700f4171a1faf774aee864df9adac4d5d291191a4b4",
      "nullifierHash": "0x2c090dbeff068f2ea1a4b9004f2f925c147b7b981fd3c04c99fc9c1dda059931",
      "ephemeralPrivateKey": "0x00ee59f8f96abd0e16a944a2c595134a8469416ae5fd13c0b15a556b4dd4e6e5",
      "ephemeralAddress": "0x4445ef2546413d2cc34C20BC31c79fCfcc19CF09"
    },
    {
      "chainId": "1",
      "poolAddress": "0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936",
      "nonce": 1,
      "eip712Digest": "0xb1a69ccc0091b72e1944ed6463b319a6c805a9e3c2558dcd181c0284124e50f5",
      "signature": "0x4502058151b11d830257746493bcf08486b8c99823b1b0242c15ecf19f9bc696643dc604847648b11a5af52e93c19cd21bb4a6510c65b03987fb0ce1760375f31b",
      "canonicalRS": "0x4502058151b11d830257746493bcf08486b8c99823b1b0242c15ecf19f9bc696643dc604847648b11a5af52e93c19cd21bb4a6510c65b03987fb0ce1760375f3",
      "nullifierBytes31LE": "0x8a0ee012521372148e86e537408fb5c7c16772d4e39b0e356bbd5d6bc8305c",
      "secretBytes31LE": "0x0f7ca3032dc15edda35f687d4e0efa9b625e24b78f207ae8928d1319ae9a76",
      "preimage62": "0x8a0ee012521372148e86e537408fb5c7c16772d4e39b0e356bbd5d6bc8305c0f7ca3032dc15edda35f687d4e0efa9b625e24b78f207ae8928d1319ae9a76",
      "nullifier": "0x005c30c86b5dbd6b350e9be3d47267c1c7b58f4037e5868e1472135212e00e8a",
      "salt": "0x00769aae19138d92e87a208fb7245e629bfa0e4e7d685fa3dd5ec12d03a37c0f",
      "commitment": "0x2e90a26308079a3fc08a0f6fa482c7c975a95c4b1cbd588517a829d215052d08",
      "nullifierHash": "0x232b673c483d06809d08310cba6987b3c4b06054e6a922cfc52ab2789f55d8c2",
      "ephemeralPrivateKey": "0x004825aed98c3b056a1ebcc3b11bd926bfcec0b31ed3d68a16d624959c9f3d3f",
      "ephemeralAddress": "0xe23d8505C1332786514d3cD3f7442e7d4D74fac2"
    }
  ],
  "legacy": {
    "privacyPoolsV1": {
      "chainId": "1",
      "entrypointAddress": "0x6818809eefce719e480a7526d76bd3e561526b46",
      "depositIndex": 0,
      "secretIndex": 0,
      "nullifierKeyPath": "m/28784'/1'/0'/0'/0'/0'",
      "saltKeyPath": "m/28784'/1'/0'/1'/0'/0'",
      "signerKeyPath": "m/28784'/1'/0'/2'/0'/0'",
      "rawNullifierKey": "0x9e0895417759a8aea97e406f88ecd05cd8829bb967541f702e5ef70726f8e3f4",
      "rawSaltKey": "0xe90bf708e4d2d1998dfa8d4b503b543a6da58ba6d07ccbee5083d88b7868d503",
      "nullifier": "0x2dfc695f25feec47cf79b602fc23ad1ffc7c9913008fa1efbd4f030129514a5b",
      "salt": "0x1c23157d0c69be9dddcdc99abe049a0c3fc4da1aa5b06d59785fda7215738ac1",
      "precommitment": "0x2049349e1263f092444696ec0b0eb8509f5a8b9918deb9ac0b8b20925b707e30",
      "nullifierHash": "0x20d1e06153dbec3328162b04836f23e0d1b235887de9070a46048869234d15df",
      "ephemeralPrivateKey": "0x0fbb402c34b07571640c22a91050d712b852cfc54e253108882b297a8041096c"
    },
    "tornadoCash": {
      "chainId": "1",
      "poolAddress": "0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc",
      "depositIndex": 0,
      "nullifierKeyPath": "m/29795'/1'/0'/0'/0'",
      "saltKeyPath": "m/29795'/1'/0'/1'/0'",
      "signerKeyPath": "m/29795'/1'/0'/2'/0'",
      "rawNullifierKey": "0xfbacca299e0ca85912be6504b1704b0678e24a97f3950b380fde51f6ebac937a",
      "rawSaltKey": "0xde7f132b62a8d7aab9c4ef17847b791dd7d577688eea5042053ea0d5d909ab37",
      "nullifier": "0x00b4c222760f133eeddaada6be2e260579402aa4d9cffad779305abeaebedea3",
      "salt": "0x00a8dfc9ba3f0ebf5c7a4ff067f84fd569e703dea46a24d7791e276492c40619",
      "commitment": "0x02b8b078d5c40644f7a021b036a365ee9b146e14e2530e2dc9fc716b01cf5c25",
      "nullifierHash": "0x0960c82814e3b8f4c0b899831040fce438eb3ab05f5e02b79a1bb07a409ddaff",
      "ephemeralPrivateKey": "0xb07e4b5f20e007e3ba85011a8095501d672813a1ab4da80e52a746eabaf62720"
    }
  }
}
```

## 7. Reproduce and verify

Save the JavaScript block below as `vectors.mjs`. With Node.js 22 or later, install these exact direct dependencies in a scratch directory:

```sh
npm init -y
npm install --save-exact @kohaku-eth/privacy-pools@0.1.0-alpha.37 @kohaku-eth/tornado-cash@0.1.0-alpha.34 derive-railgun-keys@0.1.0 ethereum-cryptography@3.2.0 viem@2.55.19 ethers@6.13.5 maci-crypto@2.5.0 @zk-kit/poseidon-cipher@0.3.2 micro-zk-proofs@0.3.1 tsx@4.23.12
node --import tsx vectors.mjs > actual.json
```

`tsx` is used here to resolve an extensionless import in the published Privacy Pools v1 SDK. The verifier runs entirely locally: it makes no RPC calls or transactions.

It checks BIP-39/BIP-32 outputs against the CLI's mnemonic helper and ethers, EIP-712 digests and signatures against both viem and ethers, and the derived secrets/ephemeral keys against the installed SDKs. Its JSON output must match the vector block above. The legacy entries verify the older HD formulas too.

```js
import assert from 'node:assert/strict';
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { HDKey } from 'ethereum-cryptography/hdkey.js';
import { Mnemonic } from 'derive-railgun-keys';
import { HDNodeWallet, TypedDataEncoder, Wallet } from 'ethers';
import { concat, hashTypedData, keccak256, parseSignature, stringToHex, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { poseidon } from 'maci-crypto/build/ts/hashing.js';
import { pedersenHash, Point } from 'micro-zk-proofs/pedersen.js';
import { SignatureSecretManager as PP, SecretManager as LegacyPP, KeystoreEnvelopeSigner as PPSigner } from '@kohaku-eth/privacy-pools';
import { SignatureSecretManager as TC, SecretManager as LegacyTC, KeystoreEnvelopeSigner as TCSigner } from '@kohaku-eth/tornado-cash';

const mnemonic = 'test test test test test test test test test test test junk';
const passphrase = '';
const seed = pbkdf2Sync(mnemonic.normalize('NFKD'), `mnemonic${passphrase.normalize('NFKD')}`, 2048, 64, 'sha512');
assert.equal(toHex(seed), Mnemonic.toSeed(mnemonic));
const master = HDKey.fromMasterSeed(seed);
const derive = (path) => {
  const key = toHex(master.derive(path).privateKey);
  assert.equal(key, Mnemonic.to0xPrivateKey(mnemonic, path));
  assert.equal(key, HDNodeWallet.fromPhrase(mnemonic, passphrase, path).privateKey);
  return key;
};
const host = { keystore: { deriveAt: async (path) => derive(path) } };
const accountIndex = 0;
const chainId = 1n;
const entrypointAddress = 0x6818809eefce719e480a7526d76bd3e561526b46n;
const poolA = 0x12d66f87a04a9e220743712ce6d9bb1b5616b8fcn;
const poolB = 0x47ce0c6ed5b0ce3d3a51fdb1c52dc66a7c3c2936n;
const paths = { privacyPoolsV1: "m/28784'/1'/0'", tornadoCash: "m/29795'/1'/0'" };
const order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const rs = (signature) => {
  const { r, s } = parseSignature(signature);
  const value = BigInt(s);
  return concat([r, toHex(value > order / 2n ? order - value : value, { size: 32 })]);
};
const first31 = (digest) => `0x${digest.slice(2, 64)}`;
const fromLE = (hex) => BigInt(`0x${Buffer.from(hex.slice(2), 'hex').reverse().toString('hex')}`);
const le = (value, size) => Uint8Array.from(Buffer.from(value.toString(16).padStart(size * 2, '0'), 'hex').reverse());
const pedersenX = (bytes) => Point.decode(pedersenHash(bytes)).x;
const hx = (value) => toHex(value, { size: 32 });
const hexSecrets = (secrets) => Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, hx(value)]));
const ppTypes = { PrivacyPoolNote: [{ name: 'depositIndex', type: 'uint64' }, { name: 'secretIndex', type: 'uint64' }] };
const tcTypes = { TornadoCashNote: [{ name: 'nonce', type: 'uint64' }] };
const ppDomain = { name: 'PrivacyPools Keychain', version: '1', chainId: 1,
  verifyingContract: toHex(entrypointAddress, { size: 20 }), salt: keccak256(stringToHex('privacypools')) };
const tcDomain = { name: 'TornadoCash Keychain', version: '1', chainId,
  salt: keccak256(stringToHex('tornado')) };
const ppAccount = privateKeyToAccount(derive(paths.privacyPoolsV1));
const tcAccount = privateKeyToAccount(derive(paths.tornadoCash));
const pp = PP({ host, accountIndex });
const tc = await TC({ host, accountIndex });
const output = {
  mnemonic, bip39Passphrase: passphrase, bip39Seed: toHex(seed),
  bip32MasterPrivateKey: toHex(master.privateKey), bip32MasterChainCode: toHex(master.chainCode),
  signingIdentities: Object.entries(paths).map(([protocol, path]) => ({ protocol, path,
    privateKey: derive(path), address: privateKeyToAccount(derive(path)).address })),
  domains: { privacyPoolsV1: { ...ppDomain, domainSeparator: TypedDataEncoder.hashDomain(ppDomain) },
    tornadoCash: { ...tcDomain, chainId: '1', domainSeparator: TypedDataEncoder.hashDomain(tcDomain) } },
  privacyPoolsV1: [], tornadoCash: [], legacy: {},
};
for (const [depositIndex, secretIndex] of [[0, 0], [0, 1], [1, 0]]) {
  const message = { depositIndex: BigInt(depositIndex), secretIndex: BigInt(secretIndex) };
  const envelope = { domain: ppDomain, types: ppTypes, primaryType: 'PrivacyPoolNote', message };
  const digest = hashTypedData(envelope);
  assert.equal(digest, TypedDataEncoder.hash(ppDomain, ppTypes, message));
  const signature = await ppAccount.signTypedData(envelope);
  assert.equal(signature, await new Wallet(derive(paths.privacyPoolsV1)).signTypedData(ppDomain, ppTypes, message));
  assert.equal(signature, await new PPSigner(host.keystore, accountIndex).signEnvelope(envelope));
  assert.equal(signature, await ppAccount.signTypedData(envelope));
  const canonicalRS = rs(signature);
  const tagged = (tag) => first31(keccak256(concat([stringToHex(tag), canonicalRS])));
  const nullifier = BigInt(tagged('nullifier'));
  const salt = BigInt(tagged('salt'));
  const precommitment = poseidon([nullifier, salt]);
  const nullifierHash = poseidon([nullifier]);
  const expected = { nullifier, salt, precommitment, nullifierHash };
  const params = { chainId, entrypointAddress, depositIndex, withdrawIndex: secretIndex };
  assert.deepEqual(await pp.getSecrets(params), expected);
  if (secretIndex === 0) assert.deepEqual(await pp.getDepositSecrets(params), expected);
  const ephemeralPrivateKey = hx(BigInt(tagged('signer')));
  assert.equal(await pp.deriveEphemeralSigner(params), ephemeralPrivateKey);
  output.privacyPoolsV1.push({ chainId: '1', entrypointAddress: toHex(entrypointAddress, { size: 20 }),
    depositIndex, secretIndex, eip712Digest: digest, signature, canonicalRS,
    nullifierBytes31: tagged('nullifier'), saltBytes31: tagged('salt'), ...hexSecrets(expected),
    ephemeralPrivateKey, ephemeralAddress: privateKeyToAccount(ephemeralPrivateKey).address,
    exampleValue: '1000000000000000000', exampleLabel: '42',
    exampleCommitment: hx(poseidon([1000000000000000000n, 42n, precommitment])) });
}
for (const [nonce, poolAddress] of [[0, poolA], [0, poolB], [1, poolB]]) {
  const message = { nonce: BigInt(nonce) };
  const envelope = { domain: tcDomain, types: tcTypes, primaryType: 'TornadoCashNote', message };
  const digest = hashTypedData(envelope);
  assert.equal(digest, TypedDataEncoder.hash(tcDomain, tcTypes, message));
  const signature = await tcAccount.signTypedData(envelope);
  assert.equal(signature, await new Wallet(derive(paths.tornadoCash)).signTypedData(tcDomain, tcTypes, message));
  assert.equal(signature, await new TCSigner(host.keystore, accountIndex).signEnvelope(envelope));
  assert.equal(signature, await tcAccount.signTypedData(envelope));
  const canonicalRS = rs(signature);
  const tagged = (tag) => first31(keccak256(concat([stringToHex(tag), toHex(poolAddress, { size: 20 }), canonicalRS])));
  const nullifierBytes31LE = tagged('nullifier');
  const secretBytes31LE = tagged('secret');
  const preimage62 = concat([nullifierBytes31LE, secretBytes31LE]);
  const expected = { nullifier: fromLE(nullifierBytes31LE), salt: fromLE(secretBytes31LE),
    commitment: pedersenX(Buffer.from(preimage62.slice(2), 'hex')),
    nullifierHash: pedersenX(Buffer.from(nullifierBytes31LE.slice(2), 'hex')) };
  assert.deepEqual(await tc.getSignatureSecrets({ chainId, nonce, poolAddress }), expected);
  const ephemeralPrivateKey = `0x00${tagged('signer').slice(2)}`;
  assert.equal(await tc.deriveSignatureEphemeralSigner({ chainId, nonce, poolAddress }), ephemeralPrivateKey);
  output.tornadoCash.push({ chainId: '1', poolAddress: toHex(poolAddress, { size: 20 }), nonce,
    eip712Digest: digest, signature, canonicalRS, nullifierBytes31LE, secretBytes31LE, preimage62,
    ...hexSecrets(expected), ephemeralPrivateKey, ephemeralAddress: privateKeyToAccount(ephemeralPrivateKey).address });
}
assert.equal(output.tornadoCash[0].signature, output.tornadoCash[1].signature);
assert.notEqual(output.tornadoCash[0].commitment, output.tornadoCash[1].commitment);
const legacyPP = LegacyPP({ host, accountIndex });
const ppNullifierKeyPath = "m/28784'/1'/0'/0'/0'/0'";
const ppSaltKeyPath = "m/28784'/1'/0'/1'/0'/0'";
const ppSignerKeyPath = "m/28784'/1'/0'/2'/0'/0'";
const legacyPPSecrets = {
  nullifier: poseidon([chainId, entrypointAddress, BigInt(derive(ppNullifierKeyPath))]),
  salt: poseidon([chainId, entrypointAddress, BigInt(derive(ppSaltKeyPath))]),
};
legacyPPSecrets.precommitment = poseidon([legacyPPSecrets.nullifier, legacyPPSecrets.salt]);
legacyPPSecrets.nullifierHash = poseidon([legacyPPSecrets.nullifier]);
assert.deepEqual(await legacyPP.getDepositSecrets({ chainId, entrypointAddress, depositIndex: 0 }), legacyPPSecrets);
const ppLegacySigner = hx(poseidon([chainId, entrypointAddress, BigInt(derive(ppSignerKeyPath))]));
assert.equal(await legacyPP.deriveEphemeralSigner({ chainId, entrypointAddress, depositIndex: 0, withdrawIndex: 0 }), ppLegacySigner);
output.legacy.privacyPoolsV1 = { chainId: '1', entrypointAddress: toHex(entrypointAddress, { size: 20 }), depositIndex: 0, secretIndex: 0,
  nullifierKeyPath: ppNullifierKeyPath, saltKeyPath: ppSaltKeyPath, signerKeyPath: ppSignerKeyPath,
  rawNullifierKey: derive(ppNullifierKeyPath), rawSaltKey: derive(ppSaltKeyPath), ...hexSecrets(legacyPPSecrets), ephemeralPrivateKey: ppLegacySigner };
const legacyTC = await LegacyTC({ host, accountIndex });
const tcNullifierKeyPath = "m/29795'/1'/0'/0'/0'";
const tcSaltKeyPath = "m/29795'/1'/0'/1'/0'";
const coalesce = (path) => fromLE(keccak256(concat([le(BigInt(derive(path)), 32), le(chainId, 8), le(poolA, 20)])));
const mask = (1n << 248n) - 1n;
const nullifier = coalesce(tcNullifierKeyPath) & mask;
const salt = coalesce(tcSaltKeyPath) & mask;
const preimage = concat([le(nullifier, 31), le(salt, 31)]);
const legacyTCSecrets = { nullifier, salt, commitment: pedersenX(preimage), nullifierHash: pedersenX(le(nullifier, 31)) };
assert.deepEqual(await legacyTC.getLegacyDepositSecrets({ chainId, poolAddress: poolA, depositIndex: 0 }), legacyTCSecrets);
const tcSignerKeyPath = "m/29795'/1'/0'/2'/0'";
const tcLegacySigner = hx(coalesce(tcSignerKeyPath));
assert.equal(await legacyTC.deriveEphemeralSigner({ chainId, poolAddress: poolA, depositIndex: 0 }), tcLegacySigner);
output.legacy.tornadoCash = { chainId: '1', poolAddress: toHex(poolA, { size: 20 }), depositIndex: 0,
  nullifierKeyPath: tcNullifierKeyPath, saltKeyPath: tcSaltKeyPath, signerKeyPath: tcSignerKeyPath,
  rawNullifierKey: derive(tcNullifierKeyPath), rawSaltKey: derive(tcSaltKeyPath), ...hexSecrets(legacyTCSecrets), ephemeralPrivateKey: tcLegacySigner };
const mac = createHmac('sha512', 'Bitcoin seed').update(seed).digest();
assert.equal(toHex(mac.subarray(0, 32)), output.bip32MasterPrivateKey);
assert.equal(toHex(mac.subarray(32)), output.bip32MasterChainCode);
console.log(JSON.stringify(output, null, 2));
```

## Implementation references

- [Privacy Pools v1 SDK 0.1.0-alpha.37](https://www.npmjs.com/package/@kohaku-eth/privacy-pools/v/0.1.0-alpha.37): published `dist/index.js`, originating from `src/account/signature-keys.ts` and `src/account/keys.ts`.
- [Tornado Cash SDK 0.1.0-alpha.34](https://www.npmjs.com/package/@kohaku-eth/tornado-cash/v/0.1.0-alpha.34): published `dist/index.js`, originating from `src/account/signature-keys.ts`, `src/account/keys.ts`, and `src/utils/proof.util.ts`.
- [derive-railgun-keys 0.1.0](https://www.npmjs.com/package/derive-railgun-keys/v/0.1.0): `Mnemonic.to0xPrivateKey`, used by the CLI's `src/host/keystore.ts`.

## Recommendations

1. **Use a fresh application nonce/index for each new deposit.** For Tornado, allocate across pools and assets for the same signing account and chain. For Privacy Pools v1, do not reset `depositIndex` for each asset pool at an entrypoint; use `secretIndex` to advance its change-note lineage. Keep separate sequences for the two protocols.
2. **A distinct commitment does not prove a distinct signature.** Tornado deliberately binds the pool after signing. If you want one signature to control only one actually created note, never use that signature's nonce for another pool. This is an allocation policy, not a cryptographic restriction: anyone holding that signature can derive its secrets for other pools too. Likewise, Privacy Pools v1's signature does not bind an individual pool, asset, amount, or label.
3. **Check history, not just a local counter.** Before using a candidate, check its derived commitments/precommitment and spent nullifiers across the relevant pools. Both spent and unspent deposits consume their index. The CLI's 0.1.5 preparation checks refreshed history and stops if scan coverage is incomplete.
4. **Coordinate pending preparations.** Mined-history checks cannot detect every unbroadcast or pending external transaction. Use one allocator, or reserve indexes durably across devices and external submission tools if concurrent preparation is allowed. The current CLI does not permanently consume an index for a discarded preview.
5. **Keep old duplicate-nonce notes recoverable.** Do not renumber or reject existing notes solely because two have the same nonce. Retain their scheme, chain, pool, commitment, and other recovery context. Historical Tornado duplicates at different pools still require their original pool-specific derivations and independent spent status.
6. **Treat note signatures as secrets.** A disclosed signature can reveal its derived nullifier, salt, and note-derived EOA key. Keep proving on a trusted host, and request signatures only for the intended envelopes. Never share the account signing private key: it controls all indexes for that protocol account.
7. **Verify hardware signers and retain recovery metadata.** Match these vectors, keep determinism checks enabled, and preserve the exact paths, domains, account/index values, and derivation scheme. Leave room for discovery gaps and keep encrypted backups; a seed phrase reproduces secrets, but a bounded scanner can still miss a high index. Do not silently change formulas for existing notes or assume they specify Privacy Pools v2.
