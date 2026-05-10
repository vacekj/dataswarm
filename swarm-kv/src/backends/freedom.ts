import type { SwarmKvBackend } from '../backend.js'

/**
 * Subset of the Freedom browser `window.swarm` API used by {@link createFreedomSwarmBackend}.
 * https://github.com/vacekj/dataswarm (Freedom integration)
 */
export type FreedomSwarmLike = {
  requestAccess?: () => Promise<unknown>
  listFeeds: () => Promise<Array<{ name: string }>>
  createFeed: (params: { name: string }) => Promise<unknown>
  writeFeedEntry: (params: { name: string; data: string | Uint8Array | ArrayBuffer }) => Promise<unknown>
  readFeedEntry: (params: { name: string; index?: number }) => Promise<{
    data: string
    encoding: 'base64'
    index: number
    nextIndex: number | null
  }>
  publishFiles: (params: {
    files: Array<{ path: string; bytes: Uint8Array | ArrayBuffer; contentType?: string }>
    indexDocument?: string
  }) => Promise<{ reference: string; bzzUrl: string; tagUid: number | null }>
}

function entryToBytes(entry: { data: string }): Uint8Array {
  const bin = atob(entry.data)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i)
  }
  return out
}

const BLOB_PATH = 'kv-value.bin'

function normalizedReference(reference: string): string {
  return reference.trim().replace(/^0x/i, '')
}

function appendPath(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}

function blobUrlCandidates(reference: string, bzzUrl: string | undefined, path: string): string[] {
  const root = normalizedReference(reference)
  const pageOrigin = typeof window !== 'undefined' && /^https?:\/\//i.test(window.location.origin) ? window.location.origin : ''
  const candidates = [
    bzzUrl ? appendPath(bzzUrl.trim(), path) : '',
    root ? `bzz://${root}/${path}` : '',
    pageOrigin && root ? `${pageOrigin}/bzz/${root}/${path}` : '',
    root ? `https://gateway.ethswarm.org/bzz/${root}/${path}` : '',
  ]
  return Array.from(new Set(candidates.filter(Boolean)))
}

/**
 * Backend for Freedom Browser's injected Swarm provider. Postage/stamps are handled by the
 * browser when you call `publishFiles` / feed updates — this library never asks you for a batch ID.
 */
export function createFreedomSwarmBackend(swarm: FreedomSwarmLike): SwarmKvBackend {
  return {
    async ensureFeed(name: string) {
      const feeds = await swarm.listFeeds()
      if (feeds.some(f => f.name === name)) return
      await swarm.createFeed({ name })
    },

    async readLatestFeed(name: string) {
      try {
        const entry = await swarm.readFeedEntry({ name })
        return entryToBytes(entry)
      } catch {
        return null
      }
    },

    async writeFeed(name: string, data: Uint8Array) {
      await swarm.writeFeedEntry({ name, data })
    },

    async uploadBlob(data: Uint8Array, contentType = 'application/octet-stream') {
      const uploaded = await swarm.publishFiles({
        files: [{ path: BLOB_PATH, bytes: data, contentType }],
      })
      return {
        reference: uploaded.reference,
        bzzUrl: uploaded.bzzUrl,
        path: BLOB_PATH,
      }
    },

    async downloadBlob(params: { reference: string; bzzUrl?: string; path?: string }) {
      const path = params.path ?? BLOB_PATH
      let last: unknown
      for (const url of blobUrlCandidates(params.reference, params.bzzUrl, path)) {
        try {
          const res = await fetch(url)
          if (!res.ok) {
            throw new Error(`Freedom download failed ${res.status} for ${url}`)
          }
          return new Uint8Array(await res.arrayBuffer())
        } catch (error) {
          last = error
        }
      }
      throw last instanceof Error ? last : new Error(String(last))
    },
  }
}

/** Read `window.swarm` when running inside Freedom. */
export function getFreedomSwarmFromWindow(w: Window & { swarm?: FreedomSwarmLike }): FreedomSwarmLike | null {
  return w.swarm ?? null
}
