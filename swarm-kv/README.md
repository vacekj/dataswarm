# swarm-kv

A small **key-value library on top of Swarm** with a familiar `get` / `put` / `delete` surface.  
Internally it uses **one feed per key** plus a single **index feed** per namespace. You do not need to know about topics, single-owner chunks, or feed indexes to use it.

- **Values:** UTF-8 strings, JSON-serializable objects, and raw `Uint8Array` binary.
- **Listing:** `listKeys()`, async iteration via `keys()` and `entries()`.
- **Postage:** On **Freedom Browser**, stamps are handled when the injected Swarm provider uploads data—you never pass a batch ID. On **bee-js**, you configure one `postageBatchId` on the backend once; the library reuses it for every operation.
- **Privacy:** Data is written under the identity that owns the feeds (Freedom’s app-scoped identity or your Ethereum private key in bee-js). Nothing is “public” unless you share references out of band.

## Install

From this monorepo folder:

```bash
cd swarm-kv
npm install
npm run build
```

In another package (after `npm pack` or workspace linking):

```bash
npm install swarm-kv
```

Peer workflow: use Node **20.19+** or **22+** where possible (matches modern Vite / tooling elsewhere in the repo).

## Quick start (Freedom Browser)

Freedom exposes `window.swarm` with feeds and uploads. This matches the `SwarmProvider` shape used in the `app/` demo.

```typescript
import {
  SwarmKvStore,
  createFreedomSwarmBackend,
  getFreedomSwarmFromWindow,
} from 'swarm-kv'

const swarm = getFreedomSwarmFromWindow(window)
if (!swarm) throw new Error('Open this app in Freedom')

await swarm.requestAccess?.()

const store = new SwarmKvStore(createFreedomSwarmBackend(swarm), {
  namespace: 'my-dapp-settings',
})

await store.open()

await store.put('theme', 'dark')
await store.put('profile', { handle: 'alice', level: 3 })
await store.put('avatar-png', someUint8Array)

const theme = await store.get('theme')
// { kind: 'string', value: 'dark' }

const keys = await store.listKeys()
for await (const [k, entry] of store.entries()) {
  console.log(k, entry.kind)
}
```

**Large values:** anything bigger than `inlineMaxBytes` (default **4096** bytes) is uploaded with `publishFiles`, and only a pointer is stored in the key’s feed—still one `put` call from your perspective.

## Quick start (bee-js / Node)

You need a Bee HTTP endpoint and a funded postage batch.

```typescript
import { Bee, PrivateKey } from '@ethersphere/bee-js'
import { createBeeKvBackend, SwarmKvStore } from 'swarm-kv'

const bee = new Bee('http://localhost:1633')
const signer = new PrivateKey(process.env.PRIVATE_KEY!)

const store = new SwarmKvStore(
  createBeeKvBackend({
    bee,
    postageBatchId: process.env.POSTAGE_BATCH!,
    signer,
  }),
  { namespace: 'my-service' },
)

await store.open()
await store.put('job-queue-state', { cursor: 42 })
```

### Runnable Node example

After `npm run build`:

```bash
cd swarm-kv
BEE_URL=http://localhost:1633 POSTAGE_BATCH=0x... PRIVATE_KEY=0x... node examples/node-bee.mjs
```

## API

| Method | Description |
|--------|-------------|
| `open()` | Ensures the index feed exists (Freedom). Safe to call repeatedly. |
| `put(key, value, options?)` | Stores a string, JSON object, or `Uint8Array`. |
| `get(key)` | Returns `{ kind, value }` or `undefined` if the key is unknown. |
| `has(key)` | Boolean membership without loading the value payload. |
| `delete(key, options?)` | Removes the key from the **index** (value chunks may remain on Swarm). |
| `listKeys()` | Sorted list of keys. |
| `keys()` / `entries()` | Async iterators for streaming. |
| `revision()` | Current index revision (monotonic counter). |

### `put` options

- `ifRevision` — optimistic concurrency: throw `RevisionConflictError` if the index changed.
- `inlineMaxBytes` — per-call override of the inline vs blob threshold.

### Concurrency

The library **serializes index updates** inside a single JavaScript runtime (mutex on the index feed).  
Across devices or tabs, two writers can still race; use `revision()` + `put(..., { ifRevision })` / `delete(..., { ifRevision })` for compare-and-swap semantics. Fully decentralized merge is a nice-to-have and is not implemented here.

### Limits & edge cases

- **Namespace** must match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`.
- **Keys** are arbitrary UTF-8 strings up to **2048** characters; they are hashed for the per-key feed label.
- **Very large key sets:** the index is a JSON object in one feed payload—practical for thousands of small keys, not millions. A future version could shard the index with Mantaray manifests.
- **Deletion** removes visibility in the KV API; immutable Swarm content is not erased.

## Design notes (for reviewers / mentors)

- **Feeds:** each logical key maps to `swarm-kv:v1:ns:<namespace>:k:<sha256(namespace + "\\0" + key)>`. The index lives at `swarm-kv:v1:ns:<namespace>:__index__`.
- **Manifests:** large values use the platform upload path (Freedom `publishFiles`, Bee `uploadData`), which resolves to retrievable manifest/data references without exposing manifest APIs to the developer.
- **Postage:** bee backend injects the batch on every feed write and blob upload; Freedom relies on the browser’s stamp UX.

## License

MIT
