import { parseAbi } from "viem";

/** Shared GNS/WNS NameNFT surface (identical write/read shapes for top-level names). */
export const NAME_NFT_ABI = parseAbi([
  "function makeCommitment(string label, address owner, bytes32 secret) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function reveal(string label, bytes32 secret) payable returns (uint256 tokenId)",
  "function renew(uint256 tokenId) payable",
  "function isAvailable(string label, uint256 parentId) view returns (bool)",
  "function getFee(uint256 length) view returns (uint256)",
  "function getPremium(uint256 tokenId) view returns (uint256)",
  "function computeId(string fullName) pure returns (uint256)",
  "function ownerOf(uint256 id) view returns (address)",
  "function resolve(uint256 tokenId) view returns (address)",
  "function expiresAt(uint256 tokenId) view returns (uint256)",
  "function setText(uint256 tokenId, string key, string value)",
  "function setContenthash(uint256 tokenId, bytes hash)",
  "function setPrimaryName(uint256 tokenId)",
  "function setAddr(uint256 tokenId, address addr)",
  "function transferFrom(address from, address to, uint256 id)",
  "function safeTransferFrom(address from, address to, uint256 id)",
]);

export const ENS_CONTROLLER_ABI = parseAbi([
  "function rentPrice(string name, uint256 duration) view returns ((uint256 base, uint256 premium))",
  "function available(string name) view returns (bool)",
  "function makeCommitment(string name, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, bool reverseRecord, uint16 ownerControlledFuses) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register(string name, address owner, uint256 duration, bytes32 secret, address resolver, bytes[] data, bool reverseRecord, uint16 ownerControlledFuses) payable",
  "function renew(string name, uint256 duration) payable",
  "function minCommitmentAge() view returns (uint256)",
]);

export const ENS_REGISTRY_ABI = parseAbi([
  "function owner(bytes32 node) view returns (address)",
  "function resolver(bytes32 node) view returns (address)",
  "function setOwner(bytes32 node, address owner)",
]);

export const ENS_BASE_REGISTRAR_ABI = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function transferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function nameExpires(uint256 id) view returns (uint256)",
]);

export const ENS_NAME_WRAPPER_ABI = parseAbi([
  "function ownerOf(uint256 id) view returns (address)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",
  "function setText(bytes32 node, string key, string value)",
  "function setContenthash(bytes32 node, bytes hash)",
  "function setRecord(bytes32 node, address owner, address resolver, uint64 ttl)",
]);

export const ENS_RESOLVER_ABI = parseAbi([
  "function setText(bytes32 node, string key, string value)",
  "function setContenthash(bytes32 node, bytes hash)",
  "function text(bytes32 node, string key) view returns (string)",
  "function contenthash(bytes32 node) view returns (bytes)",
]);

export const ENS_REVERSE_REGISTRAR_ABI = parseAbi([
  "function setName(string name) returns (bytes32)",
]);
