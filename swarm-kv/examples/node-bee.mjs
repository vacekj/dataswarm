#!/usr/bin/env node
/**
 * Runnable example against a local Bee (or any Bee URL you pass).
 *
 * Prerequisites:
 *   - Bee node with HTTP API
 *   - An funded postage batch on that node
 *
 * Usage:
 *   BEE_URL=http://localhost:1633 POSTAGE_BATCH=<hex> PRIVATE_KEY=<hex> node examples/node-bee.mjs
 */
import { Bee, PrivateKey } from '@ethersphere/bee-js'
import { createBeeKvBackend, SwarmKvStore } from '../dist/index.js'

const beeUrl = process.env.BEE_URL ?? 'http://localhost:1633'
const batch = process.env.POSTAGE_BATCH
const pk = process.env.PRIVATE_KEY

if (!batch || !pk) {
  console.error('Set POSTAGE_BATCH and PRIVATE_KEY in the environment.')
  process.exit(1)
}

const bee = new Bee(beeUrl)
const backend = createBeeKvBackend({
  bee,
  postageBatchId: batch,
  signer: new PrivateKey(pk),
})

const store = new SwarmKvStore(backend, { namespace: 'demo', inlineMaxBytes: 4096 })

await store.open()

await store.put('greeting', 'hello from swarm-kv')
await store.put('config', { theme: 'dark', notifications: true })
await store.put('blob', new Uint8Array([0, 1, 2, 3]))

console.log('keys:', await store.listKeys())
console.log('greeting:', await store.get('greeting'))
console.log('config:', await store.get('config'))
console.log('blob:', await store.get('blob'))

await store.delete('greeting')
console.log('after delete greeting, keys:', await store.listKeys())
