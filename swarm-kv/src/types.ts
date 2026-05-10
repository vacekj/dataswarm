export type ValueKind = 'string' | 'json' | 'binary'

/** Value returned from {@link SwarmKvStore.get} */
export type KvEntry =
  | { kind: 'string'; value: string }
  | { kind: 'json'; value: unknown }
  | { kind: 'binary'; value: Uint8Array }

/** String, binary, or any JSON-serializable value (objects, arrays, primitives). */
export type PutInput = string | Uint8Array | unknown

export interface PutOptions {
  /**
   * Optimistic concurrency for the shared index feed: only commit if the index revision
   * still matches. Helps when multiple tabs or devices update the same namespace.
   */
  ifRevision?: number
  /**
   * Override inline threshold (bytes). Values larger than this are uploaded as a blob
   * and referenced from the key feed.
   */
  inlineMaxBytes?: number
}

/** Result of {@link SwarmKvStore.put}: Swarm content address when the value was uploaded as a blob; otherwise null (inline in the key feed). */
export type SwarmKvPutResult = { reference: string | null }

export interface SwarmKvStoreOptions {
  /** Isolates keys/feeds per app area (alphanumeric + `._-`, max 64 chars). */
  namespace: string
  /**
   * Values larger than this are stored as a Swarm upload; smaller payloads live inline in the feed.
   * @default 4096
   */
  inlineMaxBytes?: number
}

export type IndexPayloadV1 = {
  v: 1
  /** Monotonic counter used for optional CAS via {@link PutOptions.ifRevision} */
  rev: number
  keys: Record<
    string,
    {
      /** Feed / topic name for this key (debugging); not required for reads */
      feed: string
    }
  >
}
