/**
 * Minimal storage port — hides feeds, topics, SOCs, and postage batch wiring.
 */
export interface SwarmKvBackend {
  /** Ensure a named feed exists (Freedom); no-op or lazy for bee-js. */
  ensureFeed(name: string): Promise<void>

  readLatestFeed(name: string): Promise<Uint8Array | null>

  writeFeed(name: string, data: Uint8Array): Promise<void>

  /**
   * Upload raw bytes (postage / stamps are configured on the backend).
   * Returns a content reference and optional hints for later download in browser contexts.
   */
  uploadBlob(data: Uint8Array, contentType?: string): Promise<{ reference: string; bzzUrl?: string; path?: string }>

  /**
   * Download bytes previously stored with {@link SwarmKvBackend.uploadBlob}.
   * Implementations may use `reference` alone (bee) or `bzzUrl`+`path` (Freedom manifest uploads).
   */
  downloadBlob(params: { reference: string; bzzUrl?: string; path?: string }): Promise<Uint8Array>
}
