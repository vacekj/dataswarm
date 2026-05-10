import { sha256Hex } from './crypto.js'
import { InvalidKeyError } from './errors.js'

const NS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/** Freedom / Swarm named feeds are capped at 64 characters. */
export const MAX_FEED_NAME_LENGTH = 64

const PREFIX_INDEX = 'kv2I'
const PREFIX_KEY = 'kv2K'
const HASH_HEX_LEN = MAX_FEED_NAME_LENGTH - PREFIX_INDEX.length

if (PREFIX_INDEX.length !== PREFIX_KEY.length || HASH_HEX_LEN !== MAX_FEED_NAME_LENGTH - PREFIX_KEY.length) {
  throw new Error('swarm-kv: index/key feed prefixes must be the same length')
}

export function assertNamespace(namespace: string): void {
  if (!NS_RE.test(namespace)) {
    throw new InvalidKeyError(
      'namespace must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/ (start with alphanumeric, max 64 chars)',
    )
  }
}

export function assertKey(key: string): void {
  if (key.length === 0) throw new InvalidKeyError('key must be a non-empty string')
  if (key.length > 2048) throw new InvalidKeyError('key exceeds 2048 characters')
}

function assertFeedName(name: string): void {
  if (name.length > MAX_FEED_NAME_LENGTH) {
    throw new InvalidKeyError(`internal: feed name exceeds ${MAX_FEED_NAME_LENGTH} characters`)
  }
}

/** Stable feed label for the key index (one feed per namespace). Always ≤ 64 chars for Freedom. */
export async function indexFeedLabel(namespace: string): Promise<string> {
  assertNamespace(namespace)
  const hex = (await sha256Hex(`swarm-kv/2/index\0${namespace}`)).slice(0, HASH_HEX_LEN)
  const name = `${PREFIX_INDEX}${hex}`
  assertFeedName(name)
  return name
}

/**
 * Per-key feed label. Uses a hash so arbitrary UTF-8 keys always fit provider limits. Always ≤ 64 chars.
 */
export async function keyFeedLabel(namespace: string, key: string): Promise<string> {
  assertKey(key)
  const hex = (await sha256Hex(`swarm-kv/2/key\0${namespace}\0${key}`)).slice(0, HASH_HEX_LEN)
  const name = `${PREFIX_KEY}${hex}`
  assertFeedName(name)
  return name
}
