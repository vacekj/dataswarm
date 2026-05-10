export { SwarmKvStore } from './store.js'
export type {
  IndexPayloadV1,
  KvEntry,
  PutInput,
  PutOptions,
  SwarmKvPutResult,
  SwarmKvStoreOptions,
  ValueKind,
} from './types.js'
export type { SwarmKvBackend } from './backend.js'
export {
  KeyNotFoundError,
  RevisionConflictError,
  SwarmKvError,
  InvalidKeyError,
} from './errors.js'
export { createFreedomSwarmBackend, getFreedomSwarmFromWindow, type FreedomSwarmLike } from './backends/freedom.js'
export { createBeeKvBackend, type BeeKvBackendOptions } from './backends/bee.js'
