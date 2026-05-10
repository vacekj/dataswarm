/**
 * WARNING — Swarm root vs dkey-lib “IPFS CID” compatibility shim
 *
 * Freedom Swarm `publishFiles` returns a 32-byte Swarm manifest root as hex (bytes32-style).
 * `dkey-lib` validates listing identifiers with `CID.parse()` and then uses
 * `parsedCid.multihash.digest` as the on-chain listing key (see `formatCID` in dkey-lib).
 * A raw Swarm hex string is not a valid multiformats CID, so the library surfaces `INVALID_CID`.
 *
 * Workaround: wrap the 32 Swarm root bytes in a synthetic CIDv1 (dag-pb codec + sha2-256 **multihash
 * envelope**). The multihash code is not a cryptographic claim about the bytes — it is only the
 * container shape multiformats + dkey-lib require so the same 32 bytes reach the contract.
 *
 * Any path that passes a Swarm manifest root into dkey-lib (createListing, makeBid, fillBid,
 * fetchListingDetails, fetchBids, profile map keys, etc.) must use `swarmRootHexToSyntheticDkeyCid`
 * or `toCanonicalListingKey` first. Swarm HTTP gateways still need the raw hex root: use
 * `listingKeyToSwarmRootHex` before building `/bzz/{hex}/` URLs.
 */

import { getBytes, hexlify } from 'ethers'
import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'

/** dag-pb — chosen to match common IPFS-style CIDv1 layout; see file-level WARNING. */
const DAG_PB_CODEC = 0x70
/** sha2-256 multihash code used only as an envelope; digest bytes are the Swarm root. */
const SHA2_256_MULTIHASH_CODE = 0x12

const is32ByteHex = (trimmed: string) =>
  /^0x[0-9a-fA-F]{64}$/.test(trimmed) || /^[0-9a-fA-F]{64}$/.test(trimmed)

/** True if `input` looks like a raw 32-byte Swarm manifest root (hex), not a multibase CID. */
export function isLikelySwarmRootHex(input: string): boolean {
  return is32ByteHex(input.trim())
}

/** Normalize a Swarm content root to `0x` + 64 lowercase hex (no validation beyond length). */
export function normalizeSwarmRootHex(reference: string): string {
  const trimmed = reference.trim()
  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) return trimmed.toLowerCase()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return `0x${trimmed.toLowerCase()}`
  throw new Error(`Expected 32-byte Swarm root hex, got: ${trimmed.slice(0, 24)}…`)
}

/** Convert manifest root hex → synthetic CID string for dkey-lib / on-chain listing id. */
export function swarmRootHexToSyntheticDkeyCid(swarmRootHex: string): string {
  const hex = normalizeSwarmRootHex(swarmRootHex)
  const digest = getBytes(hex)
  if (digest.length !== 32) {
    throw new Error(`Swarm manifest root must be 32 bytes (got ${digest.length})`)
  }
  const multihash = Digest.create(SHA2_256_MULTIHASH_CODE, digest)
  return CID.createV1(DAG_PB_CODEC, multihash).toString()
}

/**
 * Recover the Swarm `/bzz/{hex}/` root from either a legacy hex reference or a synthetic listing CID.
 */
export function listingKeyToSwarmRootHex(listingKey: string): string {
  const trimmed = listingKey.trim()
  if (is32ByteHex(trimmed)) {
    return normalizeSwarmRootHex(trimmed)
  }
  const cid = CID.parse(trimmed)
  const digest = cid.multihash.digest
  if (digest.length !== 32) {
    throw new Error(`Listing CID multihash digest must be 32 bytes (got ${digest.length})`)
  }
  return (hexlify(digest) as string).toLowerCase()
}

/**
 * Canonical listing key for URLs, profile maps, and dkey-lib: synthetic CID if input is Swarm hex,
 * otherwise unchanged valid CID string.
 */
export function toCanonicalListingKey(input: string): string {
  const t = input.trim()
  if (!t) throw new Error('Empty listing key')
  if (is32ByteHex(t)) {
    return swarmRootHexToSyntheticDkeyCid(t)
  }
  CID.parse(t)
  return t
}

export function tryCanonicalListingKey(input: string): string {
  try {
    return toCanonicalListingKey(input)
  } catch {
    return input.trim()
  }
}

/** Swarm manifest root (`0x` + 64 hex) for user-visible URLs (`?hash=`) and UI — never the internal synthetic CID string. */
export function listingRefToSwarmRootHexForUrl(ref: string): string {
  return listingKeyToSwarmRootHex(toCanonicalListingKey(ref))
}
