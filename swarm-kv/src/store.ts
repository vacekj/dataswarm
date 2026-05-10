import type { SwarmKvBackend } from './backend.js'
import { RevisionConflictError } from './errors.js'
import {
  base64ToBytes,
  bytesToBase64,
  decodeEnvelope,
  encodeEnvelope,
  jsonValueFromEnvelope,
  stringValueFromEnvelope,
  type StoredEnvelopeV1,
} from './envelope.js'
import { assertNamespace, indexFeedLabel, keyFeedLabel } from './names.js'
import type { IndexPayloadV1, KvEntry, PutInput, PutOptions, SwarmKvPutResult, SwarmKvStoreOptions, ValueKind } from './types.js'

const te = new TextEncoder()

function emptyIndex(): IndexPayloadV1 {
  return { v: 1, rev: 0, keys: {} }
}

function parseIndex(raw: Uint8Array | null): IndexPayloadV1 {
  if (!raw || raw.length === 0) return emptyIndex()
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as IndexPayloadV1
    if (parsed?.v !== 1 || typeof parsed.rev !== 'number' || typeof parsed.keys !== 'object') {
      return emptyIndex()
    }
    return parsed
  } catch {
    return emptyIndex()
  }
}

function classifyInput(value: PutInput): { kind: ValueKind; bytes: Uint8Array } {
  if (typeof value === 'string') {
    return { kind: 'string', bytes: te.encode(value) }
  }
  if (value instanceof Uint8Array) {
    return { kind: 'binary', bytes: value }
  }
  const json = JSON.stringify(value)
  if (json === undefined) {
    throw new TypeError('JSON values must be JSON-serializable (e.g. not undefined, bigint, or circular)')
  }
  return { kind: 'json', bytes: te.encode(json) }
}

/**
 * High-level KV API on top of Swarm feeds. Each key maps to its own feed; the index feed lists keys.
 */
export class SwarmKvStore {
  private readonly backend: SwarmKvBackend
  private readonly namespace: string
  private readonly indexNamePromise: Promise<string>
  private readonly inlineMaxBytes: number
  private indexChain: Promise<void> = Promise.resolve()

  constructor(backend: SwarmKvBackend, options: SwarmKvStoreOptions) {
    assertNamespace(options.namespace)
    this.backend = backend
    this.namespace = options.namespace
    this.indexNamePromise = indexFeedLabel(options.namespace)
    this.inlineMaxBytes = options.inlineMaxBytes ?? 4096
  }

  private async withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.indexChain
    let release!: () => void
    this.indexChain = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private async readIndex(): Promise<IndexPayloadV1> {
    const raw = await this.backend.readLatestFeed(await this.indexNamePromise)
    return parseIndex(raw)
  }

  private async writeIndex(idx: IndexPayloadV1): Promise<void> {
    const bytes = te.encode(JSON.stringify(idx))
    await this.backend.writeFeed(await this.indexNamePromise, bytes)
  }

  /** Latest index revision (for CAS). */
  async revision(): Promise<number> {
    const idx = await this.readIndex()
    return idx.rev
  }

  async has(key: string): Promise<boolean> {
    const idx = await this.readIndex()
    return Object.prototype.hasOwnProperty.call(idx.keys, key)
  }

  async listKeys(): Promise<string[]> {
    const idx = await this.readIndex()
    return Object.keys(idx.keys).sort()
  }

  async *keys(): AsyncGenerator<string, void, void> {
    for (const k of await this.listKeys()) {
      yield k
    }
  }

  async *entries(): AsyncGenerator<[string, KvEntry], void, void> {
    for (const key of await this.listKeys()) {
      const value = await this.get(key)
      if (value) {
        yield [key, value]
      }
    }
  }

  async get(key: string): Promise<KvEntry | undefined> {
    const idx = await this.readIndex()
    if (!Object.prototype.hasOwnProperty.call(idx.keys, key)) {
      return undefined
    }
    const kFeed = await keyFeedLabel(this.namespace, key)
    const raw = await this.backend.readLatestFeed(kFeed)
    if (!raw) return undefined
    const env = decodeEnvelope(raw)
    const payload = await this.resolvePayload(env)
    if (env.kind === 'string') {
      return { kind: 'string', value: stringValueFromEnvelope(env, payload) }
    }
    if (env.kind === 'json') {
      return { kind: 'json', value: jsonValueFromEnvelope(env, payload) }
    }
    return { kind: 'binary', value: payload }
  }

  private async resolvePayload(env: StoredEnvelopeV1): Promise<Uint8Array> {
    if (env.enc === 'inline') {
      return base64ToBytes(env.b64)
    }
    return this.backend.downloadBlob({
      reference: env.reference,
      bzzUrl: env.bzzUrl,
      path: env.path,
    })
  }

  async put(key: string, value: PutInput, options: PutOptions = {}): Promise<SwarmKvPutResult> {
    const { kind, bytes } = classifyInput(value)
    const inlineMax = options.inlineMaxBytes ?? this.inlineMaxBytes
    const kFeed = await keyFeedLabel(this.namespace, key)

    let envelope: StoredEnvelopeV1
    let blobReference: string | null = null
    if (bytes.length <= inlineMax) {
      envelope = { v: 1, enc: 'inline', kind, b64: bytesToBase64(bytes) }
    } else {
      const uploaded = await this.backend.uploadBlob(
        bytes,
        kind === 'json' ? 'application/json' : kind === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      )
      blobReference = uploaded.reference
      envelope = {
        v: 1,
        enc: 'ref',
        kind,
        reference: uploaded.reference,
        bzzUrl: uploaded.bzzUrl,
        path: uploaded.path,
      }
    }

    const payload = encodeEnvelope(envelope)

    await this.withIndexLock(async () => {
      const indexFeed = await this.indexNamePromise
      await this.backend.ensureFeed(indexFeed)
      const idx = await this.readIndex()
      if (options.ifRevision !== undefined && idx.rev !== options.ifRevision) {
        throw new RevisionConflictError(options.ifRevision, idx.rev)
      }

      await this.backend.ensureFeed(kFeed)
      await this.backend.writeFeed(kFeed, payload)

      idx.rev += 1
      idx.keys[key] = { feed: kFeed }
      await this.writeIndex(idx)
    })

    return { reference: blobReference }
  }

  async delete(key: string, options: Pick<PutOptions, 'ifRevision'> = {}): Promise<boolean> {
    return this.withIndexLock(async () => {
      await this.backend.ensureFeed(await this.indexNamePromise)
      const idx = await this.readIndex()
      if (!Object.prototype.hasOwnProperty.call(idx.keys, key)) {
        return false
      }
      if (options.ifRevision !== undefined && idx.rev !== options.ifRevision) {
        throw new RevisionConflictError(options.ifRevision, idx.rev)
      }
      delete idx.keys[key]
      idx.rev += 1
      await this.writeIndex(idx)
      return true
    })
  }

  /**
   * Prepare feeds for this namespace (optional). Safe to call multiple times.
   */
  async open(): Promise<void> {
    await this.backend.ensureFeed(await this.indexNamePromise)
  }
}
