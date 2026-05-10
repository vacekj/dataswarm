import type { ValueKind } from './types.js'

const te = new TextEncoder()
const td = new TextDecoder()

export type StoredEnvelopeV1 =
  | {
      v: 1
      enc: 'inline'
      kind: ValueKind
      b64: string
    }
  | {
      v: 1
      enc: 'ref'
      kind: ValueKind
      reference: string
      /** When set (Freedom uploads), fetch bytes from this Swarm URL + path */
      bzzUrl?: string
      path?: string
    }

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

export function encodeEnvelope(env: StoredEnvelopeV1): Uint8Array {
  return te.encode(JSON.stringify(env))
}

export function decodeEnvelope(raw: Uint8Array): StoredEnvelopeV1 {
  const text = td.decode(raw)
  const parsed = JSON.parse(text) as StoredEnvelopeV1
  if (parsed?.v !== 1 || (parsed.enc !== 'inline' && parsed.enc !== 'ref')) {
    throw new Error('Unsupported or corrupt value envelope')
  }
  return parsed
}

export function jsonValueFromEnvelope(env: StoredEnvelopeV1, bytes: Uint8Array): unknown {
  if (env.kind !== 'json') {
    throw new Error('Internal error: expected json kind')
  }
  return JSON.parse(td.decode(bytes)) as unknown
}

export function stringValueFromEnvelope(env: StoredEnvelopeV1, bytes: Uint8Array): string {
  if (env.kind !== 'string') {
    throw new Error('Internal error: expected string kind')
  }
  return td.decode(bytes)
}
