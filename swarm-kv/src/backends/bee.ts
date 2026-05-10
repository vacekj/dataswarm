import { Bee, PrivateKey, Topic } from '@ethersphere/bee-js'
import type { SwarmKvBackend } from '../backend.js'

export type BeeKvBackendOptions = {
  bee: Bee
  /** Postage batch used for every upload and feed update (transparent to KV callers). */
  postageBatchId: string
  /** Private key that owns feeds — data is private to this identity unless you publish references elsewhere. */
  signer: string | Uint8Array | PrivateKey
}

/**
 * bee-js backend: one feed per key plus an index feed, all stamped with the same postage batch.
 */
export function createBeeKvBackend(options: BeeKvBackendOptions): SwarmKvBackend {
  const signer = options.signer instanceof PrivateKey ? options.signer : new PrivateKey(options.signer)
  const owner = signer.publicKey().address()

  return {
    async ensureFeed() {
      /* Feeds are created implicitly on first uploadPayload */
    },

    async readLatestFeed(name: string) {
      const topic = Topic.fromString(name)
      const reader = options.bee.makeFeedReader(topic, owner)
      try {
        const result = await reader.downloadPayload()
        return new Uint8Array(result.payload.toUint8Array())
      } catch {
        return null
      }
    },

    async writeFeed(name: string, data: Uint8Array) {
      const topic = Topic.fromString(name)
      const writer = options.bee.makeFeedWriter(topic, signer)
      await writer.uploadPayload(options.postageBatchId, data)
    },

    async uploadBlob(data: Uint8Array) {
      const result = await options.bee.uploadData(options.postageBatchId, data)
      return { reference: result.reference.toHex() }
    },

    async downloadBlob(params: { reference: string }) {
      const bytes = await options.bee.downloadData(params.reference)
      return new Uint8Array(bytes.toUint8Array())
    },
  }
}
