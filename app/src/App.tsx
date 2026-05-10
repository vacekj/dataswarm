import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import dkey, { BidLite, DkeyUserProfile, ListingMetadata } from 'dkey-lib'
import { formatEther, getAddress, type Address } from 'viem'
import { connect, createConfig, disconnect, getAccount, http, injected } from '@wagmi/core'
import { gnosis } from 'viem/chains'
import { createFreedomSwarmBackend, SwarmKvStore } from 'swarm-kv'
import { ChevronDown, Copy, Info, MoreVertical, User } from 'lucide-react'
import { AppNav } from './components/AppNav'
import { BusyOverlay } from './components/BusyOverlay'
import { KeyIcon } from './components/KeyIcon'
import { Button } from './components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './components/ui/dropdown-menu'
import { Input } from './components/ui/input'
import { listingShareUrl, manifestHttpBaseFromSwarmManifestHint, readRoute, ROUTE_EVENT, writeRoute, type AppRoute } from './routing'
import {
  isLikelySwarmRootHex,
  listingKeyToSwarmRootHex,
  swarmRootHexToSyntheticDkeyCid,
  toCanonicalListingKey,
  tryCanonicalListingKey,
} from './lib/swarmListingCid'

type UploadStatus = {
  tagUid: number
  split: number
  seen: number
  stored: number
  sent: number
  synced: number
  progress: number
  done: boolean
}

type SwarmProvider = {
  requestAccess: () => Promise<{ connected: boolean; origin: string; capabilities: string[] }>
  getCapabilities: () => Promise<{
    specVersion: string
    canPublish: boolean
    reason: string | null
    limits: { maxDataBytes: number; maxFilesBytes: number; maxFileCount: number }
  }>
  publishFiles: (params: {
    files: Array<{ path: string; bytes: Uint8Array | ArrayBuffer; contentType?: string }>
    indexDocument?: string
  }) => Promise<{ reference: string; bzzUrl: string; tagUid: number | null }>
  getUploadStatus: (params: { tagUid: number }) => Promise<UploadStatus>
  createFeed: (params: { name: string }) => Promise<{
    feedId: string
    owner: string
    topic: string
    manifestReference: string
    bzzUrl: string
    identityMode: 'app-scoped' | 'bee-wallet'
  }>
  writeFeedEntry: (params: { name: string; data: string | Uint8Array | ArrayBuffer; index?: number }) => Promise<{ index: number }>
  readFeedEntry: (params: { name?: string; topic?: string; owner?: string; index?: number }) => Promise<{
    data: string
    encoding: 'base64'
    index: number
    nextIndex: number | null
  }>
  listFeeds: () => Promise<Array<{ name: string; topic: string; owner: string; bzzUrl: string }>>
}

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

declare global {
  interface Window {
    swarm?: SwarmProvider
    ethereum?: EthereumProvider
    snarkjs?: unknown
  }
}

type ActivityKind = 'swarm' | 'wallet' | 'chain' | 'file' | 'error' | 'profile'

type ActivityEntry = {
  id: string
  kind: ActivityKind
  label: string
  detail: string
  time: number
  txHash?: string
  reference?: string
}

type RegistryEntry = {
  id: string
  swarmReference: string
  bzzUrl: string
  fileName: string
  fileDescription: string
  fileSizeInBytes: number
  suggestedPriceInEth: number
  chainId: number
  contractAddress: string
  sellerAddress: string
  listingTxHash: string
  listingBlockNumber: string
  createdAt: number
}

type ListingMetadataJSON = {
  seller?: Record<string, unknown>
  fileName?: string
  fileDescription?: string
  fileSizeInBytes?: number
  suggestedPriceInEth?: number
  coverPhotoReference?: string
  coverPhotoLink?: string
  chainIds?: number[]
  listingCreatedAfterBlock?: number
  content?: {
    encryptedPath?: string
    originalType?: string
  }
}

type ListingDetails = {
  howManyDKeysForSale: number
  howManyDKeysSold: number
  priceInEth: number
  royaltyPercentage: number
  listingOwnerAddress: Address
  canDkeysBeSold: boolean
  openBidsCounter: number
  referenceString: string
  fileName: string
  description: string
  fileSizeInBytes?: number
  seller: Record<string, unknown>
  coverPhotoLink: string
  coverPhotoReference: string
  chainIds: number[]
  chainId: number
  listingCreatedAfterBlock: number
  totalBidsPlaced: number
}

type OperationState = {
  key: string
  title: string
  detail: string
  progress: number
}

type ProfileBootstrap =
  | 'idle'
  | 'checking'
  | 'ready'
  | 'needs-wallet'
  | 'needs-swarm'
  | 'needs-create'

type SwarmProfileBackupUi = { kind: 'idle' } | { kind: 'running'; progress: number } | { kind: 'success' }

type CreateProgress = {
  encrypting: number
  uploading: number
  saving: number
}

/** Gnosis Chain — dkey-lib 1.2.4+ deploys DKeyStoreL2 here (chain id 100). */
const DKEY_CHAIN = gnosis
const DKEY_CHAIN_ID = DKEY_CHAIN.id
const DKEY_CHAIN_HEX = `0x${DKEY_CHAIN.id.toString(16)}` as `0x${string}`

const transactionExplorerUrl = (txHash: string) => `${DKEY_CHAIN.blockExplorers.default.url}/tx/${txHash}`
const REGISTRY_FEED = 'dkey-swarm-demo-registry'
const ACTIVITY_FEED = 'dkey-swarm-demo-activity'
const ACTIVITY_STORAGE_KEY = 'dkey.swarm.activity.v1'
const REGISTRY_STORAGE_KEY = 'dkey.swarm.registry.v1'
const PROFILE_STORAGE_KEY = 'dkey.swarm.profile.v1'
/** Single key in swarm-kv holding AES-encrypted profile bytes (from dkey-lib). */
const PROFILE_KV_KEY = 'encrypted-profile-v1'
const PROFILE_BACKUP_DISMISS_PREFIX = 'dkey.swarm.profileBackup.dismissed.'

function profileKvNamespace(address: Address): string {
  return `wallet${address.slice(2).toLowerCase()}`
}

function profileBackupDismissKey(address: Address): string {
  return `${PROFILE_BACKUP_DISMISS_PREFIX}${address.toLowerCase()}`
}

/**
 * dkey-lib checks `profile.addresses[chainId] !== address` with strict string equality.
 * Wagmi / wallets may return checksummed EIP-55 addresses while the profile stores another casing
 * (e.g. from `txReceipt.from`) — normalize by reusing the profile string when it is the same account.
 */
function walletAddressForDkeyProfile(profile: DkeyUserProfile, chainId: number, connected: Address): Address {
  const saved = profile.addresses[chainId]
  if (saved && connected.toLowerCase() === saved.toLowerCase()) {
    return saved
  }
  return getAddress(connected)
}

const PROFILE_ACTIVITY_DETAIL_MAX = 8000

const truncateProfileActivityDetail = (serialized: string) =>
  serialized.length <= PROFILE_ACTIVITY_DETAIL_MAX
    ? serialized
    : `${serialized.slice(0, PROFILE_ACTIVITY_DETAIL_MAX)}… [truncated, ${serialized.length} characters total]`

async function ensureAppSwarmFeeds(swarm: SwarmProvider): Promise<void> {
  try {
    await swarm.createFeed({ name: REGISTRY_FEED })
  } catch {
    /* feed may already exist */
  }
  try {
    await swarm.createFeed({ name: ACTIVITY_FEED })
  } catch {
    /* feed may already exist */
  }
}

/** Request access, read capabilities, and ensure registry + activity feeds when publishing is allowed. */
async function activateSwarmSession(swarm: SwarmProvider): Promise<{
  canPublish: boolean
  reason: string | null
  accessOrigin?: string
}> {
  const access = await swarm.requestAccess?.()
  const accessOrigin =
    access && typeof access === 'object' && 'origin' in access ? String((access as { origin: unknown }).origin) : undefined
  const caps = await swarm.getCapabilities()
  if (!caps.canPublish) return { canPublish: false, reason: caps.reason, accessOrigin }
  await ensureAppSwarmFeeds(swarm)
  return { canPublish: true, reason: null, accessOrigin }
}
const DEFAULT_BID_AMOUNT = '0.0001'
/** Minimum bid amount; six decimal places, step 0.000001 xDAI. */
const MIN_BID_XDAI = 0.000001

const formatError = (error: unknown) => {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

const RESTORE_WRONG_PASSWORD_MESSAGE = 'Wrong password. Try again.'

/** WebCrypto AES decrypt fails with OperationError when the password (key) does not match. */
const isWrongPasswordRestoreError = (error: unknown): boolean => {
  if (error instanceof DOMException && error.name === 'OperationError') return true
  return /operationerror|could not be decrypted|fail(?:ed)? to decrypt|decrypt|bad padding|cipher/i.test(formatError(error))
}

const short = (value?: string) => {
  if (!value) return 'n/a'
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value
}

/** User-facing Swarm manifest root (hex); avoids showing the internal synthetic multiformats string. */
const shortSwarmListingRef = (ref?: string) => {
  if (!ref) return 'n/a'
  try {
    const hex = listingKeyToSwarmRootHex(toCanonicalListingKey(ref))
    return short(hex)
  } catch {
    return short(ref)
  }
}

const swarmListingHashFullDisplay = (ref: string) => {
  try {
    return listingKeyToSwarmRootHex(toCanonicalListingKey(ref))
  } catch {
    return ref.trim()
  }
}

const keyIconHueSeedFromListingRef = (ref: string) => {
  try {
    const hex = listingKeyToSwarmRootHex(toCanonicalListingKey(ref))
    const bare = hex.startsWith('0x') ? hex.slice(2) : hex
    return bare.slice(-6)
  } catch {
    return ref.slice(-6)
  }
}

const formatBytes = (bytes?: number) => {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

const makeActivity = (kind: ActivityKind, label: string, detail: string, extra: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: `${Date.now()}-${crypto.randomUUID()}`,
  kind,
  label,
  detail,
  time: Date.now(),
  ...extra,
})

const loadJSON = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

const normalizeBzzBaseUrl = (bzzUrl: string) => {
  const t = bzzUrl.trim()
  if (t.startsWith('https://') || t.startsWith('http://')) {
    return t.endsWith('/') ? t : `${t}/`
  }
  if (typeof window !== 'undefined' && t.startsWith('/')) {
    const origin = window.location?.origin ?? ''
    if (!origin) return ''
    const abs = `${origin}${t}`
    return abs.endsWith('/') ? abs : `${abs}/`
  }
  return ''
}

const normalizeBzzFetchBaseUrl = (bzzUrl: string) => {
  const t = bzzUrl.trim()
  if (/^bzz:\/\//i.test(t)) return t.endsWith('/') ? t : `${t}/`
  return normalizeBzzBaseUrl(t)
}

/**
 * dkey-lib `Listing` accepts optional `info?: Record<string, unknown>` (constructor + deserialize).
 * We store the Freedom `publishFiles` manifest base here so profile VIEW can prime the same URL.
 */
const LISTING_INFO_SWARM_MANIFEST_BZZ_URL = 'swarmManifestBzzUrl'

const getProfileListingManifestBzzBase = (listing: unknown): string => {
  if (!listing || typeof listing !== 'object') return ''
  const info = (listing as { info?: Record<string, unknown> }).info
  const raw = info?.[LISTING_INFO_SWARM_MANIFEST_BZZ_URL]
  if (typeof raw !== 'string' || !raw.trim()) return ''
  const t = raw.trim()
  const bzz = normalizeBzzFetchBaseUrl(t)
  if (bzz) return bzz
  const fromHint = manifestHttpBaseFromSwarmManifestHint(t)
  if (fromHint) return normalizeBzzBaseUrl(fromHint) || fromHint
  return normalizeBzzBaseUrl(t) || (t.endsWith('/') ? t : `${t}/`)
}

const normalizeManifestBzzBaseHint = (raw?: string): string => {
  const t = raw?.trim()
  if (!t) return ''
  const bzz = normalizeBzzFetchBaseUrl(t)
  if (bzz) return bzz
  const fromHint = manifestHttpBaseFromSwarmManifestHint(t)
  if (fromHint) return normalizeBzzBaseUrl(fromHint) || fromHint
  return normalizeBzzBaseUrl(t) || (t.endsWith('/') ? t : `${t}/`)
}

/** Same-tab hint so `loadListing` can use Freedom's `bzzUrl` before React applies registry state. */
const LISTING_MANIFEST_BZZ_SESSION_KEY = 'dkey.swarm.listingManifestBzz.v1'
/** Long-lived map listingKey → Freedom `/bzz/{root}/` base (survives profile-only navigation when registry row is missing). */
const LISTING_BZZ_BASE_MAP_KEY = 'dkey.swarm.listingBzzBaseByKey.v1'
/** Optional HTTP gateway origin learned only from real HTTP `/bzz/` URLs; native Freedom reads use `bzz://` directly. */
/** Must match `FREEDOM_SWARM_HTTP_ORIGIN_KEY` in `routing.ts` (used when reconstructing `?bzz=` bare roots). */
const FREEDOM_SWARM_HTTP_ORIGIN_KEY = 'dkey.swarm.freedomHttpOrigin.v1'

const normalizeHttpOrigin = (input: string): string => {
  const t = input.trim()
  if (!t) return ''
  if (t.startsWith('/') && typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin
  }
  try {
    const u = new URL(t.includes('://') ? t : `https://${t}`)
    return u.origin
  } catch {
    return ''
  }
}

const stashFreedomSwarmHttpOriginFromUrl = (url: string) => {
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('/')) return
  const base = normalizeBzzBaseUrl(trimmed)
  if (!base) return
  const origin = normalizeHttpOrigin(base)
  if (!origin) return
  try {
    sessionStorage.setItem(FREEDOM_SWARM_HTTP_ORIGIN_KEY, origin)
  } catch {
    /* */
  }
}

const peekFreedomSwarmHttpOrigin = (): string => {
  try {
    return sessionStorage.getItem(FREEDOM_SWARM_HTTP_ORIGIN_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

/**
 * When Freedom is injected, try the native `bzz://` URL first. Freedom's provider returns
 * `bzz://<reference>` for published manifests; the HTTP origin from `requestAccess()` is only a permission scope.
 */
const freedomLocalBzzBasesForListing = (listingKey: string): string[] => {
  if (typeof window === 'undefined' || !window.swarm) return []
  let swarmHex: string
  try {
    swarmHex = listingKeyToSwarmRootHex(toCanonicalListingKey(listingKey))
  } catch {
    return []
  }
  const root = swarmHex.replace(/^0x/i, '').toLowerCase()
  const bases = [`bzz://${root}/`]
  const gw = peekFreedomSwarmHttpOrigin()
  if (gw) bases.push(`${gw}/bzz/${root}/`)
  if (/^https?:\/\//i.test(window.location.origin)) bases.push(`${window.location.origin}/bzz/${root}/`)
  return dedupeBzzBasesPreserveOrder(bases)
}

/** First successful HTTP `/bzz/` URL in registry / persisted map restores an HTTP origin for this tab. */
const hydrateFreedomSwarmHttpOriginFromStoredBzzUrls = () => {
  if (peekFreedomSwarmHttpOrigin()) return
  for (const e of loadJSON<RegistryEntry[]>(REGISTRY_STORAGE_KEY, [])) {
    if (e.bzzUrl) {
      stashFreedomSwarmHttpOriginFromUrl(e.bzzUrl)
      return
    }
  }
  const bzzMap = loadJSON<Record<string, string>>(LISTING_BZZ_BASE_MAP_KEY, {})
  for (const v of Object.values(bzzMap)) {
    if (v) {
      stashFreedomSwarmHttpOriginFromUrl(v)
      return
    }
  }
}

type ListingManifestBzzHint = { listingKey: string; bzzUrl: string }

function stashListingManifestBzzHint(listingKey: string, bzzUrl: string) {
  try {
    const payload: ListingManifestBzzHint = {
      listingKey: toCanonicalListingKey(listingKey),
      bzzUrl: normalizeBzzFetchBaseUrl(bzzUrl) || bzzUrl.trim(),
    }
    sessionStorage.setItem(LISTING_MANIFEST_BZZ_SESSION_KEY, JSON.stringify(payload))
  } catch {
    /* sessionStorage unavailable or quota */
  }
}

function peekListingManifestBzzHint(listingKey: string): string {
  try {
    const raw = sessionStorage.getItem(LISTING_MANIFEST_BZZ_SESSION_KEY)
    if (!raw) return ''
    const o = JSON.parse(raw) as Partial<ListingManifestBzzHint>
    if (!o.listingKey || !o.bzzUrl) return ''
    if (toCanonicalListingKey(listingKey) !== o.listingKey) return ''
    return normalizeBzzFetchBaseUrl(o.bzzUrl)
  } catch {
    return ''
  }
}

const loadListingBzzBaseMap = (): Record<string, string> => loadJSON<Record<string, string>>(LISTING_BZZ_BASE_MAP_KEY, {})

const persistListingBzzBase = (listingKey: string, bzzBase: string) => {
  try {
    const canonical = toCanonicalListingKey(listingKey)
    const normalized = normalizeBzzFetchBaseUrl(bzzBase.trim())
    if (!normalized) return
    const next = { ...loadListingBzzBaseMap(), [canonical]: normalized }
    localStorage.setItem(LISTING_BZZ_BASE_MAP_KEY, JSON.stringify(next))
  } catch {
    /* quota */
  }
}

const peekListingBzzBaseFromMap = (listingKey: string): string => {
  try {
    const canonical = toCanonicalListingKey(listingKey)
    return normalizeBzzFetchBaseUrl(loadListingBzzBaseMap()[canonical] ?? '')
  } catch {
    return ''
  }
}

const dedupeBzzBasesPreserveOrder = (bases: string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of bases) {
    const n = normalizeBzzFetchBaseUrl(raw)
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/**
 * Rebuild `/bzz/{root}/…` using this listing's Swarm manifest root — same Freedom host as `templateBzzUrl`
 * (works when localStorage has no row for this listing but another publish URL shares the gateway shape).
 */
const substituteSwarmRootInBzzUrl = (templateBzzUrl: string, listingKey: string): string => {
  let targetHex: string
  try {
    targetHex = listingKeyToSwarmRootHex(toCanonicalListingKey(listingKey))
  } catch {
    return ''
  }
  const bare = (targetHex.startsWith('0x') ? targetHex.slice(2) : targetHex).toLowerCase()
  const url = templateBzzUrl.trim()
  const replaced = url
    .replace(/(\/bzz\/)(0x)?[0-9a-fA-F]{64}(?=\/|$|\?|#)/i, (_match: string, prefix: string) => `${prefix}${bare}`)
    .replace(/(bzz:\/\/)(0x)?[0-9a-fA-F]{64}(?=\/|$|\?|#)/i, (_match: string, prefix: string) => `${prefix}${bare}`)
  return replaced !== url ? replaced : ''
}

const deriveFreedomTemplateBzzBases = async (listingKey: string): Promise<string[]> => {
  const out: string[] = []
  for (const e of loadJSON<RegistryEntry[]>(REGISTRY_STORAGE_KEY, [])) {
    if (!e.bzzUrl) continue
    const s = substituteSwarmRootInBzzUrl(e.bzzUrl, listingKey)
    const n = normalizeBzzFetchBaseUrl(s)
    if (n) out.push(n)
  }
  if (typeof window !== 'undefined' && window.swarm) {
    try {
      const feeds = await window.swarm.listFeeds()
      for (const f of feeds) {
        if (!f.bzzUrl) continue
        const s = substituteSwarmRootInBzzUrl(f.bzzUrl, listingKey)
        const n = normalizeBzzFetchBaseUrl(s)
        if (n) out.push(n)
      }
    } catch {
      /* listFeeds missing or denied */
    }
  }
  return out
}

const extractListingKeyFromRegistryId = (id: string): string => {
  const i = id.indexOf(':')
  return i === -1 ? id : id.slice(i + 1)
}

/**
 * Local registry entries (after create or load) store the Freedom `publishFiles` bzz base URL.
 * Public `gateway.ethswarm.org` often cannot see that data immediately — prefer the saved base first.
 */
const getRegistryEntryForListingKey = (listingKey: string): RegistryEntry | undefined => {
  let canonical: string
  try {
    canonical = toCanonicalListingKey(listingKey)
  } catch {
    return undefined
  }
  const list = loadJSON<RegistryEntry[]>(REGISTRY_STORAGE_KEY, [])
  const byId = list.find(e => e.id === `${DKEY_CHAIN_ID}:${canonical}`)
  if (byId) return byId
  const byLegacyId = list.find(e => {
    try {
      return toCanonicalListingKey(extractListingKeyFromRegistryId(e.id)) === canonical
    } catch {
      return false
    }
  })
  if (byLegacyId) return byLegacyId
  try {
    const swarmHex = listingKeyToSwarmRootHex(canonical).toLowerCase()
    return list.find(e => normalizeReference(e.swarmReference).toLowerCase() === swarmHex)
  } catch {
    return undefined
  }
}

/** Swarm root URL for a content reference (dkey-lib does not ship this helper in published types). */
const DEFAULT_SWARM_GATEWAY = 'https://gateway.ethswarm.org'

const normalizeReference = (reference: string): string => {
  const trimmed = reference.trim()
  if (trimmed.startsWith('0x')) return trimmed
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return `0x${trimmed}`
  return trimmed
}

/** Plain Swarm `/bzz/` URL from a raw content reference (cover images, etc.) — not listing-CID aware. */
const bzzUrlForRawSwarmReference = (reference: string) => {
  const normalized = normalizeReference(reference)
  const hex = normalized.startsWith('0x') ? normalized.slice(2) : normalized
  return `${DEFAULT_SWARM_GATEWAY}/bzz/${hex}/`
}

/**
 * WARNING: Listing manifest + `encrypted.bin` live under the Swarm root bytes. dkey-lib expects a
 * synthetic CID for chain calls; gateways still need hex. See `./lib/swarmListingCid.ts`.
 */
const bzzUrlForListingRoot = (listingKeyOrHex: string) => {
  const swarmHex = listingKeyToSwarmRootHex(toCanonicalListingKey(listingKeyOrHex))
  const hex = swarmHex.startsWith('0x') ? swarmHex.slice(2) : swarmHex
  return `${DEFAULT_SWARM_GATEWAY}/bzz/${hex}/`
}

const bzzProtocolUrlForListingRoot = (listingKeyOrHex: string) => {
  const swarmHex = listingKeyToSwarmRootHex(toCanonicalListingKey(listingKeyOrHex))
  const hex = swarmHex.startsWith('0x') ? swarmHex.slice(2) : swarmHex
  return `bzz://${hex}/`
}

const tryBzzUrlForListingRoot = (reference: string) => {
  try {
    return bzzUrlForListingRoot(reference)
  } catch {
    return ''
  }
}

/** Session hint, persisted map, and this listing's registry row (no public gateway — appended after Freedom templates). */
const listingManifestBzzBaseCandidatesSync = (listingKey: string): string[] => {
  let canonical: string
  try {
    canonical = toCanonicalListingKey(listingKey)
  } catch {
    return []
  }
  const bases: string[] = []
  const hinted = peekListingManifestBzzHint(canonical)
  if (hinted) bases.push(hinted)
  const fromMap = peekListingBzzBaseFromMap(canonical)
  if (fromMap) bases.push(fromMap)
  const reg = getRegistryEntryForListingKey(canonical)
  const fromReg = reg?.bzzUrl ? normalizeBzzFetchBaseUrl(reg.bzzUrl) : ''
  if (fromReg) bases.push(fromReg)
  return dedupeBzzBasesPreserveOrder(bases)
}

const allListingManifestBzzBaseCandidates = async (listingKey: string): Promise<string[]> => {
  hydrateFreedomSwarmHttpOriginFromStoredBzzUrls()
  const freedomLocal = freedomLocalBzzBasesForListing(listingKey)
  const primary = listingManifestBzzBaseCandidatesSync(listingKey)
  const templates = await deriveFreedomTemplateBzzBases(listingKey)
  let bzzProtocolFallback = ''
  let publicFallback = ''
  try {
    bzzProtocolFallback = normalizeBzzFetchBaseUrl(bzzProtocolUrlForListingRoot(listingKey)) || ''
    publicFallback = normalizeBzzFetchBaseUrl(bzzUrlForListingRoot(listingKey)) || ''
  } catch {
    try {
      bzzProtocolFallback = normalizeBzzFetchBaseUrl(bzzProtocolUrlForListingRoot(toCanonicalListingKey(listingKey))) || ''
      publicFallback = normalizeBzzFetchBaseUrl(bzzUrlForListingRoot(toCanonicalListingKey(listingKey))) || ''
    } catch {
      /* */
    }
  }
  return dedupeBzzBasesPreserveOrder([...freedomLocal, ...primary, ...templates, bzzProtocolFallback, publicFallback].filter(Boolean))
}

const tryBzzUrlForRawSwarmReference = (reference: string) => {
  try {
    return bzzUrlForRawSwarmReference(reference)
  } catch {
    return ''
  }
}

const fetchBzzBytes = async (bzzUrl: string, path: string, onProgress?: (progress: number) => void) => {
  const url = `${bzzUrl.replace(/\/$/, '')}/${path}`
  const requestInit: RequestInit = {}
  try {
    const freedomOrigin = peekFreedomSwarmHttpOrigin()
    if (freedomOrigin && /^https?:\/\//i.test(url)) {
      const target = new URL(url)
      if (target.origin === freedomOrigin) requestInit.credentials = 'include'
    }
  } catch {
    /* invalid url */
  }
  const response = await fetch(url, requestInit)
  if (path === 'metadata.json') {
    try {
      const ct = response.headers.get('content-type')
      const peek = await response.clone().text()
      console.log('[Swarm metadata.json response]', {
        url,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        contentType: ct,
        bodyPreview: peek.length > 1200 ? `${peek.slice(0, 1200)}… (${peek.length} chars total)` : peek,
      })
    } catch (e) {
      console.log('[Swarm metadata.json response]', { url, status: response.status, ok: response.ok, logBodyError: e })
    }
  }
  if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`)

  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (!response.body || !contentLength) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    onProgress?.(100)
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onProgress?.(Math.min(100, Math.round((received / contentLength) * 100)))
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  chunks.forEach(chunk => {
    bytes.set(chunk, offset)
    offset += chunk.length
  })
  return bytes
}

const parseBzzJsonBody = <T,>(bytes: Uint8Array, path: string): T => {
  const text = new TextDecoder().decode(bytes).trimStart()
  if (text.startsWith('<')) {
    throw new Error(
      `Swarm gateway returned HTML instead of ${path} (try again after propagation, or open the listing from the same browser that published it).`,
    )
  }
  try {
    return JSON.parse(text) as T
  } catch (e) {
    const hint = e instanceof Error ? e.message : String(e)
    throw new Error(`Invalid JSON for Swarm ${path}: ${hint}`)
  }
}

const fetchBzzJSON = async <T,>(bzzUrl: string, path: string) => {
  const bytes = await fetchBzzBytes(bzzUrl, path)
  return parseBzzJsonBody<T>(bytes, path)
}

const fetchBzzBytesFirstWorking = async (
  bases: string[],
  path: string,
  onProgress?: (progress: number) => void,
): Promise<Uint8Array> => {
  let last: unknown
  for (const base of bases) {
    try {
      return await fetchBzzBytes(base, path, onProgress)
    } catch (e) {
      last = e
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

/** Avoids a network round-trip right after `publishFiles` when gateways may still return HTML. */
const listingManifestInMemoryCache = new Map<string, { metadataJSON: ListingMetadataJSON; bzzBase: string }>()

function rememberListingManifestForCurrentSession(
  listingKey: string,
  metadataJSON: ListingMetadataJSON,
  uploadBzzUrl: string,
) {
  const canonical = toCanonicalListingKey(listingKey)
  const normalized = normalizeBzzFetchBaseUrl(uploadBzzUrl)
  const trimmed = uploadBzzUrl.trim()
  const bzzBase = normalized || (trimmed.endsWith('/') ? trimmed : `${trimmed}/`)
  listingManifestInMemoryCache.set(canonical, { metadataJSON, bzzBase })
}

const fetchListingMetadataAcrossBases = async (
  listingKey: string,
): Promise<{ metadataJSON: ListingMetadataJSON; bzzBase: string }> => {
  let canonical: string | undefined
  try {
    canonical = toCanonicalListingKey(listingKey)
  } catch {
    canonical = undefined
  }
  if (canonical) {
    const cached = listingManifestInMemoryCache.get(canonical)
    if (cached) {
      return { metadataJSON: cached.metadataJSON, bzzBase: cached.bzzBase }
    }
  }
  const bases = await allListingManifestBzzBaseCandidates(listingKey)
  if (!bases.length) throw new Error('No Swarm gateway base URL available for this listing')
  let last: unknown
  for (const base of bases) {
    try {
      const metadataJSON = await fetchBzzJSON<ListingMetadataJSON>(base, 'metadata.json')
      stashFreedomSwarmHttpOriginFromUrl(base)
      persistListingBzzBase(listingKey, base)
      return { metadataJSON, bzzBase: base }
    } catch (e) {
      last = e
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

const metadataFromJSON = (raw: ListingMetadataJSON) => {
  const chainIds = raw.chainIds?.length ? raw.chainIds : [DKEY_CHAIN_ID]
  return new ListingMetadata(
    raw.seller ?? {},
    raw.fileName || 'Encrypted data',
    raw.fileDescription || '',
    Number(raw.fileSizeInBytes ?? 0),
    Number(raw.suggestedPriceInEth ?? 0),
    raw.coverPhotoReference || '',
    raw.coverPhotoLink || '',
    chainIds,
    Number(raw.listingCreatedAfterBlock ?? dkey.contracts.DKeyStoreL2[DKEY_CHAIN_ID].deploymentBlockNumber),
  )
}

const registryEntryFromMetadata = (listingKey: string, bzzUrl: string, raw: ListingMetadataJSON): RegistryEntry => {
  const sellerAddress = typeof raw.seller?.address === 'string' ? raw.seller.address : ''
  const swarmHex = listingKeyToSwarmRootHex(listingKey)
  const bzzStored = normalizeBzzFetchBaseUrl(bzzUrl.trim()) || bzzUrl.trim()
  return {
    id: `${raw.chainIds?.[0] ?? DKEY_CHAIN_ID}:${listingKey}`,
    swarmReference: swarmHex,
    bzzUrl: bzzStored,
    fileName: raw.fileName || 'Encrypted data',
    fileDescription: raw.fileDescription || '',
    fileSizeInBytes: Number(raw.fileSizeInBytes ?? 0),
    suggestedPriceInEth: Number(raw.suggestedPriceInEth ?? 0),
    chainId: raw.chainIds?.[0] ?? DKEY_CHAIN_ID,
    contractAddress: dkey.contracts.DKeyStoreL2[DKEY_CHAIN_ID].address,
    sellerAddress,
    listingTxHash: '',
    listingBlockNumber: String(raw.listingCreatedAfterBlock ?? 0),
    createdAt: Date.now(),
  }
}

const coverUrlForMetadata = (metadata: ListingMetadataJSON | null, listingBzzUrl: string) => {
  if (!metadata) return ''
  if (metadata.coverPhotoLink) {
    if (/^(https?:|bzz:)/.test(metadata.coverPhotoLink)) return metadata.coverPhotoLink
    return `${listingBzzUrl.replace(/\/$/, '')}/${metadata.coverPhotoLink.replace(/^\//, '')}`
  }
  if (metadata.coverPhotoReference) return tryBzzUrlForRawSwarmReference(metadata.coverPhotoReference)
  return ''
}

const fetchOpenBidsForListing = async (details: ListingDetails, listingKey: string, wagmiConfig: ReturnType<typeof buildConfig>): Promise<BidLite[]> => {
  if (details.openBidsCounter <= 0) return []
  const totalBidsPlaced = Math.max(details.totalBidsPlaced, details.openBidsCounter)
  const maxBidsToDisplay = 10
  const maxBatchSize = 20
  const found: BidLite[] = []
  const seen = new Set<string>()

  for (let currentIndex = 1; currentIndex <= totalBidsPlaced && found.length < maxBidsToDisplay;) {
    const batchSize = Math.min(maxBatchSize, totalBidsPlaced - currentIndex + 1)
    const batchResults = await dkey.fetchOpenBids(details.chainId, listingKey, currentIndex, batchSize, wagmiConfig)
    for (let i = 0; i < batchResults.length && found.length < maxBidsToDisplay; i += 1) {
      const [pubKeyX, pubKeyY, bidAmount] = batchResults[i]!
      if (pubKeyX === 0n && pubKeyY === 0n && bidAmount === 0n) continue
      const pubKeyXStr = pubKeyX.toString()
      const pubKeyYStr = pubKeyY.toString()
      const key = `${pubKeyXStr}:${pubKeyYStr}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push(new BidLite(currentIndex + i, listingKey, pubKeyXStr, pubKeyYStr, formatEther(bidAmount)))
    }
    currentIndex += batchSize
  }

  return found
}

const downloadBytes = (bytes: Uint8Array, fileName: string, type = 'application/octet-stream') => {
  const blob = new Blob([bytes.slice()], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

const copyText = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // NotAllowedError on http / blocked permissions — use legacy copy below
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, text.length)

  try {
    if (document.execCommand('copy')) return
  } finally {
    document.body.removeChild(textarea)
  }

  throw new Error('Clipboard copy is not available in this browser context')
}

const profileEntries = <T,>(record: Record<number, Record<string, T>>, chainId = DKEY_CHAIN_ID) => Object.entries(record[chainId] ?? {})

const buildConfig = () => createConfig({
  chains: [DKEY_CHAIN],
  connectors: [
    injected({
      target: () => ({
        id: 'freedom',
        name: 'Freedom Wallet',
        provider: (w) => w?.ethereum,
      }),
    }),
  ],
  multiInjectedProviderDiscovery: false,
  storage: null,
  transports: {
    [DKEY_CHAIN.id]: http(DKEY_CHAIN.rpcUrls.default.http[0]),
  },
})

function App() {
  const config = useMemo(() => buildConfig(), [])
  const [route, setRoute] = useState<AppRoute>(() => readRoute())
  const [activity, setActivity] = useState<ActivityEntry[]>(() => loadJSON(ACTIVITY_STORAGE_KEY, []))
  const [, setRegistry] = useState<RegistryEntry[]>(() => loadJSON(REGISTRY_STORAGE_KEY, []))
  const [profile, setProfile] = useState(() => {
    const serialized = localStorage.getItem(PROFILE_STORAGE_KEY)
    if (serialized) {
      try {
        return DkeyUserProfile.deserialize(serialized, config)
      } catch {
        localStorage.removeItem(PROFILE_STORAGE_KEY)
      }
    }
    return new DkeyUserProfile({ app: 'dkey-swarm' }, {}, {}, {}, {}, config)
  })
  const [address, setAddress] = useState<Address | null>(null)
  const [swarmReady, setSwarmReady] = useState(false)
  const [walletReady, setWalletReady] = useState(false)
  const [feedReady, setFeedReady] = useState(false)
  const [operation, setOperation] = useState<OperationState | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [coverPhoto, setCoverPhoto] = useState<File | null>(null)
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('0')
  const [maxKeys, setMaxKeys] = useState('0')
  const [royalty, setRoyalty] = useState('0')
  const [createListingShare, setCreateListingShare] = useState('')
  const [coverPreviewUrl, setCoverPreviewUrl] = useState('')
  const [createProgress, setCreateProgress] = useState<CreateProgress>({ encrypting: 0, uploading: 0, saving: 0 })
  const [isCreatingListing, setIsCreatingListing] = useState(false)
  const [isListingCreated, setIsListingCreated] = useState(false)
  const [createShareButtonText, setCreateShareButtonText] = useState('Copy the Share URL')
  const [txError, setTxError] = useState(false)
  const [txErrorMessage, setTxErrorMessage] = useState('')
  const [showDkeysInfo, setShowDkeysInfo] = useState(false)
  const [showPriceInfo, setShowPriceInfo] = useState(false)
  const [showRoyaltyInfo, setShowRoyaltyInfo] = useState(false)
  const [showUploadFileInfo, setShowUploadFileInfo] = useState(false)
  const [showCoverPhotoInfo, setShowCoverPhotoInfo] = useState(false)
  const [listingMetadata, setListingMetadata] = useState<ListingMetadataJSON | null>(null)
  const [listingDetails, setListingDetails] = useState<ListingDetails | null>(null)
  const [listingBids, setListingBids] = useState<BidLite[]>([])
  /** Bzz base URL that successfully served this listing's manifest (Freedom vs public gateway). */
  const [listingManifestBzzUrl, setListingManifestBzzUrl] = useState('')
  const [listingError, setListingError] = useState('')
  const [listingLoadPhase, setListingLoadPhase] = useState<'swarm' | 'chain' | null>(null)
  const [, setSwarmUploadProgress] = useState(0)
  const [, setTxProgress] = useState(0)
  const [bidAmount, setBidAmount] = useState(DEFAULT_BID_AMOUNT)
  const [increaseAmounts, setIncreaseAmounts] = useState<Record<string, string>>({})
  const [restoreModal, setRestoreModal] = useState<
    { open: false } | { open: true; ciphertext: Uint8Array }
  >({ open: false })
  const [backupModal, setBackupModal] = useState<
    { open: false } | { open: true; profile: DkeyUserProfile }
  >({ open: false })
  const [restorePassword, setRestorePassword] = useState('')
  const [backupPassword, setBackupPassword] = useState('')
  const [restoreError, setRestoreError] = useState('')
  const [backupError, setBackupError] = useState('')
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [profileBootstrap, setProfileBootstrap] = useState<ProfileBootstrap>('idle')
  const [globalBusyMessage, setGlobalBusyMessage] = useState('')
  const [isDKeysOpen, setIsDKeysOpen] = useState(false)
  const [hasRemoteSwarmProfileBackup, setHasRemoteSwarmProfileBackup] = useState(false)
  /** Temp: publish a static `dist/` folder to Swarm via Freedom browser. */
  const [appPublishBusy, setAppPublishBusy] = useState(false)
  const [appPublishStatus, setAppPublishStatus] = useState('')
  const [appPublishUrl, setAppPublishUrl] = useState('')
  const appPublishFolderInputRef = useRef<HTMLInputElement>(null)
  const backupDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingBackupProfileRef = useRef<DkeyUserProfile | null>(null)
  /** Latest encrypted profile bytes from Swarm (swarm-kv), e.g. when restore was dismissed — allows "Restore" from profile empty state. */
  const pendingSwarmProfileCipherRef = useRef<Uint8Array | null>(null)
  /** After a successful Swarm backup we clear localStorage; keep this true so profile bootstrap does not re-prompt restore while the tab session still holds the profile in React state. */
  const ephemeralProfileRef = useRef(false)
  const addressRef = useRef<Address | null>(null)
  addressRef.current = address
  const profileRef = useRef(profile)
  profileRef.current = profile

  const [swarmProfileBackupUi, setSwarmProfileBackupUi] = useState<SwarmProfileBackupUi>({ kind: 'idle' })
  /** Last serialized profile we backed up to Swarm or loaded from Swarm; hide back-up CTA while it still matches in-memory profile (state so the UI updates reliably). */
  const [profileSwarmBackupBaseline, setProfileSwarmBackupBaseline] = useState<string | null>(null)

  const profileSerializedSignature = useMemo(() => profile.serialize(), [profile])

  useEffect(() => {
    if (swarmProfileBackupUi.kind !== 'success') return
    if (profileSwarmBackupBaseline !== null && profileSerializedSignature !== profileSwarmBackupBaseline) {
      setSwarmProfileBackupUi({ kind: 'idle' })
    }
  }, [profileSerializedSignature, swarmProfileBackupUi.kind, profileSwarmBackupBaseline])

  /** Hide the post-backup success line after a few seconds (button returns unless profile changed, which clears success earlier). */
  useEffect(() => {
    if (swarmProfileBackupUi.kind !== 'success') return undefined
    const id = window.setTimeout(() => {
      setSwarmProfileBackupUi({ kind: 'idle' })
    }, 4500)
    return () => window.clearTimeout(id)
  }, [swarmProfileBackupUi.kind])

  useEffect(() => {
    setProfileSwarmBackupBaseline(null)
    setSwarmProfileBackupUi(current => (current.kind === 'running' ? current : { kind: 'idle' }))
  }, [address])

  useEffect(() => {
    if (!coverPhoto) {
      setCoverPreviewUrl('')
      return undefined
    }
    const url = URL.createObjectURL(coverPhoto)
    setCoverPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [coverPhoto])

  const canUseSwarm = Boolean(window.swarm)
  const canUseWallet = Boolean(window.ethereum)
  const profileListings = profileEntries(profile.myListings)
  const profileDKeys = profileEntries(profile.myDKeys)
  const profileOpenBids = profileEntries(profile.myOpenBids)

  const setBusy = (key: string, title: string, detail: string, progress = 4) => {
    setOperation({ key, title, detail, progress })
  }

  const clearBusy = () => setOperation(null)

  const addActivity = async (entry: ActivityEntry, publish = true) => {
    setActivity(current => {
      const next = [entry, ...current].slice(0, 180)
      localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(next))
      return next
    })

    if (publish && window.swarm && feedReady) {
      try {
        await window.swarm.writeFeedEntry({ name: ACTIVITY_FEED, data: JSON.stringify(entry) })
      } catch {
        setFeedReady(false)
      }
    }
  }

  const commitProfile = (source = profile, opts?: { skipBackupPrompt?: boolean; activityReason?: string }) => {
    ephemeralProfileRef.current = false
    const serialized = source.serialize()
    localStorage.setItem(PROFILE_STORAGE_KEY, serialized)
    setProfile(DkeyUserProfile.deserialize(serialized, config))
    const profileLabel = opts?.activityReason ?? 'Profile updated'
    void addActivity(makeActivity('profile', profileLabel, truncateProfileActivityDetail(serialized)), false)
    if (opts?.skipBackupPrompt || !addressRef.current || !window.swarm) {
      return
    }
    pendingBackupProfileRef.current = source
    if (backupDebounceRef.current) {
      clearTimeout(backupDebounceRef.current)
    }
    backupDebounceRef.current = setTimeout(() => {
      backupDebounceRef.current = null
      const latest = pendingBackupProfileRef.current
      if (latest && addressRef.current && window.swarm) {
        setBackupModal({ open: true, profile: latest })
      }
    }, 450)
  }

  const dismissRestoreOffer = () => {
    if (restoreModal.open && address) {
      sessionStorage.setItem(profileBackupDismissKey(address), '1')
    }
    setRestoreModal({ open: false })
    setRestorePassword('')
    setRestoreError('')
    setProfileBootstrap('needs-create')
  }

  const applyRestoredProfile = async () => {
    if (restoreModal.open !== true) return
    setRestoreError('')
    setRestoreBusy(true)
    try {
      const ciphertextCopy = new Uint8Array(restoreModal.ciphertext)
      const blob = new Blob([ciphertextCopy], { type: 'application/octet-stream' })
      const restored = await DkeyUserProfile.fromEncryptedProfileData(blob, restorePassword, config)
      if (address) sessionStorage.removeItem(profileBackupDismissKey(address))
      pendingSwarmProfileCipherRef.current = null
      setHasRemoteSwarmProfileBackup(false)
      commitProfile(restored, { skipBackupPrompt: true, activityReason: 'Profile restored from Swarm backup' })
      setProfileSwarmBackupBaseline(restored.serialize())
      setRestoreModal({ open: false })
      setRestorePassword('')
      setProfileBootstrap('ready')
    } catch (error) {
      setRestoreError(isWrongPasswordRestoreError(error) ? RESTORE_WRONG_PASSWORD_MESSAGE : formatError(error))
    } finally {
      setRestoreBusy(false)
    }
  }

  const skipBackupNow = () => {
    setBackupModal({ open: false })
    setBackupPassword('')
    setBackupError('')
  }

  const runSwarmProfileBackup = async () => {
    if (backupModal.open !== true) return
    const addr = addressRef.current
    if (!addr || !window.swarm) {
      setBackupError('Wallet or Swarm is not available.')
      return
    }
    const password = backupPassword
    const profileToBackup = backupModal.profile
    setBackupError('')
    setBackupModal({ open: false })
    setBackupPassword('')
    setSwarmProfileBackupUi({ kind: 'running', progress: 6 })
    try {
      await window.swarm.requestAccess?.()
      setSwarmProfileBackupUi({ kind: 'running', progress: 18 })
      const caps = await window.swarm.getCapabilities()
      if (!caps.canPublish) {
        throw new Error(caps.reason ?? 'Swarm cannot publish (postage required)')
      }
      setSwarmProfileBackupUi({ kind: 'running', progress: 32 })
      const blob = await profileToBackup.toEncryptedProfileData(password)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      setSwarmProfileBackupUi({ kind: 'running', progress: 52 })
      const store = new SwarmKvStore(createFreedomSwarmBackend(window.swarm), {
        namespace: profileKvNamespace(addr),
      })
      await store.open()
      setSwarmProfileBackupUi({ kind: 'running', progress: 68 })
      const putResult = await store.put(PROFILE_KV_KEY, bytes)
      setSwarmProfileBackupUi({ kind: 'running', progress: 90 })
      if (backupDebounceRef.current) {
        clearTimeout(backupDebounceRef.current)
        backupDebounceRef.current = null
      }
      pendingBackupProfileRef.current = null
      localStorage.removeItem(PROFILE_STORAGE_KEY)
      ephemeralProfileRef.current = true
      setProfileSwarmBackupBaseline(profileToBackup.serialize())
      setSwarmProfileBackupUi({ kind: 'success' })
      if (addr) sessionStorage.removeItem(profileBackupDismissKey(addr))
      await addActivity(
        makeActivity('swarm', 'Profile backed up', `Encrypted profile saved to Swarm (swarm-kv)${putResult.reference ? ` · ${short(putResult.reference)}` : ''}`),
        false,
      )
      await addActivity(
        makeActivity('profile', 'Profile snapshot after Swarm backup', truncateProfileActivityDetail(profileToBackup.serialize())),
        false,
      )
    } catch (error) {
      setSwarmProfileBackupUi({ kind: 'idle' })
      setProfileSwarmBackupBaseline(null)
      setBackupError(formatError(error))
      setBackupModal({ open: true, profile: profileToBackup })
    }
  }

  const rememberRegistryEntry = async (entry: RegistryEntry, publish = true) => {
    const prev = loadJSON<RegistryEntry[]>(REGISTRY_STORAGE_KEY, [])
    const next = [entry, ...prev.filter(item => item.id !== entry.id)]
    localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(next))
    setRegistry(next)
    if (entry.bzzUrl) {
      stashFreedomSwarmHttpOriginFromUrl(entry.bzzUrl)
      try {
        persistListingBzzBase(extractListingKeyFromRegistryId(entry.id), entry.bzzUrl)
      } catch {
        /* */
      }
    }

    if (publish && window.swarm && feedReady) {
      await window.swarm.writeFeedEntry({ name: REGISTRY_FEED, data: JSON.stringify(entry) })
      await addActivity(makeActivity('swarm', 'Registry feed entry', `${entry.fileName} at ${short(entry.swarmReference)}`, { reference: entry.swarmReference }))
    }
  }

  /** (Re)bind injected provider to this wagmi store — required before `writeContract` on `wagmiConfig`. */
  const attachInjectedConnector = async (wagmiConfig: typeof config) => {
    const connector = wagmiConfig.connectors[0]
    if (!connector) throw new Error('No wallet connector configured')
    try {
      await disconnect(wagmiConfig)
    } catch {
      // A fresh page load may not have an initialized Wagmi connection yet.
    }
    try {
      await connect(wagmiConfig, { connector })
    } catch (error) {
      const message = formatError(error)
      if (!message.includes('already connected')) throw error
    }
  }

  /** Ensures the wagmi config dkey-lib uses has an active signing connection (handles HMR / stale profile.config). */
  const ensureWagmiSigningConnection = async (wagmiConfig: typeof config) => {
    if (!window.ethereum) throw new Error('Freedom wallet provider not found')
    const before = getAccount(wagmiConfig)
    if (before.status === 'connected' && before.address) return

    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: DKEY_CHAIN_HEX }] })
    } catch {
      // Already on Gnosis or wallet does not require an explicit switch.
    }
    await attachInjectedConnector(wagmiConfig)
    const after = getAccount(wagmiConfig)
    if (after.status !== 'connected' || !after.address) {
      throw new Error('Wallet must be connected to sign transactions.')
    }
  }

  /** Re-deserialize so dkey-lib uses the same wagmi store as this app (avoids stale `config` after HMR). */
  const profileBoundToAppWagmi = (source: DkeyUserProfile) =>
    DkeyUserProfile.deserialize(source.serialize(), config)

  const prepareProfileForChainWrite = async (source: DkeyUserProfile) => {
    const bound = profileBoundToAppWagmi(source)
    await ensureWagmiSigningConnection(config)
    return bound
  }

  const connectWallet = async () => {
    if (!window.ethereum) throw new Error('Freedom wallet provider not found')
    setBusy('wallet', 'Connecting wallet', 'Selecting Gnosis Chain, then requesting the active account.')
    try {
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: DKEY_CHAIN_HEX }] })
        await addActivity(makeActivity('wallet', 'Gnosis chain selected', 'wallet_switchEthereumChain accepted Gnosis Chain'), false)
      } catch (error) {
        await addActivity(makeActivity('wallet', 'Gnosis switch skipped', formatError(error)), false)
      }

      await attachInjectedConnector(config)

      const activeConnection = getAccount(config)
      const accounts = activeConnection.address
        ? [activeConnection.address]
        : await window.ethereum.request({ method: 'eth_requestAccounts' }) as Address[]
      const rawAccount = accounts[0]
      if (!rawAccount) throw new Error('No wallet account returned')
      const account = getAddress(rawAccount)
      const chainId = Number(await window.ethereum.request({ method: 'eth_chainId' }))
      setAddress(account)
      setWalletReady(true)
      await addActivity(makeActivity('wallet', 'Wallet connected', `chain=${chainId}; account=${short(account)}`))
      if (chainId !== DKEY_CHAIN_ID) {
        await addActivity(
          makeActivity('error', 'Wrong wallet chain', `Freedom wallet is on ${chainId}; contract writes need Gnosis Chain (${DKEY_CHAIN_ID})`),
          false,
        )
      }
      return account
    } finally {
      clearBusy()
    }
  }

  const connectSwarm = async () => {
    if (!window.swarm) throw new Error('Freedom Swarm provider not found')
    setBusy('swarm', 'Connecting Swarm', 'Requesting Swarm access and preparing app feeds.')
    try {
      const { canPublish, reason, accessOrigin } = await activateSwarmSession(window.swarm)
      setSwarmReady(canPublish)
      await addActivity(
        makeActivity('swarm', 'Swarm access', `${accessOrigin ?? 'Swarm'}; publish=${canPublish}${reason ? ` (${reason})` : ''}`),
        false,
      )

      if (!canPublish) {
        setFeedReady(false)
        return
      }

      setFeedReady(true)
      await addActivity(makeActivity('swarm', 'Feeds ready', `${REGISTRY_FEED}, ${ACTIVITY_FEED}`), false)
    } finally {
      clearBusy()
    }
  }

  const pollUpload = async (
    tagUid: number,
    title: string,
    floor = 30,
    ceiling = 70,
    onProgress?: (progress: number) => void,
  ) => {
    if (!window.swarm) return
    for (let i = 0; i < 90; i += 1) {
      const status = await window.swarm.getUploadStatus({ tagUid })
      const progress = floor + Math.round((Math.min(100, status.progress) / 100) * (ceiling - floor))
      setSwarmUploadProgress(Math.min(100, Math.round(status.progress)))
      if (onProgress) {
        onProgress(progress)
      } else {
        setBusy('upload', title, `${status.progress}% sent (${status.sent}/${status.split})`, progress)
      }
      if (status.done) return
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }

  const publishStaticAppToSwarm = async (event: ChangeEvent<HTMLInputElement>) => {
    const pickedFiles = Array.from(event.target.files ?? [])
    event.target.value = ''
    setAppPublishUrl('')
    setAppPublishStatus('')

    if (!pickedFiles.length) return
    if (!window.swarm) {
      setAppPublishStatus('Freedom Swarm provider not found.')
      return
    }

    setAppPublishBusy(true)
    try {
      const { canPublish, reason } = await activateSwarmSession(window.swarm)
      if (!canPublish) throw new Error(reason ?? 'Swarm cannot publish right now.')

      const rootPrefix = pickedFiles[0]?.webkitRelativePath?.split('/')[0] ?? ''
      const files = await Promise.all(
        pickedFiles
          .filter(file => !file.name.startsWith('.'))
          .map(async file => {
            const relativePath = file.webkitRelativePath || file.name
            const path = rootPrefix && relativePath.startsWith(`${rootPrefix}/`)
              ? relativePath.slice(rootPrefix.length + 1)
              : relativePath
            return {
              path,
              bytes: new Uint8Array(await file.arrayBuffer()),
              contentType: file.type || 'application/octet-stream',
            }
          }),
      )

      if (!files.some(file => file.path === 'index.html')) {
        throw new Error('The selected folder must contain index.html. Select your built dist folder, not the source folder.')
      }

      setAppPublishStatus(`Publishing ${files.length} files to Swarm…`)
      const result = await window.swarm.publishFiles({ files, indexDocument: 'index.html' })
      if (result.tagUid) {
        await pollUpload(result.tagUid, 'Publishing app to Swarm', 20, 95)
      }
      const publishedUrl = result.bzzUrl || `bzz://${result.reference}`
      setAppPublishUrl(publishedUrl)
      setAppPublishStatus('App published to Swarm.')
      await addActivity(makeActivity('swarm', 'Static app published', publishedUrl, { reference: result.reference }), false)
    } catch (error) {
      setAppPublishStatus(formatError(error))
    } finally {
      setAppPublishBusy(false)
      clearBusy()
    }
  }

  const createListing = async () => {
    let txResultTimer: number | undefined
    setTxError(false)
    setTxErrorMessage('')
    setIsCreatingListing(true)
    setIsListingCreated(false)
    setCreateListingShare('')
    setCreateShareButtonText('Copy the Share URL')
    setCreateProgress({ encrypting: 0, uploading: 0, saving: 0 })
    setSwarmUploadProgress(0)
    setTxProgress(0)
    try {
      if (!selectedFile) throw new Error('Choose a file first')
      if (!coverPhoto) throw new Error('Upload a cover photo first')
      if (!window.swarm) throw new Error('Freedom Swarm provider not found')
      const dkeysForSale = Number(maxKeys)
      const suggestedPrice = Number(price)
      const royaltyPercent = Number(royalty)
      if (!Number.isInteger(dkeysForSale) || dkeysForSale < 1 || dkeysForSale > 10_000_000) {
        throw new Error('Enter a whole number of DKEYs for sale between 1 and 10,000,000')
      }
      if (!Number.isFinite(suggestedPrice) || suggestedPrice < MIN_BID_XDAI) {
        throw new Error(`Enter a suggested price of at least ${MIN_BID_XDAI} xDAI`)
      }
      if (!Number.isInteger(royaltyPercent) || royaltyPercent < 1 || royaltyPercent > 99) {
        throw new Error('Enter a whole royalty percentage between 1 and 99')
      }

      const account = await connectWallet()
      const dkeyWallet = walletAddressForDkeyProfile(profileBoundToAppWagmi(profileRef.current), DKEY_CHAIN_ID, account)
      if (!swarmReady) await connectSwarm()
      await dkey.loadSnarkJS()
      dkey.configureCircuits(`${import.meta.env.BASE_URL}circuits`)

      setCreateProgress(progress => ({ ...progress, encrypting: 35 }))
      const encrypted = await dkey.createKeyAndEncryptFile(await selectedFile.arrayBuffer())
      setCreateProgress(progress => ({ ...progress, encrypting: 100, uploading: 8 }))
      setSwarmUploadProgress(12)
      const encryptedBytes = new Uint8Array(await encrypted.encryptedData.arrayBuffer())
      const currentBlock = Number(await dkey.getCurrentBlock(config, DKEY_CHAIN_ID))
      let coverPhotoReference = ''
      let coverPhotoLink = ''

      const extension = coverPhoto.name.includes('.') ? coverPhoto.name.slice(coverPhoto.name.lastIndexOf('.')) : ''
      const coverPath = `cover-photo${extension}`
      const coverUpload = await window.swarm.publishFiles({
        files: [{ path: coverPath, bytes: await coverPhoto.arrayBuffer(), contentType: coverPhoto.type || 'application/octet-stream' }],
      })
      coverPhotoReference = coverUpload.reference
      coverPhotoLink = `${coverUpload.bzzUrl.replace(/\/$/, '')}/${coverPath}`
      stashFreedomSwarmHttpOriginFromUrl(coverUpload.bzzUrl)
      if (coverUpload.tagUid) {
        await pollUpload(coverUpload.tagUid, 'Uploading cover photo', 8, 36, value => {
          setCreateProgress(progress => ({ ...progress, uploading: value }))
        })
      } else {
        setCreateProgress(progress => ({ ...progress, uploading: 36 }))
      }

      const metadataJSON: ListingMetadataJSON = {
        seller: { address: dkeyWallet },
        fileName: selectedFile.name,
        fileDescription: description.trim(),
        fileSizeInBytes: selectedFile.size,
        suggestedPriceInEth: suggestedPrice,
        coverPhotoReference,
        coverPhotoLink,
        chainIds: [DKEY_CHAIN_ID],
        listingCreatedAfterBlock: currentBlock,
        content: {
          encryptedPath: 'encrypted.bin',
          originalType: selectedFile.type || 'application/octet-stream',
        },
      }
      const metadataBytes = new TextEncoder().encode(JSON.stringify(metadataJSON, null, 2))

      setCreateProgress(progress => ({ ...progress, uploading: Math.max(progress.uploading, 42) }))
      const upload = await window.swarm.publishFiles({
        files: [
          { path: 'encrypted.bin', bytes: encryptedBytes, contentType: 'application/octet-stream' },
          { path: 'metadata.json', bytes: metadataBytes, contentType: 'application/json' },
        ],
      })
      if (upload.tagUid) {
        await pollUpload(upload.tagUid, 'Uploading listing files', 42, 100, value => {
          setCreateProgress(progress => ({ ...progress, uploading: value }))
        })
      }
      setCreateProgress(progress => ({ ...progress, uploading: 100, saving: 12 }))
      setSwarmUploadProgress(100)
      const uploadBzzBase = normalizeBzzFetchBaseUrl(upload.bzzUrl) || upload.bzzUrl.trim()
      console.log('[bzzUrl debug] publishFiles (listing manifest) result', {
        reference: upload.reference,
        bzzUrlRaw: upload.bzzUrl,
        bzzUrlBase: uploadBzzBase,
        bzzUrlHasLiteralPercent: upload.bzzUrl.includes('%'),
        startsWithHttp: /^https?:\/\//i.test(upload.bzzUrl.trim()),
      })
      await addActivity(makeActivity('swarm', 'Manifest published', uploadBzzBase, { reference: upload.reference }))
      stashFreedomSwarmHttpOriginFromUrl(uploadBzzBase)

      setTxProgress(18)
      setCreateProgress(progress => ({ ...progress, saving: 30 }))
      const metadata = new ListingMetadata(
        { address: dkeyWallet },
        selectedFile.name,
        description.trim(),
        selectedFile.size,
        suggestedPrice,
        coverPhotoReference,
        coverPhotoLink,
        [DKEY_CHAIN_ID],
        currentBlock,
      )
      // WARNING: dkey-lib requires a multiformats-parseable CID; Swarm returns a bytes32 root — see `swarmListingCid.ts`.
      const manifestRootHex = normalizeReference(upload.reference)
      const listingKey = swarmRootHexToSyntheticDkeyCid(manifestRootHex)
      txResultTimer = window.setTimeout(() => {
        setCreateProgress(progress => ({ ...progress, saving: Math.max(progress.saving, 62) }))
      }, 3500)
      const txProfile = await prepareProfileForChainWrite(profileRef.current)
      const result = await txProfile.createListing(
        listingKey,
        metadata,
        [encrypted.secretKeyX, encrypted.secretKeyY],
        dkeysForSale,
        royaltyPercent,
        dkeyWallet,
      )

      if (txResultTimer) {
        window.clearTimeout(txResultTimer)
        txResultTimer = undefined
      }
      setCreateProgress(progress => ({ ...progress, saving: Math.max(progress.saving, 78) }))
      setTxProgress(55)
      if (!result.success || !result.receipt) throw new Error(`createListing failed: ${result.result}`)
      setTxProgress(100)
      setCreateProgress(progress => ({ ...progress, saving: 100 }))
      const nextProfile = result.profile ?? txProfile
      const createdListing = nextProfile.myListings?.[DKEY_CHAIN_ID]?.[listingKey] as
        | { info?: Record<string, unknown> }
        | undefined
      if (createdListing && typeof createdListing === 'object') {
        createdListing.info = {
          ...(createdListing.info ?? {}),
          [LISTING_INFO_SWARM_MANIFEST_BZZ_URL]: uploadBzzBase,
        }
      }
      commitProfile(nextProfile, { activityReason: 'Profile updated after listing created' })
      await addActivity(makeActivity('chain', 'Listing created', `Block ${result.receipt.blockNumber.toString()}`, {
        txHash: result.receipt.transactionHash,
        reference: listingKey,
      }))

      const entry = {
        id: `${DKEY_CHAIN_ID}:${listingKey}`,
        swarmReference: manifestRootHex,
        bzzUrl: uploadBzzBase,
        fileName: selectedFile.name,
        fileDescription: description.trim(),
        fileSizeInBytes: selectedFile.size,
        suggestedPriceInEth: suggestedPrice,
        chainId: DKEY_CHAIN_ID,
        contractAddress: dkey.contracts.DKeyStoreL2[DKEY_CHAIN_ID].address,
        sellerAddress: dkeyWallet,
        listingTxHash: result.receipt.transactionHash,
        listingBlockNumber: result.receipt.blockNumber.toString(),
        createdAt: Date.now(),
      }
      rememberListingManifestForCurrentSession(listingKey, metadataJSON, uploadBzzBase)
      stashListingManifestBzzHint(listingKey, uploadBzzBase)
      await rememberRegistryEntry(entry)
      setCreateListingShare(listingShareUrl(listingKey, uploadBzzBase))
      setIsListingCreated(true)
    } catch (error) {
      setTxError(true)
      setTxErrorMessage(formatError(error))
      setIsCreatingListing(false)
    } finally {
      if (txResultTimer) window.clearTimeout(txResultTimer)
      clearBusy()
    }
  }

  const manifestBzzHintForListingRef = (reference: string): string | undefined => {
    try {
      const k = toCanonicalListingKey(reference)
      const fromProfile = getProfileListingManifestBzzBase(profile.myListings[DKEY_CHAIN_ID]?.[k])
      if (fromProfile) return fromProfile
      const reg = getRegistryEntryForListingKey(k)?.bzzUrl
      if (reg?.trim()) return normalizeManifestBzzBaseHint(reg) || reg.trim()
      return undefined
    } catch {
      return undefined
    }
  }

  /** Same manifest base resolution as {@link openListingRoute} (profile hint → map → registry). */
  const resolveListingOpenHints = (reference: string, manifestBzzFromListingInfo?: string): { canonical: string; chosen?: string } => {
    const canonical = toCanonicalListingKey(reference)
    const fromProfile = normalizeManifestBzzBaseHint(manifestBzzFromListingInfo)
    const fromMap = peekListingBzzBaseFromMap(canonical)
    const fromReg = getRegistryEntryForListingKey(canonical)?.bzzUrl ?? ''
    const merged = fromProfile || fromMap || normalizeManifestBzzBaseHint(fromReg)
    console.log('[bzzUrl debug] resolveListingOpenHints', {
      referenceInput: reference,
      canonical,
      manifestBzzFromListingInfoRaw: manifestBzzFromListingInfo,
      fromProfile,
      fromMap,
      fromReg: fromReg || undefined,
      chosen: merged || undefined,
      chosenHasLiteralPercent: merged ? merged.includes('%') : false,
    })
    return { canonical, chosen: merged || undefined }
  }

  const openListingRoute = (reference: string, manifestBzzFromListingInfo?: string) => {
    const { canonical, chosen } = resolveListingOpenHints(reference, manifestBzzFromListingInfo)
    if (chosen) {
      stashFreedomSwarmHttpOriginFromUrl(chosen)
      stashListingManifestBzzHint(canonical, chosen)
      persistListingBzzBase(canonical, chosen)
    }
    console.log('[bzzUrl debug] openListingRoute → writeRoute', { canonical, manifestBzzBase: chosen })
    writeRoute({ name: 'listing', reference: canonical, manifestBzzBase: chosen }, 'push')
  }

  const loadListing = async (reference: string, manifestBzzFromRoute?: string) => {
    setListingLoadPhase('swarm')
    setListingError('')
    setListingManifestBzzUrl('')
    setListingMetadata(null)
    setListingDetails(null)
    setListingBids([])
    try {
      const listingKey = toCanonicalListingKey(reference)
      console.log('[bzzUrl debug] loadListing start', {
        referenceInput: reference,
        listingKey,
        manifestBzzFromRouteRaw: manifestBzzFromRoute,
      })
      const fromUrl = normalizeManifestBzzBaseHint(manifestBzzFromRoute)
      console.log('[bzzUrl debug] loadListing after normalizeManifestBzzBaseHint', {
        fromUrl: fromUrl || '(empty — query bzz ignored or invalid)',
        fromUrlHasLiteralPercent: fromUrl ? fromUrl.includes('%') : false,
      })
      if (fromUrl) {
        stashFreedomSwarmHttpOriginFromUrl(fromUrl)
        stashListingManifestBzzHint(listingKey, fromUrl)
        persistListingBzzBase(listingKey, fromUrl)
      }
      const { metadataJSON, bzzBase } = await fetchListingMetadataAcrossBases(listingKey)
      console.log('[bzzUrl debug] loadListing metadata fetch ok', { bzzBaseUsed: bzzBase })
      setListingManifestBzzUrl(bzzBase)
      setListingMetadata(metadataJSON)
      setListingLoadPhase('chain')
      const metadata = metadataFromJSON(metadataJSON)
      const rawDetails = await dkey.fetchListingDetails(listingKey, metadata, config)
      const details: ListingDetails = {
        howManyDKeysForSale: rawDetails.howManyDKeysForSale,
        howManyDKeysSold: rawDetails.howManyDKeysSold,
        priceInEth: rawDetails.priceInEth,
        royaltyPercentage: rawDetails.royaltyPercentage,
        listingOwnerAddress: rawDetails.listingOwnerAddress as Address,
        canDkeysBeSold: rawDetails.canDkeysBeSold,
        openBidsCounter: rawDetails.openBidsCounter,
        referenceString: rawDetails.cidString,
        fileName: rawDetails.fileName,
        description: rawDetails.description,
        fileSizeInBytes: rawDetails.fileSizeInBytes,
        seller: rawDetails.seller as Record<string, unknown>,
        coverPhotoLink: rawDetails.coverPhotoLink,
        coverPhotoReference: rawDetails.coverPhotoCID,
        chainIds: rawDetails.chainIds,
        chainId: rawDetails.chainId,
        listingCreatedAfterBlock: rawDetails.listingCreatedAfterBlock,
        totalBidsPlaced: rawDetails.totalBidsPlaced,
      }
      const openBids = await fetchOpenBidsForListing(details, listingKey, config)
      setListingDetails(details)
      setListingBids(openBids)
      await rememberRegistryEntry(registryEntryFromMetadata(listingKey, bzzBase, metadataJSON), false)
    } catch (error) {
      setListingError(formatError(error))
    } finally {
      setListingLoadPhase(null)
    }
  }

  const makeBid = async () => {
    const account = await connectWallet()
    if (route.name !== 'listing') throw new Error('Open a listing first')
    if (!listingMetadata || !listingDetails) throw new Error('Listing details are not loaded yet')
    setBusy('bid', 'Waiting for signature', `Bidding ${bidAmount} xDAI on ${shortSwarmListingRef(route.reference)}.`, 18)
    try {
      const metadata = metadataFromJSON(listingMetadata)
      const listingKey = toCanonicalListingKey(route.reference)
      const txProfile = await prepareProfileForChainWrite(profileRef.current)
      const dkeyWallet = walletAddressForDkeyProfile(txProfile, listingDetails.chainId, account)
      const result = await txProfile.makeBid(
        listingKey,
        Number(bidAmount),
        metadata,
        dkeyWallet,
        listingDetails.chainId,
        listingDetails.canDkeysBeSold,
      )
      setBusy('bid', 'Confirming bid', 'Saving this open bid to your DKey profile.', 82)
      if (!result.success || !result.receipt) throw new Error(`makeBid failed: ${result.result}`)
      commitProfile(result.profile ?? txProfile, { activityReason: 'Profile updated after bid placed' })
      await addActivity(makeActivity('chain', 'Bid placed', `${bidAmount} xDAI on ${shortSwarmListingRef(route.reference)}`, {
        txHash: result.receipt.transactionHash,
        reference: listingKey,
      }))
      await loadListing(route.reference, route.manifestBzzBase)
    } finally {
      clearBusy()
    }
  }

  const fillBid = async (bid: BidLite) => {
    await connectWallet()
    if (route.name !== 'listing' || !listingDetails) throw new Error('Open a listing first')
    setBusy('fill', 'Preparing DKey proof', `Encrypting key material for ${short(bid.pubKeyX)}.`, 12)
    try {
      await dkey.loadSnarkJS()
      dkey.configureCircuits(`${import.meta.env.BASE_URL}circuits`)
      setBusy('fill', 'Waiting for signature', 'Confirm the DKey delivery transaction.', 64)
      const listingKey = toCanonicalListingKey(route.reference)
      const txProfile = await prepareProfileForChainWrite(profileRef.current)
      const result = await txProfile.fillBid(
        listingKey,
        bid.pubKeyX,
        bid.pubKeyY,
        Number(bid.bidAmountInEth),
        listingDetails.chainId,
      )
      if (!result.success || !result.receipt) throw new Error(`fillBid failed: ${result.result}`)
      await addActivity(makeActivity('chain', 'DKey provided', `${short(bid.pubKeyX)} received key material`, {
        txHash: result.receipt.transactionHash,
        reference: listingKey,
      }))

      const legacyHexKey = isLikelySwarmRootHex(route.reference) ? normalizeReference(route.reference) : ''
      const localBid =
        txProfile.myOpenBids[listingDetails.chainId]?.[listingKey]
        ?? (legacyHexKey ? txProfile.myOpenBids[listingDetails.chainId]?.[legacyHexKey] : undefined)
      if (localBid && localBid.pubKeyX === bid.pubKeyX) {
        setBusy('dkey', 'Fetching received DKey', 'Finalizing the matching local bid into your DKey profile.', 86)
        const dkeyResult = await txProfile.fetchDkey(localBid)
        if (dkeyResult.success) {
          await addActivity(makeActivity('chain', 'DKey fetched', shortSwarmListingRef(route.reference), { reference: listingKey }))
        }
      }

      commitProfile(result.profile ?? txProfile, { activityReason: 'Profile updated after DKey delivery' })
      await loadListing(route.reference, route.manifestBzzBase)
    } finally {
      clearBusy()
    }
  }

  const increaseBid = async (reference: string, chainId: number) => {
    await connectWallet()
    const amount = increaseAmounts[reference] || DEFAULT_BID_AMOUNT
    setBusy('increase', 'Waiting for signature', `Increasing bid by ${amount} xDAI.`, 18)
    try {
      const txProfile = await prepareProfileForChainWrite(profileRef.current)
      const result = await txProfile.updateBid(reference, chainId, Number(amount))
      setBusy('increase', 'Confirming update', 'Saving increased bid to your profile.', 82)
      if (!result.success || !result.receipt) throw new Error(`updateBid failed: ${result.result}`)
      commitProfile(result.profile ?? txProfile, { activityReason: 'Profile updated after bid increase' })
      await addActivity(makeActivity('chain', 'Bid increased', `${amount} xDAI added to ${short(reference)}`, {
        txHash: result.receipt.transactionHash,
        reference,
      }))
    } finally {
      clearBusy()
    }
  }

  const reclaimBid = async (reference: string, chainId: number) => {
    await connectWallet()
    setBusy('reclaim', 'Waiting for signature', `Reclaiming bid for ${short(reference)}.`, 18)
    try {
      const txProfile = await prepareProfileForChainWrite(profileRef.current)
      const result = await txProfile.reclaimBid(reference, chainId)
      setBusy('reclaim', 'Confirming reclaim', 'Removing the open bid from your profile.', 82)
      if (!result.success || !result.receipt) throw new Error(`reclaimBid failed: ${result.result}`)
      commitProfile(result.profile ?? txProfile, { activityReason: 'Profile updated after bid reclaim' })
      await addActivity(makeActivity('chain', 'Bid reclaimed', short(reference), {
        txHash: result.receipt.transactionHash,
        reference,
      }))
    } finally {
      clearBusy()
    }
  }

  const fetchDkeyForBid = async (reference: string, chainId: number) => {
    const bid = profile.myOpenBids[chainId]?.[reference]
    if (!bid) throw new Error('No local open bid for this listing')
    setBusy('dkey', 'Checking bid status', 'Looking for filled bid state on-chain.', 12)
    try {
      const statusResult = await profile.checkIfDKeysReceived(chainId)
      if (statusResult.success) {
        commitProfile(statusResult.profile ?? profile, { activityReason: 'Profile updated after bid status sync' })
      }
      setBusy('dkey', 'Fetching DKey', 'Scanning chain events for encrypted key material.', 42)
      const result = await profile.fetchDkey(bid)
      if (!result.success) throw new Error(`fetchDkey failed: ${result.result}`)
      commitProfile(result.profile ?? profile, { activityReason: 'Profile updated after DKey fetch' })
      await addActivity(makeActivity('chain', 'DKey fetched', short(reference), { reference }))
    } finally {
      clearBusy()
    }
  }

  const downloadDkeyFile = async (reference: string, chainId: number) => {
    const item = profile.myDKeys[chainId]?.[reference]
    if (!item) throw new Error('No DKey found for this listing')
    const listingKey = toCanonicalListingKey(reference)
    const bases = await allListingManifestBzzBaseCandidates(listingKey)
    setBusy('download', 'Downloading encrypted file', item.fileName, 8)
    try {
      const encryptedBytes = await fetchBzzBytesFirstWorking(bases, 'encrypted.bin', progress => {
        setBusy('download', 'Downloading encrypted file', `${progress}% fetched`, 8 + Math.round(progress * 0.48))
      })
      setBusy('download', 'Decrypting file', 'Using your local DKey material.', 72)
      const clearBytes = await item.decryptFile(encryptedBytes.slice().buffer as ArrayBuffer)
      setBusy('download', 'Starting download', item.fileName, 96)
      downloadBytes(clearBytes, item.fileName)
      await addActivity(makeActivity('file', 'Downloaded and decrypted', item.fileName, { reference }))
    } finally {
      clearBusy()
    }
  }

  const run = (label: string, action: () => Promise<unknown> | unknown) => {
    Promise.resolve(action()).catch(error => {
      void addActivity(makeActivity('error', label, formatError(error)), false)
      clearBusy()
    })
  }

  useEffect(() => {
    dkey.configureCircuits(`${import.meta.env.BASE_URL}circuits`)
    void dkey.loadSnarkJS()
  }, [])

  useEffect(() => {
    const syncRoute = () => setRoute(readRoute())
    window.addEventListener('popstate', syncRoute)
    window.addEventListener(ROUTE_EVENT, syncRoute as EventListener)
    return () => {
      window.removeEventListener('popstate', syncRoute)
      window.removeEventListener(ROUTE_EVENT, syncRoute as EventListener)
    }
  }, [])

  useEffect(() => {
    const updateAccounts = (accounts: unknown) => {
      const firstRaw = Array.isArray(accounts) ? accounts[0] as string | undefined : undefined
      if (!firstRaw) {
        setAddress(null)
        setWalletReady(false)
        return
      }
      try {
        setAddress(getAddress(firstRaw as Address))
      } catch {
        setAddress(firstRaw as Address)
      }
      setWalletReady(true)
    }

    if (!window.ethereum) return
    window.ethereum.request({ method: 'eth_accounts' })
      .then(updateAccounts)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    return () => {
      if (backupDebounceRef.current) {
        clearTimeout(backupDebounceRef.current)
      }
    }
  }, [])

  /** When Freedom injects `window.swarm`, connect without requiring a nav-bar click (same work as manual Swarm connect, without activity spam). */
  useEffect(() => {
    let cancelled = false
    let intervalId = 0
    let attempts = 0

    const run = async () => {
      if (cancelled || !window.swarm) return
      try {
        const { canPublish } = await activateSwarmSession(window.swarm)
        if (cancelled) return
        setSwarmReady(canPublish)
        setFeedReady(canPublish)
      } catch {
        if (!cancelled) {
          setSwarmReady(false)
          setFeedReady(false)
        }
      }
    }

    const tick = () => {
      void (async () => {
        if (cancelled) return
        attempts += 1
        if (!window.swarm) {
          if (attempts >= 120) window.clearInterval(intervalId)
          return
        }
        try {
          await run()
        } finally {
          window.clearInterval(intervalId)
        }
      })()
    }

    intervalId = window.setInterval(tick, 1000)
    void tick()

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [])

  useEffect(() => {
    if (route.name !== 'profile') {
      setProfileBootstrap('idle')
      setGlobalBusyMessage('')
      return undefined
    }

    if (localStorage.getItem(PROFILE_STORAGE_KEY)) {
      ephemeralProfileRef.current = false
      setProfileBootstrap('ready')
      setGlobalBusyMessage('')
      return undefined
    }

    if (ephemeralProfileRef.current) {
      setProfileBootstrap('ready')
      setGlobalBusyMessage('')
      return undefined
    }

    let cancelled = false
    pendingSwarmProfileCipherRef.current = null
    setHasRemoteSwarmProfileBackup(false)
    setProfileBootstrap('checking')
    setGlobalBusyMessage('Checking for a saved profile…')

    ;(async () => {
      if (!address) {
        if (!cancelled) {
          setGlobalBusyMessage('')
          setProfileBootstrap('needs-wallet')
        }
        return
      }
      if (!window.swarm) {
        if (!cancelled) {
          setGlobalBusyMessage('')
          setProfileBootstrap('needs-swarm')
        }
        return
      }
      try {
        await window.swarm.requestAccess?.()
        const store = new SwarmKvStore(createFreedomSwarmBackend(window.swarm), {
          namespace: profileKvNamespace(address),
        })
        await store.open()
        const entry = await store.get(PROFILE_KV_KEY)
        if (cancelled) return
        if (entry?.kind === 'binary') {
          const copy = new Uint8Array(entry.value)
          pendingSwarmProfileCipherRef.current = copy
          setHasRemoteSwarmProfileBackup(true)
          if (!sessionStorage.getItem(profileBackupDismissKey(address))) {
            setGlobalBusyMessage('')
            setRestoreModal({ open: true, ciphertext: copy })
            return
          }
          setGlobalBusyMessage('')
          setProfileBootstrap('needs-create')
          return
        }
        pendingSwarmProfileCipherRef.current = null
        setHasRemoteSwarmProfileBackup(false)
        setGlobalBusyMessage('')
        setProfileBootstrap('needs-create')
      } catch (error) {
        if (!cancelled) {
          setGlobalBusyMessage('')
          void addActivity(makeActivity('error', 'Profile Swarm check failed', formatError(error)), false)
          // If the provider exists, don't block the user on a misleading "connect Swarm" prompt
          // (e.g. first run before requestAccess, or transient KV errors after refresh).
          setProfileBootstrap(window.swarm ? 'needs-create' : 'needs-swarm')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [route.name, address, swarmReady])

  useEffect(() => {
    if (route.name === 'listing') {
      setListingManifestBzzUrl('')
      const reference = route.reference.trim()
      if (!reference) return undefined
      const timer = window.setTimeout(() => {
        void loadListing(reference, route.manifestBzzBase)
      }, 0)
      return () => window.clearTimeout(timer)
    }
    setListingManifestBzzUrl('')
    return undefined
    // The listing loader is intentionally route-driven; its internal state updates
    // should not re-run this effect after every fetch phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route])

  const createLocalProfile = () => {
    const fresh = new DkeyUserProfile({ app: 'dkey-swarm' }, {}, {}, {}, {}, config)
    commitProfile(fresh, { activityReason: 'Profile created (empty local profile)' })
    setProfileBootstrap('ready')
  }

  const openPendingSwarmRestore = () => {
    const raw = pendingSwarmProfileCipherRef.current
    if (!raw?.length) return
    setRestoreError('')
    setRestoreModal({ open: true, ciphertext: new Uint8Array(raw) })
  }

  useEffect(() => {
    if (!isDKeysOpen) return
    if (!profile.hasDKeys()) return
    void (async () => {
      try {
        const { success, profile: next } = await profile.checkIfDKeysCanBeSold(DKEY_CHAIN_ID)
        if (success && next) {
          commitProfile(next, { skipBackupPrompt: true, activityReason: 'Profile updated (DKey resale status sync)' })
        }
      } catch {
        // best-effort sync with chain
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- miniapp-style: run when DKEYs panel opens
  }, [isDKeysOpen])

  const truncateEthAmount = (amount: number) => {
    const amountStr = amount.toString()
    const [whole, decimal] = amountStr.split('.')
    if (decimal && decimal.length > 7) {
      return `${whole}.${decimal.slice(0, 7)}`
    }
    return amountStr
  }

  const copyProfileSerialized = async () => {
    try {
      await copyText(profile.serialize())
      await addActivity(makeActivity('file', 'Profile data copied', 'Serialized DKey profile'), false)
    } catch (error) {
      void addActivity(makeActivity('error', 'Copy profile failed', formatError(error)), false)
    }
  }

  const openSwarmBackupModal = () => {
    if (!address || !window.swarm) return
    setBackupPassword('')
    setBackupError('')
    setBackupModal({ open: true, profile })
  }

  const createPriceNumber = Number(price)
  const createKeysNumber = Number(maxKeys)
  const createRoyaltyNumber = Number(royalty)
  const canCreateListing = Boolean(
    selectedFile
    && coverPhoto
    && description.trim().length > 0
    && Number.isFinite(createPriceNumber)
    && createPriceNumber >= MIN_BID_XDAI
    && Number.isInteger(createKeysNumber)
    && createKeysNumber >= 1
    && createKeysNumber <= 10_000_000
    && Number.isInteger(createRoyaltyNumber)
    && createRoyaltyNumber >= 1
    && createRoyaltyNumber <= 99,
  )
  const resetCreateForm = () => {
    setSelectedFile(null)
    setCoverPhoto(null)
    setDescription('')
    setPrice('0')
    setMaxKeys('0')
    setRoyalty('0')
    setCreateListingShare('')
    setCreateShareButtonText('Copy the Share URL')
    setCreateProgress({ encrypting: 0, uploading: 0, saving: 0 })
    setIsCreatingListing(false)
    setIsListingCreated(false)
    setTxError(false)
    setTxErrorMessage('')
    setSwarmUploadProgress(0)
    setTxProgress(0)
  }
  const returnToProfileFromCreatedListing = () => {
    resetCreateForm()
    writeRoute({ name: 'profile' }, 'push')
  }
  const copyCreatedListingUrl = async () => {
    if (!createListingShare) return
    await copyText(createListingShare)
    setCreateShareButtonText('Share URL copied ✔️')
  }

  const isCurrentUserListingOwner = Boolean(
    route.name === 'listing'
    && listingDetails
    && address
    && listingDetails.listingOwnerAddress.toLowerCase() === address.toLowerCase(),
  )

  const activeReference = route.name === 'listing' ? tryCanonicalListingKey(route.reference) : ''
  const listingBzzUrl = route.name === 'listing'
    ? (listingManifestBzzUrl || tryBzzUrlForListingRoot(route.reference))
    : ''
  /** Pre–workaround profiles keyed bids by raw Swarm hex; new profiles use synthetic CID. */
  const userHasOpenBidOnListing =
    route.name === 'listing' && listingDetails
      ? profile.hasOpenBid(activeReference, listingDetails.chainId)
      || (isLikelySwarmRootHex(route.reference)
        && profile.hasOpenBid(normalizeReference(route.reference), listingDetails.chainId))
      : false
  const coverUrl = coverUrlForMetadata(listingMetadata, listingBzzUrl)
  const listingTitleWhileLoading = listingMetadata?.fileName || listingDetails?.fileName || 'Listing'
  const listingDescWhileLoading = listingMetadata?.fileDescription || listingDetails?.description || ''
  const profileUserInfo = (profile as unknown as { userInfo?: { pfpUrl?: string; username?: string } }).userInfo

  /** Hide back-up CTA while the current profile still matches the last Swarm backup/restore snapshot. */
  const showSwarmBackupProfileButton =
    swarmProfileBackupUi.kind === 'idle'
    && (profileSwarmBackupBaseline === null || profileSerializedSignature !== profileSwarmBackupBaseline)

  return (
    <div className="min-h-screen min-h-[100dvh] bg-background text-foreground">
      <AppNav
        route={route}
        onNavigate={next => writeRoute(next, 'push')}
        address={address}
        walletReady={walletReady}
        canUseWallet={canUseWallet}
        onConnectWallet={() => run('Connect wallet', connectWallet)}
        swarmReady={swarmReady}
        canUseSwarm={canUseSwarm}
        onConnectSwarm={() => run('Connect Swarm', connectSwarm)}
        profileNavEnabled
        busy={Boolean(operation)}
      />

      <BusyOverlay open={Boolean(globalBusyMessage)} message={globalBusyMessage} />

      <main className="mx-auto flex w-full max-w-[500px] flex-col gap-6 px-3 pb-28 pt-[var(--app-nav-offset)] sm:w-[500px]">
        {operation && (
          <section className="rounded-md border bg-card p-4 shadow-sm" aria-live="polite">
            <div className="flex flex-col gap-1 text-sm">
              <strong>{operation.title}</strong>
              <span className="text-muted-foreground">{operation.detail}</span>
            </div>
            <progress className="mt-2 h-2 w-full" value={operation.progress} max={100} />
          </section>
        )}

        {route.name === 'profile' && profileBootstrap === 'needs-wallet' && (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Connect your wallet from the navigation bar to load your profile from Swarm or create one on this device.
          </p>
        )}
        {route.name === 'profile' && profileBootstrap === 'needs-swarm' && (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            Connect Swarm from the navigation bar so we can look for an encrypted profile backup.
          </p>
        )}
        {route.name === 'profile' && profileBootstrap === 'needs-create' && Boolean(address) && canUseSwarm && (
          <div className="rounded-md border bg-muted/40 p-4">
            {hasRemoteSwarmProfileBackup ? (
              <>
                <p className="text-sm text-muted-foreground">
                  An encrypted profile backup for this wallet is on Swarm. Restore with your backup password, or create a new empty local profile (this does not delete data on Swarm).
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button type="button" onClick={() => openPendingSwarmRestore()} disabled={Boolean(operation)}>
                    Restore from Swarm
                  </Button>
                  <Button type="button" variant="outline" onClick={() => createLocalProfile()} disabled={Boolean(operation)}>
                    Create empty profile
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  No local profile and nothing on Swarm for this wallet yet. Create an empty profile to start listing and bidding.
                </p>
                <Button className="mt-3" onClick={() => createLocalProfile()} disabled={Boolean(operation)}>
                  Create profile
                </Button>
              </>
            )}
          </div>
        )}

        {route.name === 'profile' && (profileBootstrap === 'ready' || profileBootstrap === 'needs-create') && (
          <section className="flex w-full flex-col items-center gap-8">
            <div className="flex flex-col items-center gap-4">
                <div className="flex flex-col items-center gap-2">
                  {profileUserInfo?.pfpUrl ? (
                    <div className="flex h-28 w-28 shrink-0 overflow-hidden rounded-full sm:h-32 sm:w-32">
                      <img src={profileUserInfo.pfpUrl} alt={profileUserInfo.username ? `${profileUserInfo.username}'s profile` : 'Profile'} className="h-full w-full object-cover" />
                    </div>
                  ) : (
                    <User
                      className="mx-auto aspect-square h-24 w-24 max-w-full shrink-0 text-foreground"
                      aria-hidden
                      strokeWidth={1}
                    />
                  )}
                  <p className="text-center font-display text-lg font-medium tracking-tight text-foreground">
                    swarmkeyUser123
                  </p>
                </div>
                <div className="flex max-w-[min(100%,420px)] items-center gap-1.5 px-2">
                  <p className="break-all text-center text-[11px] font-mono leading-snug text-muted-foreground">{address ?? '…'}</p>
                  <button
                    type="button"
                    className="shrink-0 rounded p-1 transition-colors hover:bg-muted"
                    title="Copy profile data to clipboard"
                    onClick={() => void copyProfileSerialized()}
                  >
                    <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </div>
            </div>

            {showSwarmBackupProfileButton && (
              <Button
                className="mx-auto w-auto max-w-[280px] rounded-none border px-4 italic"
                variant="outline"
                disabled={Boolean(operation) || !address || !canUseSwarm}
                onClick={() => openSwarmBackupModal()}
              >
                <span className="flex items-center justify-center gap-2">
                  <span>Back-up profile</span>
                  <img src="/swarm.png" alt="" className="h-5 w-5 shrink-0 object-contain" width={20} height={20} />
                </span>
              </Button>
            )}
            {swarmProfileBackupUi.kind === 'running' && (
              <div className="w-full max-w-[500px] space-y-2">
                <div
                  className="h-3 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={swarmProfileBackupUi.progress}
                  aria-label="Backup progress"
                >
                  <div
                    className="h-full bg-green-600 transition-[width] duration-200 ease-out dark:bg-green-500"
                    style={{ width: `${swarmProfileBackupUi.progress}%` }}
                  />
                </div>
                <p className="text-center text-xs text-muted-foreground">Backing up encrypted profile to Swarm…</p>
              </div>
            )}
            {swarmProfileBackupUi.kind === 'success' && (
              <p className="w-full max-w-[500px] text-center text-sm text-green-600 dark:text-green-500">
                Profile data backed-up successfully to Swarm.
              </p>
            )}

            <div className="w-full max-w-[500px] space-y-2 px-4">
              <Collapsible className="w-full space-y-2">
                <CollapsibleTrigger className="flex w-full items-center justify-between bg-muted p-2 hover:bg-muted/80">
                  <div className="flex items-center gap-2">
                    <span className="font-medium italic text-muted-foreground">LISTINGs</span>
                  </div>
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2">
                  {profileListings.length > 0 && (
                    <div className="space-y-2">
                      {profileListings.map(([reference, listing]) => {
                        const cover = (listing.metadata as { coverPhotoLink?: string }).coverPhotoLink ?? ''
                        const listingBzzHint = getProfileListingManifestBzzBase(listing) || undefined
                        return (
                          <div className="flex items-center gap-4 border p-2" key={reference}>
                            <div className="h-20 w-20 shrink-0 overflow-hidden bg-muted">
                              {cover ? (
                                <img src={cover} alt={listing.metadata.fileName} className="h-full w-full object-cover" />
                              ) : null}
                            </div>
                            <div className="min-w-0 grow flex-col overflow-hidden">
                              <div className="truncate text-sm text-muted-foreground">{listing.metadata.fileName}</div>
                            </div>
                            <div className="flex items-center">
                              <Button
                                variant="outline"
                                className="rounded-none px-2 text-xs"
                                onClick={() => openListingRoute(reference, listingBzzHint)}
                              >
                                VIEW LISTING
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <Button className="w-full rounded-none border" variant="outline" disabled={Boolean(operation)} onClick={() => writeRoute({ name: 'create' }, 'push')}>
                    <span className="flex items-center gap-1 text-xs">
                      <span className="text-xs">+</span>
                      <span className="text-xs italic">CREATE A NEW LISTING</span>
                    </span>
                  </Button>
                </CollapsibleContent>
              </Collapsible>

              <Collapsible className="w-full space-y-2" onOpenChange={(open: boolean) => setIsDKeysOpen(open)}>
                <CollapsibleTrigger className="flex w-full items-center justify-between bg-muted p-2 hover:bg-muted/80">
                  <div className="flex items-center gap-2">
                    <span className="font-medium italic text-muted-foreground">DKEYs</span>
                  </div>
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2">
                  {profileDKeys.length > 0 && (
                    <div>
                      {profileDKeys.map(([reference, item]) => {
                        return (
                          <div className="flex items-center gap-3 border-b p-2" key={reference}>
                            <div className="shrink-0">
                              <KeyIcon hueSeed={keyIconHueSeedFromListingRef(reference)} />
                            </div>
                            <div className="min-w-0 grow">
                              <p className="text-xs italic text-muted-foreground">{item.fileName}</p>
                            </div>
                            <div className="flex items-center">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" className="h-8 w-8 p-0">
                                    <MoreVertical className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="rounded-none">
                                  <DropdownMenuItem
                                    className="cursor-pointer rounded-none"
                                    onClick={() => openListingRoute(reference, manifestBzzHintForListingRef(reference))}
                                  >
                                    VIEW
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="cursor-pointer rounded-none"
                                    onClick={() => run('Download DKey file', () => downloadDkeyFile(reference, item.chainId))}
                                  >
                                    DOWNLOAD
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    className="cursor-pointer rounded-none"
                                    disabled={!item.canSell}
                                    onClick={() => item.canSell && openListingRoute(reference, manifestBzzHintForListingRef(reference))}
                                  >
                                    SELL
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>

              <Collapsible className="w-full space-y-2">
                <CollapsibleTrigger className="flex w-full items-center justify-between bg-muted p-2 hover:bg-muted/80">
                  <div className="flex items-center gap-2">
                    <span className="font-medium italic text-muted-foreground">BIDs</span>
                  </div>
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-2">
                  {profileOpenBids.length > 0
                    && profileOpenBids.map(([reference, bid]) => {
                      const hueSeed = keyIconHueSeedFromListingRef(reference)
                      const color = `hsl(${hueSeed.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360}, 70%, 50%)`
                      return (
                        <div className="flex items-center gap-3 border-b p-2" key={reference}>
                          <div className="shrink-0">
                            <p className="text-sm transition-colors duration-200" style={{ color }}>
                              {truncateEthAmount(Number(bid.bidAmountInEth))}
                              <span>Ξ</span>
                            </p>
                          </div>
                          <div className="min-w-0 grow">
                            <p className="text-xs italic text-muted-foreground">
                              {bid.fileName.length > 12 ? `${bid.fileName.slice(0, 10)}...` : bid.fileName}
                            </p>
                          </div>
                          <Input
                            className="h-8 w-16 shrink-0 rounded-none border px-1 text-center text-xs"
                            value={increaseAmounts[reference] ?? DEFAULT_BID_AMOUNT}
                            onChange={event => setIncreaseAmounts(current => ({ ...current, [reference]: event.target.value }))}
                            inputMode="decimal"
                            aria-label="Increase bid xDAI"
                          />
                          <Button variant="outline" className="rounded-none px-2" onClick={() => run('Reclaim bid', () => reclaimBid(reference, bid.chainId))}>
                            <span className="flex items-center gap-1 text-xl transition-colors duration-200" style={{ color }}>
                              <span>↩︎</span>
                            </span>
                          </Button>
                          <Button variant="outline" className="rounded-none px-2" onClick={() => run('Increase bid', () => increaseBid(reference, bid.chainId))}>
                            <span className="flex items-center gap-1 text-lg transition-colors duration-200" style={{ color }}>
                              <span>+</span>
                            </span>
                          </Button>
                          <Button
                            variant="outline"
                            className="rounded-none px-2"
                            onClick={() => openListingRoute(reference, manifestBzzHintForListingRef(reference))}
                          >
                            <span className="flex items-center gap-1 text-xs">
                              <span>👀</span>
                            </span>
                          </Button>
                          <Button variant="outline" className="rounded-none px-2 text-xs" onClick={() => run('Fetch DKey', () => fetchDkeyForBid(reference, bid.chainId))}>
                            DKey
                          </Button>
                        </div>
                      )
                    })}
                </CollapsibleContent>
              </Collapsible>
            </div>
          </section>
        )}

        {route.name === 'create' && (
          <section className="flex min-h-[calc(100dvh-var(--app-nav-offset)-8rem)] w-full flex-col items-center gap-5 pt-8">
            {!isCreatingListing && (
              <>
                <input
                  id="create-file"
                  className="hidden"
                  type="file"
                  onChange={event => setSelectedFile(event.target.files?.[0] ?? null)}
                />
                <input
                  id="create-cover-photo"
                  className="hidden"
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/gif,image/webp"
                  onChange={event => setCoverPhoto(event.target.files?.[0] ?? null)}
                />

                <div className="flex items-center justify-center gap-2">
                  {!selectedFile ? (
                    <Button
                      type="button"
                      className="w-64 rounded-none font-mono text-lg"
                      onClick={() => document.getElementById('create-file')?.click()}
                    >
                      UPLOAD FILE TO SELL
                    </Button>
                  ) : (
                    <button
                      type="button"
                      className="max-w-[85vw] break-words bg-clip-text text-center font-mono text-xl font-bold italic text-transparent"
                      style={{ backgroundImage: 'linear-gradient(to right, red, orange, yellow, green, blue, indigo, violet)' }}
                      onClick={() => document.getElementById('create-file')?.click()}
                    >
                      {selectedFile.name}
                    </button>
                  )}
                  <button type="button" aria-label="File upload info" onClick={() => setShowUploadFileInfo(true)}>
                    <Info className="h-5 w-5" />
                  </button>
                </div>

                <div className="flex items-start gap-2">
                  <button
                    type="button"
                    className={`flex h-64 w-64 items-center justify-center overflow-hidden ${
                      coverPreviewUrl ? '' : 'border-2 border-dotted border-gray-400'
                    }`}
                    onClick={() => document.getElementById('create-cover-photo')?.click()}
                  >
                    {coverPreviewUrl ? (
                      <img src={coverPreviewUrl} alt="Cover preview" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex flex-col items-center gap-2 font-mono">
                        <span className="text-5xl leading-none">⇪</span>
                        <span>UPLOAD COVER PHOTO</span>
                      </div>
                    )}
                  </button>
                  <button type="button" aria-label="Cover photo info" onClick={() => setShowCoverPhotoInfo(true)}>
                    <Info className="h-5 w-5" />
                  </button>
                </div>

                <div className="flex w-full max-w-[366px] flex-col gap-4 font-mono">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1">
                      <span className="text-sm"># DKEYs FOR SALE:</span>
                      <button type="button" aria-label="DKEYs for sale info" onClick={() => setShowDkeysInfo(true)}>
                        <Info className="h-4 w-4" />
                      </button>
                    </div>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={10_000_000}
                      step={1}
                      className="h-8 w-24 rounded-none border bg-transparent px-2 text-right font-mono [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      value={maxKeys}
                      onChange={event => setMaxKeys(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === '-' || event.key === '+' || event.key === 'e' || event.key === 'E' || event.key === '.') {
                          event.preventDefault()
                        }
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1">
                      <span className="text-sm">SUGGESTED PRICE (xDAI):</span>
                      <button type="button" aria-label="Suggested price info" onClick={() => setShowPriceInfo(true)}>
                        <Info className="h-4 w-4" />
                      </button>
                    </div>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={MIN_BID_XDAI}
                      step={MIN_BID_XDAI}
                      className="h-8 w-24 rounded-none border bg-transparent px-2 text-right font-mono [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      value={price}
                      onChange={event => setPrice(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === '-' || event.key === '+' || event.key === 'e' || event.key === 'E') {
                          event.preventDefault()
                        }
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1">
                      <span className="text-sm">ROYALTY ON RE-SALE (%):</span>
                      <button type="button" aria-label="Royalty info" onClick={() => setShowRoyaltyInfo(true)}>
                        <Info className="h-4 w-4" />
                      </button>
                    </div>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={99}
                      step={1}
                      className="h-8 w-24 rounded-none border bg-transparent px-2 text-right font-mono [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                      value={royalty}
                      onChange={event => setRoyalty(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === '-' || event.key === '+' || event.key === 'e' || event.key === 'E' || event.key === '.') {
                          event.preventDefault()
                        }
                      }}
                    />
                  </div>

                  <textarea
                    className="min-h-[84px] w-full resize-none rounded-none border bg-transparent p-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    maxLength={80}
                    rows={3}
                    placeholder="Describe your file..."
                    value={description}
                    onChange={event => setDescription(event.target.value)}
                  />
                </div>

                <Button
                  type="button"
                  className="mt-2 rounded-none font-mono text-lg"
                  disabled={!canCreateListing}
                  onClick={() => void createListing()}
                >
                  CREATE LISTING 🛰️
                </Button>
              </>
            )}

            {isCreatingListing && (
              <>
                {selectedFile && (
                  <p
                    className="max-w-[85vw] break-words bg-clip-text text-center font-mono text-xl font-bold italic text-transparent"
                    style={{ backgroundImage: 'linear-gradient(to right, red, orange, yellow, green, blue, indigo, violet)' }}
                  >
                    {selectedFile.name}
                  </p>
                )}

                <div className="flex w-full max-w-[366px] flex-col gap-4 font-mono">
                  {[
                    ['Encrypting...', createProgress.encrypting],
                    ['Uploading to Swarm...', createProgress.uploading],
                    ['Saving data to Blockchain...', createProgress.saving],
                  ].map(([label, value]) => (
                    <div key={label} className="space-y-1">
                      <div className="text-sm">{label}</div>
                      <div className="h-3 w-full overflow-hidden border border-foreground">
                        <div
                          className="h-full bg-foreground transition-all duration-500"
                          style={{ width: `${Math.min(100, Math.max(0, Number(value)))}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                {isListingCreated && (
                  <div className="mt-6 flex w-full max-w-[366px] flex-col items-center gap-4 border p-4 text-center font-mono">
                    <span className="text-2xl">Congratulations! 🎉</span>
                    <span>You&apos;ve created a new LISTING!</span>
                    {createListingShare && (
                      <p className="w-full break-all border p-2 text-xs text-muted-foreground">{createListingShare}</p>
                    )}
                    <Button type="button" className="rounded-none font-mono" onClick={() => void copyCreatedListingUrl()}>
                      {createShareButtonText}
                    </Button>
                    <Button type="button" variant="outline" className="rounded-none font-mono" onClick={returnToProfileFromCreatedListing}>
                      Return to Profile
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        )}

        {route.name === 'listing' && (
          <section className="flex flex-col gap-6">
            {listingLoadPhase === 'swarm' && (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                Loading listing metadata from Swarm…
              </p>
            )}
            {listingLoadPhase === 'chain' && (
              <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                Swarm metadata loaded. Fetching on-chain listing details and bids…
              </p>
            )}
            {listingError && <p className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">{listingError}</p>}

            {listingMetadata && (listingLoadPhase === 'chain' || listingDetails) && (
              <section className="overflow-hidden rounded-md border">
                <div className="aspect-video w-full bg-muted">
                  {coverUrl ? <img src={coverUrl} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No cover</div>}
                </div>
                <div className="p-4">
                  <h2 className="font-display text-2xl">{listingTitleWhileLoading}</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {listingDescWhileLoading ? `\u201c${listingDescWhileLoading}\u201d` : '\u201cNo description supplied.\u201d'}
                  </p>
                  <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                    <span className="font-sans text-muted-foreground">[Swarm hash]</span>
                    {' '}
                    {swarmListingHashFullDisplay(route.reference)}
                  </p>
                </div>
              </section>
            )}

            {listingDetails && (
              <>
                <section className="grid grid-cols-2 gap-3 rounded-md border p-4 text-sm">
                  <div><span className="text-muted-foreground">Seller</span><strong className="ml-2">{short(listingDetails.listingOwnerAddress)}</strong></div>
                  <div><span className="text-muted-foreground">File size</span><strong className="ml-2">{formatBytes(listingDetails.fileSizeInBytes)}</strong></div>
                  <div>
                    <span className="text-muted-foreground">Network</span>
                    <strong className="ml-2 inline-flex items-center gap-1.5">
                      <img src="/icons/gnosis.png" alt="" className="h-4 w-4 shrink-0 object-contain" width={16} height={16} />
                      Gnosis
                    </strong>
                  </div>
                  <div><span className="text-muted-foreground">Keys for sale</span><strong className="ml-2">{listingDetails.howManyDKeysForSale}</strong></div>
                  <div><span className="text-muted-foreground">Price</span><strong className="ml-2">{listingDetails.priceInEth} xDAI</strong></div>
                  <div><span className="text-muted-foreground">Keys sold</span><strong className="ml-2">{listingDetails.howManyDKeysSold}</strong></div>
                  <div><span className="text-muted-foreground">Royalty</span><strong className="ml-2">{listingDetails.royaltyPercentage}%</strong></div>
                  <div><span className="text-muted-foreground">Open bids</span><strong className="ml-2">{listingBids.length}</strong></div>
                </section>

                <div className="mx-auto w-full max-w-md">
                  {userHasOpenBidOnListing ? (
                    <p className="mb-2 text-end text-xs text-muted-foreground">In your profile</p>
                  ) : null}
                  <div className="flex min-w-0 gap-2">
                    <div className="relative min-w-0 flex-1">
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={MIN_BID_XDAI}
                        step={0.000001}
                        className="w-full rounded-none pr-12 font-mono text-sm [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                        value={bidAmount}
                        onChange={event => {
                          const v = event.target.value
                          if (v === '') {
                            setBidAmount('')
                            return
                          }
                          const n = Number(v)
                          if (!Number.isFinite(n) || n < 0) return
                          setBidAmount(v)
                        }}
                        onBlur={() => {
                          if (bidAmount === '') return
                          const n = Number(bidAmount)
                          if (!Number.isFinite(n) || n < 0) {
                            setBidAmount('')
                            return
                          }
                          const snapped = Math.round(n * 1e6) / 1e6
                          if (snapped < MIN_BID_XDAI) {
                            setBidAmount('')
                            return
                          }
                          setBidAmount(String(snapped))
                        }}
                        onKeyDown={event => {
                          if (event.key === '-' || event.key === '+' || event.key === 'e' || event.key === 'E') {
                            event.preventDefault()
                          }
                        }}
                        placeholder="0.000001"
                        autoComplete="off"
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                        xDAI
                      </span>
                    </div>
                    <Button
                      type="button"
                      className="min-w-0 flex-1 rounded-none whitespace-nowrap"
                      onClick={() => run('Make bid', makeBid)}
                      disabled={
                        Boolean(operation)
                        || !bidAmount
                        || !Number.isFinite(Number(bidAmount))
                        || Number(bidAmount) < MIN_BID_XDAI
                      }
                    >
                      <span>
                        <span className="italic">PLACE BID</span>
                        {' '}
                        💰
                      </span>
                    </Button>
                  </div>
                </div>

                <Collapsible className="mt-4 w-full rounded-md border" defaultOpen={false}>
                  <CollapsibleTrigger className="flex w-full items-center justify-between bg-muted p-2 hover:bg-muted/80">
                    <div className="flex items-center gap-2">
                      <span className="text-xs italic text-muted-foreground">OPEN BIDS</span>
                      {listingDetails.openBidsCounter > 0 ? (
                        <span className="text-xs text-muted-foreground">[{listingDetails.openBidsCounter}]</span>
                      ) : null}
                    </div>
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="p-4">
                    {listingBids.length > 0 ? (
                      <div className="space-y-4">
                        {listingBids.map((bid, index) => (
                          <div key={`${bid.pubKeyX}-${bid.pubKeyY}`} className="flex items-center gap-2 border-b p-2">
                            <div className="flex flex-1 items-center justify-between gap-3">
                              <span className="shrink-0 text-sm text-muted-foreground">#{bid.bidNumber ?? index + 1}</span>
                              <span className="font-bold">{bid.bidAmountInEth} xDAI</span>
                              {isCurrentUserListingOwner ? (
                                <Button
                                  type="button"
                                  className="whitespace-nowrap rounded-none"
                                  variant="outline"
                                  onClick={() => run('Fill bid', () => fillBid(bid))}
                                >
                                  <span>
                                    <span className="italic">FILL BID</span>
                                    {' '}
                                    💰
                                  </span>
                                </Button>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  pk_x:
                                  {' '}
                                  {bid.pubKeyX.substring(0, 8)}
                                  ...
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-center text-xs text-muted-foreground">NO OPEN BIDS AT THIS TIME</p>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </>
            )}
          </section>
        )}

        {route.name === 'about' && (
          <section className="space-y-4 rounded-md border p-6">
            <h2 className="font-display text-3xl">About this app</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              This is a static website that utilizes Swarm and Gnosis Chain to allow users to buy & sell decryption keys for files --entirely peer-to-peer.
            </p>
            <div className="text-sm leading-relaxed text-muted-foreground">
              <p className="mb-2">Users can:</p>
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <span className="shrink-0 text-foreground/80" aria-hidden>
                    ○
                  </span>
                  <span>create LISTINGs for the files they want to sell</span>
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 text-foreground/80" aria-hidden>
                    ○
                  </span>
                  <span>BID on other people&apos;s listings</span>
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 text-foreground/80" aria-hidden>
                    ○
                  </span>
                  <span>decrypt files they receive DKEYs for</span>
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 text-foreground/80" aria-hidden>
                    ○
                  </span>
                  <span>track their LISTINGs, BIDS and DKEYs in their profile</span>
                </div>
                <div className="flex gap-2">
                  <span className="shrink-0 text-foreground/80" aria-hidden>
                    ○
                  </span>
                  <span>use Swarm to back-up their profile data</span>
                </div>
              </div>
            </div>

            <div className="mt-6 rounded-md border border-dashed border-amber-600/50 bg-amber-950/15 p-4">
              <h3 className="font-medium text-amber-200">Publish static site (temp)</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Pick your built <span className="font-mono text-foreground">dist</span> folder (must include{' '}
                <span className="font-mono text-foreground">index.html</span>). Uses Freedom Swarm{' '}
                <span className="font-mono">publishFiles</span>.
              </p>
              <input
                ref={node => {
                  appPublishFolderInputRef.current = node
                  if (node) {
                    node.setAttribute('webkitdirectory', '')
                    node.setAttribute('directory', '')
                  }
                }}
                type="file"
                className="sr-only"
                multiple
                onChange={publishStaticAppToSwarm}
              />
              <Button
                type="button"
                className="mt-3"
                variant="outline"
                disabled={appPublishBusy || !canUseSwarm}
                onClick={() => appPublishFolderInputRef.current?.click()}
              >
                {appPublishBusy ? 'Publishing…' : 'Choose dist folder & publish to Swarm'}
              </Button>
              {appPublishStatus ? (
                <p className={`mt-2 text-sm ${appPublishUrl ? 'text-muted-foreground' : 'text-foreground'}`}>{appPublishStatus}</p>
              ) : null}
              {appPublishUrl ? (
                <p className="mt-2 break-all text-sm">
                  <a className="text-primary underline" href={appPublishUrl} target="_blank" rel="noreferrer">
                    {appPublishUrl}
                  </a>
                </p>
              ) : null}
            </div>
          </section>
        )}

        <section className="mt-auto rounded-md border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs text-green-400 shadow-inner">
          <div className="mb-3 flex items-center justify-between text-zinc-500">
            <span>$ activity —tail 18</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              type="button"
              onClick={() => {
                localStorage.removeItem(ACTIVITY_STORAGE_KEY)
                setActivity([])
              }}
            >
              clear
            </Button>
          </div>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {activity.slice(0, 18).map(item => (
              <div key={item.id} className="border-l-2 border-zinc-700 pl-2">
                <span className="text-zinc-500">{new Date(item.time).toLocaleTimeString()}</span>{' '}
                <span
                  className={
                    item.kind === 'profile'
                      ? 'text-emerald-300/90'
                      : item.kind === 'error'
                        ? 'text-red-300/90'
                        : 'text-amber-200/90'
                  }
                >
                  {item.label}
                </span>
                <div
                  className={`text-zinc-300 ${item.kind === 'profile' ? 'max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs' : ''}`}
                >
                  {item.detail}
                </div>
                {item.txHash && (
                  <a className="text-sky-400 underline" href={transactionExplorerUrl(item.txHash)} target="_blank" rel="noreferrer">
                    {short(item.txHash)}
                  </a>
                )}
                {item.reference && <div className="text-zinc-500">{shortSwarmListingRef(item.reference)}</div>}
              </div>
            ))}
            {activity.length === 0 && <div className="text-zinc-600">No log lines yet.</div>}
          </div>
        </section>
      </main>

      {restoreModal.open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" role="presentation">
          <div
            className="w-full max-w-md rounded-lg border bg-background p-6 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="restore-profile-title"
          >
            <h2 id="restore-profile-title" className="text-lg font-semibold">Swarm profile backup found</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Encrypted profile data for this wallet is stored in Swarm (swarm-kv). Enter the password you used when backing it up.
            </p>
            <label className="mt-4 block text-sm">
              Password
              <Input
                className="mt-1"
                type="password"
                autoComplete="current-password"
                value={restorePassword}
                onChange={event => {
                  setRestorePassword(event.target.value)
                  if (restoreError) setRestoreError('')
                }}
                disabled={restoreBusy}
                aria-invalid={Boolean(restoreError)}
                aria-describedby={restoreError ? 'restore-password-error' : undefined}
              />
            </label>
            {restoreError ? (
              <p id="restore-password-error" className="mt-2 text-sm text-destructive">
                {restoreError}
              </p>
            ) : null}
            <div className="mt-6 flex flex-wrap gap-2">
              <Button type="button" disabled={restoreBusy || !restorePassword} onClick={() => void applyRestoredProfile()}>
                {restoreBusy ? 'Decrypting…' : 'Restore profile'}
              </Button>
              <Button type="button" variant="outline" disabled={restoreBusy} onClick={dismissRestoreOffer}>
                Skip
              </Button>
            </div>
          </div>
        </div>
      )}

      {backupModal.open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" role="presentation">
          <div
            className="w-full max-w-md rounded-lg border bg-background p-6 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="backup-profile-title"
          >
            <h2 id="backup-profile-title" className="text-lg font-semibold">Back up profile to Swarm</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Your profile was updated. Choose a password to encrypt the backup; only you can decrypt it later.
            </p>
            <label className="mt-4 block text-sm">
              Password
              <Input
                className="mt-1"
                type="password"
                autoComplete="new-password"
                value={backupPassword}
                onChange={event => setBackupPassword(event.target.value)}
                disabled={swarmProfileBackupUi.kind === 'running'}
              />
            </label>
            {backupError && <p className="mt-2 text-sm text-destructive">{backupError}</p>}
            <div className="mt-6 flex flex-wrap gap-2">
              <Button type="button" disabled={swarmProfileBackupUi.kind === 'running' || !backupPassword} onClick={() => void runSwarmProfileBackup()}>
                Encrypt & back up
              </Button>
              <Button type="button" variant="outline" disabled={swarmProfileBackupUi.kind === 'running'} onClick={skipBackupNow}>
                Skip
              </Button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={txError} onOpenChange={setTxError}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transaction Error</DialogTitle>
            <DialogDescription>{txErrorMessage || 'Something went wrong while creating the listing.'}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className="rounded-none" onClick={() => setTxError(false)}>
              Cancel
            </Button>
            <Button type="button" className="rounded-none" onClick={() => void createListing()}>
              Try Again
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showDkeysInfo} onOpenChange={setShowDkeysInfo}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle># DKEYs FOR SALE</DialogTitle>
            <DialogDescription>
              The total circulating supply of DKEYs for your listing.
              <br />
              <br />
              This will be the maximum number of DKEYs that you can create and sell for this listing. Once you have sold this many DKEYs, any future sales can only be made by existing holders.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      <Dialog open={showPriceInfo} onOpenChange={setShowPriceInfo}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>SUGGESTED PRICE (xDAI)</DialogTitle>
            <DialogDescription>
              The price that you suggest new buyers to bid at.
              <br />
              <br />
              Buyers can bid any amount they choose, but this serves as a suggestion for what price you may fill bids at.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      <Dialog open={showRoyaltyInfo} onOpenChange={setShowRoyaltyInfo}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>ROYALTY ON RE-SALE (%)</DialogTitle>
            <DialogDescription>
              The percentage of the sale price that you will receive when buyers resell their DKEYs to other users.
              <br />
              <br />
              This royalty is applied to all secondary sales after the initial number of DKEYs have been sold. Accepted range: 1-99%.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      <Dialog open={showUploadFileInfo} onOpenChange={setShowUploadFileInfo}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>UPLOAD FILE TO SELL</DialogTitle>
            <DialogDescription>
              Select & upload the file you wish to sell.
              <br />
              <br />
              The file will be encrypted, then published to Swarm.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      <Dialog open={showCoverPhotoInfo} onOpenChange={setShowCoverPhotoInfo}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>COVER PHOTO</DialogTitle>
            <DialogDescription>
              Select & upload the promotional cover photo for your file.
              <br />
              <br />
              Supported formats: PNG, JPG, GIF, WebP.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default App
