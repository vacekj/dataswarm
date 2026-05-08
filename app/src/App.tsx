import { useEffect, useMemo, useState } from 'react'
import dkey, { BidLite, DkeyUserProfile, ListingMetadata } from 'dkey-lib'
import type { Address } from 'viem'
import { connect, createConfig, getAccount, http, injected } from '@wagmi/core'
import { base } from '@wagmi/core/chains'
import './App.css'

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

type ActivityKind = 'swarm' | 'wallet' | 'chain' | 'file' | 'error'

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

type Route =
  | { name: 'profile' }
  | { name: 'create' }
  | { name: 'listing'; reference: string }

const BASE_CHAIN_ID = 8453
const BASE_CHAIN_HEX = '0x2105'
const REGISTRY_FEED = 'dkey-swarm-demo-registry'
const ACTIVITY_FEED = 'dkey-swarm-demo-activity'
const ACTIVITY_STORAGE_KEY = 'dkey.swarm.activity.v1'
const REGISTRY_STORAGE_KEY = 'dkey.swarm.registry.v1'
const PROFILE_STORAGE_KEY = 'dkey.swarm.profile.v1'
const DEFAULT_BID_AMOUNT = '0.0001'

const baseChainParams = {
  chainId: BASE_CHAIN_HEX,
  chainName: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://mainnet.base.org'],
  blockExplorerUrls: ['https://basescan.org'],
}

const samplePayload = {
  title: 'DKey Swarm Hackathon Sample',
  rows: [
    { metric: 'swarm_reference_model', value: 'manifest-directory' },
    { metric: 'chain', value: 'base-mainnet' },
    { metric: 'routing', value: 'static-spa-hash-router' },
  ],
  createdAt: '2026-05-08T00:00:00.000Z',
}

const formatError = (error: unknown) => {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error) return String((error as { message: unknown }).message)
  return String(error)
}

const short = (value?: string) => {
  if (!value) return 'n/a'
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value
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

const decodeFeedJSON = <T,>(entry: { data: string }) => {
  const bytes = Uint8Array.from(atob(entry.data), char => char.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

const routeFromHash = (): Route => {
  const path = window.location.hash.replace(/^#/, '') || '/profile'
  const listingMatch = path.match(/^\/listings\/([^/]+)$/)
  if (listingMatch) return { name: 'listing', reference: decodeURIComponent(listingMatch[1]) }
  if (path === '/listings/new') return { name: 'create' }
  return { name: 'profile' }
}

const navigate = (path: string) => {
  window.location.hash = path
}

const bzzUrlForReference = (reference: string) => dkey.formatSwarmReference(reference).bzzUrl

const normalizeReference = (reference: string) => dkey.formatSwarmReference(reference).normalizedReference

const tryNormalizeReference = (reference: string) => {
  try {
    return normalizeReference(reference)
  } catch {
    return reference
  }
}

const tryBzzUrlForReference = (reference: string) => {
  try {
    return bzzUrlForReference(reference)
  } catch {
    return ''
  }
}

const fetchBzzBytes = async (bzzUrl: string, path: string, onProgress?: (progress: number) => void) => {
  const url = `${bzzUrl.replace(/\/$/, '')}/${path}`
  const response = await fetch(url)
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

const fetchBzzJSON = async <T,>(bzzUrl: string, path: string) => {
  const bytes = await fetchBzzBytes(bzzUrl, path)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

const metadataFromJSON = (raw: ListingMetadataJSON) => {
  const chainIds = raw.chainIds?.length ? raw.chainIds : [BASE_CHAIN_ID]
  return new ListingMetadata(
    raw.seller ?? {},
    raw.fileName || 'Encrypted data',
    raw.fileDescription || '',
    Number(raw.fileSizeInBytes ?? 0),
    Number(raw.suggestedPriceInEth ?? 0),
    raw.coverPhotoReference || '',
    raw.coverPhotoLink || '',
    chainIds,
    Number(raw.listingCreatedAfterBlock ?? dkey.contracts.DKeyStoreL2[BASE_CHAIN_ID].deploymentBlockNumber),
  )
}

const registryEntryFromMetadata = (reference: string, bzzUrl: string, raw: ListingMetadataJSON): RegistryEntry => {
  const sellerAddress = typeof raw.seller?.address === 'string' ? raw.seller.address : ''
  return {
    id: `${raw.chainIds?.[0] ?? BASE_CHAIN_ID}:${reference}`,
    swarmReference: reference,
    bzzUrl,
    fileName: raw.fileName || 'Encrypted data',
    fileDescription: raw.fileDescription || '',
    fileSizeInBytes: Number(raw.fileSizeInBytes ?? 0),
    suggestedPriceInEth: Number(raw.suggestedPriceInEth ?? 0),
    chainId: raw.chainIds?.[0] ?? BASE_CHAIN_ID,
    contractAddress: dkey.contracts.DKeyStoreL2[BASE_CHAIN_ID].address,
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
  if (metadata.coverPhotoReference) return tryBzzUrlForReference(metadata.coverPhotoReference)
  return ''
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

const profileEntries = <T,>(record: Record<number, Record<string, T>>, chainId = BASE_CHAIN_ID) => Object.entries(record[chainId] ?? {})

const buildConfig = () => createConfig({
  chains: [base],
  connectors: [
    injected({
      target: () => ({
        id: 'freedom',
        name: 'Freedom Wallet',
        provider: window.ethereum as never,
      }),
    }),
  ],
  multiInjectedProviderDiscovery: false,
  transports: {
    [base.id]: http('https://mainnet.base.org'),
  },
})

function App() {
  const config = useMemo(() => buildConfig(), [])
  const [route, setRoute] = useState<Route>(() => routeFromHash())
  const [activity, setActivity] = useState<ActivityEntry[]>(() => loadJSON(ACTIVITY_STORAGE_KEY, []))
  const [registry, setRegistry] = useState<RegistryEntry[]>(() => loadJSON(REGISTRY_STORAGE_KEY, []))
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
  const [description, setDescription] = useState('Encrypted data drop')
  const [price, setPrice] = useState(DEFAULT_BID_AMOUNT)
  const [maxKeys, setMaxKeys] = useState('3')
  const [royalty, setRoyalty] = useState('5')
  const [manualReference, setManualReference] = useState('')
  const [listingMetadata, setListingMetadata] = useState<ListingMetadataJSON | null>(null)
  const [listingDetails, setListingDetails] = useState<ListingDetails | null>(null)
  const [listingBids, setListingBids] = useState<BidLite[]>([])
  const [listingError, setListingError] = useState('')
  const [listingLoading, setListingLoading] = useState(false)
  const [bidAmount, setBidAmount] = useState(DEFAULT_BID_AMOUNT)
  const [increaseAmounts, setIncreaseAmounts] = useState<Record<string, string>>({})

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

  const commitProfile = (source = profile) => {
    const serialized = source.serialize()
    localStorage.setItem(PROFILE_STORAGE_KEY, serialized)
    setProfile(DkeyUserProfile.deserialize(serialized, config))
  }

  const rememberRegistryEntry = async (entry: RegistryEntry, publish = true) => {
    setRegistry(current => {
      const next = [entry, ...current.filter(item => item.id !== entry.id)]
      localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(next))
      return next
    })

    if (publish && window.swarm && feedReady) {
      await window.swarm.writeFeedEntry({ name: REGISTRY_FEED, data: JSON.stringify(entry) })
      await addActivity(makeActivity('swarm', 'Registry feed entry', `${entry.fileName} at ${short(entry.swarmReference)}`, { reference: entry.swarmReference }))
    }
  }

  const connectWallet = async () => {
    if (!window.ethereum) throw new Error('Freedom wallet provider not found')
    setBusy('wallet', 'Connecting wallet', 'Adding and selecting Base, then requesting the active account.')
    try {
      try {
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [baseChainParams] })
        await addActivity(makeActivity('wallet', 'Base chain added', 'wallet_addEthereumChain accepted Base mainnet'), false)
      } catch (error) {
        await addActivity(makeActivity('wallet', 'Base add skipped', formatError(error)), false)
      }

      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_CHAIN_HEX }] })
        await addActivity(makeActivity('wallet', 'Base chain selected', 'wallet_switchEthereumChain accepted Base mainnet'), false)
      } catch (error) {
        await addActivity(makeActivity('wallet', 'Base switch skipped', formatError(error)), false)
      }

      const connector = config.connectors[0]
      try {
        await connect(config, { connector })
      } catch (error) {
        const message = formatError(error)
        if (!message.includes('already connected')) throw error
      }

      const activeConnection = getAccount(config)
      const accounts = activeConnection.address
        ? [activeConnection.address]
        : await window.ethereum.request({ method: 'eth_requestAccounts' }) as Address[]
      const account = accounts[0]
      if (!account) throw new Error('No wallet account returned')
      const chainId = Number(await window.ethereum.request({ method: 'eth_chainId' }))
      setAddress(account)
      setWalletReady(true)
      await addActivity(makeActivity('wallet', 'Wallet connected', `chain=${chainId}; account=${short(account)}`))
      if (chainId !== BASE_CHAIN_ID) {
        await addActivity(makeActivity('error', 'Wrong wallet chain', `Freedom wallet is on ${chainId}; contract writes need Base mainnet (${BASE_CHAIN_ID})`), false)
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
      const access = await window.swarm.requestAccess()
      const caps = await window.swarm.getCapabilities()
      setSwarmReady(caps.canPublish)
      await addActivity(makeActivity('swarm', 'Swarm access', `${access.origin}; publish=${caps.canPublish}${caps.reason ? ` (${caps.reason})` : ''}`), false)

      if (!caps.canPublish) {
        setFeedReady(false)
        return
      }

      await window.swarm.createFeed({ name: REGISTRY_FEED })
      await window.swarm.createFeed({ name: ACTIVITY_FEED })
      setFeedReady(true)
      await addActivity(makeActivity('swarm', 'Feeds ready', `${REGISTRY_FEED}, ${ACTIVITY_FEED}`), false)
    } finally {
      clearBusy()
    }
  }

  const pollUpload = async (tagUid: number, title: string, floor = 30, ceiling = 70) => {
    if (!window.swarm) return
    for (let i = 0; i < 90; i += 1) {
      const status = await window.swarm.getUploadStatus({ tagUid })
      const progress = floor + Math.round((Math.min(100, status.progress) / 100) * (ceiling - floor))
      setBusy('upload', title, `${status.progress}% sent (${status.sent}/${status.split})`, progress)
      if (status.done) return
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }

  const useSampleFile = () => {
    const bytes = new TextEncoder().encode(JSON.stringify(samplePayload, null, 2))
    const file = new File([bytes], 'dkey-swarm-sample.json', { type: 'application/json' })
    setSelectedFile(file)
    setDescription('Sample encrypted JSON dataset for the DKey Swarm demo')
  }

  const createListing = async () => {
    const account = address ?? await connectWallet()
    if (!selectedFile) throw new Error('Choose a file first')
    if (!window.swarm) throw new Error('Freedom Swarm provider not found')

    setBusy('listing', 'Encrypting file', `${selectedFile.name}, ${formatBytes(selectedFile.size)}`, 8)
    try {
      if (!swarmReady) await connectSwarm()
      await dkey.loadSnarkJS()
      dkey.configureCircuits('/circuits')

      const encrypted = await dkey.createKeyAndEncryptFile(await selectedFile.arrayBuffer())
      const encryptedBytes = new Uint8Array(await encrypted.encryptedData.arrayBuffer())
      const currentBlock = Number(await dkey.getCurrentBlock(config, BASE_CHAIN_ID))
      let coverPhotoReference = ''
      let coverPhotoLink = ''

      if (coverPhoto) {
        setBusy('cover', 'Uploading cover photo', coverPhoto.name, 18)
        const extension = coverPhoto.name.includes('.') ? coverPhoto.name.slice(coverPhoto.name.lastIndexOf('.')) : ''
        const coverPath = `cover-photo${extension}`
        const coverUpload = await window.swarm.publishFiles({
          files: [{ path: coverPath, bytes: await coverPhoto.arrayBuffer(), contentType: coverPhoto.type || 'application/octet-stream' }],
        })
        coverPhotoReference = coverUpload.reference
        coverPhotoLink = `${coverUpload.bzzUrl.replace(/\/$/, '')}/${coverPath}`
        if (coverUpload.tagUid) await pollUpload(coverUpload.tagUid, 'Uploading cover photo', 18, 32)
      }

      const metadataJSON: ListingMetadataJSON = {
        seller: { address: account },
        fileName: selectedFile.name,
        fileDescription: description,
        fileSizeInBytes: selectedFile.size,
        suggestedPriceInEth: Number(price),
        coverPhotoReference,
        coverPhotoLink,
        chainIds: [BASE_CHAIN_ID],
        listingCreatedAfterBlock: currentBlock,
        content: {
          encryptedPath: 'encrypted.bin',
          originalType: selectedFile.type || 'application/octet-stream',
        },
      }
      const metadataBytes = new TextEncoder().encode(JSON.stringify(metadataJSON, null, 2))

      setBusy('upload', 'Uploading listing files', 'Publishing encrypted file and metadata to Swarm.', 34)
      const upload = await window.swarm.publishFiles({
        files: [
          { path: 'encrypted.bin', bytes: encryptedBytes, contentType: 'application/octet-stream' },
          { path: 'metadata.json', bytes: metadataBytes, contentType: 'application/json' },
        ],
      })
      if (upload.tagUid) await pollUpload(upload.tagUid, 'Uploading listing files', 34, 68)
      await addActivity(makeActivity('swarm', 'Manifest published', upload.bzzUrl, { reference: upload.reference }))

      setBusy('tx', 'Waiting for signature', 'Confirm createListing in your wallet.', 72)
      const metadata = new ListingMetadata(
        { address: account },
        selectedFile.name,
        description,
        selectedFile.size,
        Number(price),
        coverPhotoReference,
        coverPhotoLink,
        [BASE_CHAIN_ID],
        currentBlock,
      )
      const result = await profile.createListing(
        upload.reference,
        metadata,
        [encrypted.secretKeyX, encrypted.secretKeyY],
        Number(maxKeys),
        Number(royalty),
        account,
      )

      setBusy('tx', 'Confirming transaction', 'Updating your local DKey profile.', 92)
      if (!result.success || !result.receipt) throw new Error(`createListing failed: ${result.result}`)
      commitProfile(result.profile ?? profile)
      await addActivity(makeActivity('chain', 'Listing created', `Block ${result.receipt.blockNumber.toString()}`, {
        txHash: result.receipt.transactionHash,
        reference: upload.reference,
      }))

      const entry = {
        id: `${BASE_CHAIN_ID}:${upload.reference}`,
        swarmReference: upload.reference,
        bzzUrl: upload.bzzUrl,
        fileName: selectedFile.name,
        fileDescription: description,
        fileSizeInBytes: selectedFile.size,
        suggestedPriceInEth: Number(price),
        chainId: BASE_CHAIN_ID,
        contractAddress: dkey.contracts.DKeyStoreL2[BASE_CHAIN_ID].address,
        sellerAddress: account,
        listingTxHash: result.receipt.transactionHash,
        listingBlockNumber: result.receipt.blockNumber.toString(),
        createdAt: Date.now(),
      }
      await rememberRegistryEntry(entry)
      setSelectedFile(null)
      setCoverPhoto(null)
      navigate(`/listings/${upload.reference}`)
    } finally {
      clearBusy()
    }
  }

  const refreshRegistryFromFeed = async () => {
    if (!window.swarm) throw new Error('Freedom Swarm provider not found')
    setBusy('registry', 'Loading registry', 'Reading listing entries from the app feed.')
    try {
      await connectSwarm()
      const latest = await window.swarm.readFeedEntry({ name: REGISTRY_FEED })
      const count = latest.nextIndex ?? latest.index + 1
      const entries: RegistryEntry[] = []
      for (let i = 0; i < count; i += 1) {
        try {
          const entry = await window.swarm.readFeedEntry({ name: REGISTRY_FEED, index: i })
          entries.push(decodeFeedJSON<RegistryEntry>(entry))
        } catch {
          // Sparse feed entries are fine for this append-only demo journal.
        }
      }
      const deduped = [...entries].reverse().filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index)
      setRegistry(deduped)
      localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(deduped))
      await addActivity(makeActivity('swarm', 'Registry loaded', `${deduped.length} listing records`), false)
    } finally {
      clearBusy()
    }
  }

  const openManualReference = () => {
    if (!manualReference.trim()) return
    const normalized = normalizeReference(manualReference)
    setManualReference('')
    navigate(`/listings/${normalized}`)
  }

  const copyReference = async (reference: string) => {
    await navigator.clipboard.writeText(reference)
    await addActivity(makeActivity('file', 'Swarm hash copied', short(reference), { reference }), false)
  }

  const loadListing = async (reference: string) => {
    setListingLoading(true)
    setListingError('')
    setListingMetadata(null)
    setListingDetails(null)
    setListingBids([])
    try {
      const normalized = normalizeReference(reference)
      const bzzUrl = bzzUrlForReference(normalized)
      const metadataJSON = await fetchBzzJSON<ListingMetadataJSON>(bzzUrl, 'metadata.json')
      const metadata = metadataFromJSON(metadataJSON)
      const details = await dkey.fetchListingDetails(normalized, metadata, config) as ListingDetails
      const endBlock = Number(await dkey.getCurrentBlock(config, details.chainId))
      const contractInfo = dkey.contracts.DKeyStoreL2[details.chainId as keyof typeof dkey.contracts.DKeyStoreL2]
      const bidFloor = Number(details.listingCreatedAfterBlock || contractInfo.deploymentBlockNumber)
      const bids = await dkey.fetchBids(normalized, details.chainId, config, bidFloor, bidFloor, endBlock, 5000)
      const withStatuses = await dkey.fetchBidStatuses(details.chainId, bids, config)
      setListingMetadata(metadataJSON)
      setListingDetails(details)
      setListingBids(withStatuses.filter(bid => bid.isOpen))
      await rememberRegistryEntry(registryEntryFromMetadata(normalized, bzzUrl, metadataJSON), false)
    } catch (error) {
      setListingError(formatError(error))
    } finally {
      setListingLoading(false)
    }
  }

  const makeBid = async () => {
    const account = address ?? await connectWallet()
    if (route.name !== 'listing') throw new Error('Open a listing first')
    if (!listingMetadata || !listingDetails) throw new Error('Listing details are not loaded yet')
    setBusy('bid', 'Waiting for signature', `Bidding ${bidAmount} ETH on ${short(route.reference)}.`, 18)
    try {
      const metadata = metadataFromJSON(listingMetadata)
      const result = await profile.makeBid(
        normalizeReference(route.reference),
        Number(bidAmount),
        metadata,
        account,
        listingDetails.chainId,
        listingDetails.canDkeysBeSold,
      )
      setBusy('bid', 'Confirming bid', 'Saving this open bid to your DKey profile.', 82)
      if (!result.success || !result.receipt) throw new Error(`makeBid failed: ${result.result}`)
      commitProfile(result.profile ?? profile)
      await addActivity(makeActivity('chain', 'Bid placed', `${bidAmount} ETH on ${short(route.reference)}`, {
        txHash: result.receipt.transactionHash,
        reference: normalizeReference(route.reference),
      }))
      await loadListing(route.reference)
    } finally {
      clearBusy()
    }
  }

  const fillBid = async (bid: BidLite) => {
    if (route.name !== 'listing' || !listingDetails) throw new Error('Open a listing first')
    setBusy('fill', 'Preparing DKey proof', `Encrypting key material for ${short(bid.pubKeyX)}.`, 12)
    try {
      await dkey.loadSnarkJS()
      dkey.configureCircuits('/circuits')
      setBusy('fill', 'Waiting for signature', 'Confirm the DKey delivery transaction.', 64)
      const result = await profile.fillBid(
        normalizeReference(route.reference),
        bid.pubKeyX,
        bid.pubKeyY,
        Number(bid.bidAmountInEth),
        listingDetails.chainId,
      )
      if (!result.success || !result.receipt) throw new Error(`fillBid failed: ${result.result}`)
      commitProfile(result.profile ?? profile)
      await addActivity(makeActivity('chain', 'DKey provided', `${short(bid.pubKeyX)} received key material`, {
        txHash: result.receipt.transactionHash,
        reference: normalizeReference(route.reference),
      }))
      await loadListing(route.reference)
    } finally {
      clearBusy()
    }
  }

  const increaseBid = async (reference: string, chainId: number) => {
    const amount = increaseAmounts[reference] || DEFAULT_BID_AMOUNT
    setBusy('increase', 'Waiting for signature', `Increasing bid by ${amount} ETH.`, 18)
    try {
      const result = await profile.updateBid(reference, chainId, Number(amount))
      setBusy('increase', 'Confirming update', 'Saving increased bid to your profile.', 82)
      if (!result.success || !result.receipt) throw new Error(`updateBid failed: ${result.result}`)
      commitProfile(result.profile ?? profile)
      await addActivity(makeActivity('chain', 'Bid increased', `${amount} ETH added to ${short(reference)}`, {
        txHash: result.receipt.transactionHash,
        reference,
      }))
    } finally {
      clearBusy()
    }
  }

  const reclaimBid = async (reference: string, chainId: number) => {
    setBusy('reclaim', 'Waiting for signature', `Reclaiming bid for ${short(reference)}.`, 18)
    try {
      const result = await profile.reclaimBid(reference, chainId)
      setBusy('reclaim', 'Confirming reclaim', 'Removing the open bid from your profile.', 82)
      if (!result.success || !result.receipt) throw new Error(`reclaimBid failed: ${result.result}`)
      commitProfile(result.profile ?? profile)
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
    setBusy('dkey', 'Fetching DKey', 'Scanning chain events for encrypted key material.', 18)
    try {
      const result = await profile.fetchDkey(bid)
      if (!result.success) throw new Error(`fetchDkey failed: ${result.result}`)
      commitProfile(result.profile ?? profile)
      await addActivity(makeActivity('chain', 'DKey fetched', short(reference), { reference }))
    } finally {
      clearBusy()
    }
  }

  const downloadDkeyFile = async (reference: string, chainId: number) => {
    const item = profile.myDKeys[chainId]?.[reference]
    if (!item) throw new Error('No DKey found for this listing')
    const bzzUrl = bzzUrlForReference(reference)
    setBusy('download', 'Downloading encrypted file', item.fileName, 8)
    try {
      const encryptedBytes = await fetchBzzBytes(bzzUrl, 'encrypted.bin', progress => {
        setBusy('download', 'Downloading encrypted file', `${progress}% fetched`, 8 + Math.round(progress * 0.48))
      })
      setBusy('download', 'Decrypting file', 'Using your local DKey material.', 72)
      const clearBytes = await item.decryptFile(encryptedBytes.buffer)
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
    dkey.configureCircuits('/circuits')
    void dkey.loadSnarkJS()
  }, [])

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHashChange)
    if (!window.location.hash) navigate('/profile')
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    const updateAccounts = (accounts: unknown) => {
      const first = Array.isArray(accounts) ? accounts[0] as Address | undefined : undefined
      setAddress(first ?? null)
      setWalletReady(Boolean(first))
    }

    if (!window.ethereum) return
    window.ethereum.request({ method: 'eth_accounts' })
      .then(updateAccounts)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (route.name === 'listing') {
      const reference = route.reference
      const timer = window.setTimeout(() => {
        void loadListing(reference)
      }, 0)
      return () => window.clearTimeout(timer)
    }
    return undefined
    // The listing loader is intentionally route-driven; its internal state updates
    // should not re-run this effect after every fetch phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route])

  const isCurrentUserListingOwner = Boolean(
    route.name === 'listing'
    && listingDetails
    && address
    && listingDetails.listingOwnerAddress.toLowerCase() === address.toLowerCase(),
  )

  const activeReference = route.name === 'listing' ? tryNormalizeReference(route.reference) : ''
  const listingBzzUrl = route.name === 'listing' ? tryBzzUrlForReference(route.reference) : ''
  const coverUrl = coverUrlForMetadata(listingMetadata, listingBzzUrl)

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">DKey Swarm</p>
          <h1>{route.name === 'create' ? 'Create listing' : route.name === 'listing' ? 'View listing' : 'Profile'}</h1>
        </div>
        <nav className="nav">
          <button className={route.name === 'profile' ? 'nav-link active' : 'nav-link'} onClick={() => navigate('/profile')}>Profile</button>
          <button className={route.name === 'create' ? 'nav-link active' : 'nav-link'} onClick={() => navigate('/listings/new')}>Create</button>
        </nav>
        <div className="status-row">
          <span className={canUseWallet ? 'status good' : 'status bad'}>wallet {walletReady ? short(address ?? '') : canUseWallet ? 'ready' : 'missing'}</span>
          <span className={canUseSwarm ? 'status good' : 'status bad'}>swarm {swarmReady ? 'publish' : canUseSwarm ? 'detected' : 'missing'}</span>
          <span className={feedReady ? 'status good' : 'status'}>feed {feedReady ? 'on' : 'idle'}</span>
        </div>
      </header>

      <section className="actions">
        <button onClick={() => run('Connect wallet', connectWallet)} disabled={operation !== null || !canUseWallet}>Connect wallet</button>
        <button onClick={() => run('Connect Swarm', connectSwarm)} disabled={operation !== null || !canUseSwarm}>Connect Swarm</button>
        <button onClick={() => run('Load registry', refreshRegistryFromFeed)} disabled={operation !== null || !canUseSwarm}>Load registry</button>
        <div className="manual">
          <input placeholder="Open Swarm hash" value={manualReference} onChange={event => setManualReference(event.target.value)} />
          <button onClick={() => run('Open listing', openManualReference)} disabled={operation !== null}>View</button>
        </div>
      </section>

      {operation && (
        <section className="operation" aria-live="polite">
          <div>
            <strong>{operation.title}</strong>
            <span>{operation.detail}</span>
          </div>
          <progress value={operation.progress} max={100} />
        </section>
      )}

      {route.name === 'profile' && (
        <section className="page profile-page">
          <div className="profile-head">
            <div>
              <span>Connected address · {registry.length} cached listings</span>
              <code>{address ?? 'Connect a wallet to initialize your profile'}</code>
            </div>
            <button onClick={() => run('Load registry', refreshRegistryFromFeed)} disabled={operation !== null || !canUseSwarm}>Sync feed</button>
          </div>

          <section className="section-block">
            <div className="section-title">
              <h2>Listings</h2>
              <span>{profileListings.length}</span>
            </div>
            <div className="item-list">
              {profileListings.map(([reference, listing]) => (
                <article className="item-row" key={reference}>
                  <div>
                    <strong>{listing.metadata.fileName}</strong>
                    <p>{listing.metadata.fileDescription || 'No description'}</p>
                    <code>{short(reference)}</code>
                  </div>
                  <div className="row-meta">
                    <span>{listing.howManyDKeysSold}/{listing.howManyDKeysForSale} sold</span>
                    <span>{listing.metadata.suggestedPriceInEth} ETH</span>
                  </div>
                  <div className="row-actions">
                    <button onClick={() => navigate(`/listings/${reference}`)}>View</button>
                    <button onClick={() => run('Copy reference', () => copyReference(reference))}>Copy</button>
                  </div>
                </article>
              ))}
              {profileListings.length === 0 && <p className="empty">No listings in this local profile yet.</p>}
            </div>
          </section>

          <section className="section-block">
            <div className="section-title">
              <h2>DKeys</h2>
              <span>{profileDKeys.length}</span>
            </div>
            <div className="item-list">
              {profileDKeys.map(([reference, item]) => (
                <article className="item-row" key={reference}>
                  <div>
                    <strong>{item.fileName}</strong>
                    <p>Paid {item.amountPaidInEth} ETH on Base</p>
                    <code>{short(reference)}</code>
                  </div>
                  <div className="row-meta">
                    <span>{item.canSell ? 'resell ready' : 'personal key'}</span>
                  </div>
                  <div className="row-actions">
                    <button onClick={() => run('Download DKey file', () => downloadDkeyFile(reference, item.chainId))}>Download</button>
                    <button onClick={() => navigate(`/listings/${reference}`)}>View</button>
                  </div>
                </article>
              ))}
              {profileDKeys.length === 0 && <p className="empty">No DKeys acquired yet.</p>}
            </div>
          </section>

          <section className="section-block">
            <div className="section-title">
              <h2>Open bids</h2>
              <span>{profileOpenBids.length}</span>
            </div>
            <div className="item-list">
              {profileOpenBids.map(([reference, bid]) => (
                <article className="item-row bid-row" key={reference}>
                  <div>
                    <strong>{bid.fileName}</strong>
                    <p>{bid.bidAmountInEth} ETH bid on Base</p>
                    <code>{short(reference)}</code>
                  </div>
                  <label className="compact-field">
                    Increase ETH
                    <input
                      value={increaseAmounts[reference] ?? DEFAULT_BID_AMOUNT}
                      onChange={event => setIncreaseAmounts(current => ({ ...current, [reference]: event.target.value }))}
                      inputMode="decimal"
                    />
                  </label>
                  <div className="row-actions">
                    <button onClick={() => run('Increase bid', () => increaseBid(reference, bid.chainId))}>Increase</button>
                    <button onClick={() => run('Reclaim bid', () => reclaimBid(reference, bid.chainId))}>Reclaim</button>
                    <button onClick={() => navigate(`/listings/${reference}`)}>View</button>
                    {bid.isFilled && <button onClick={() => run('Fetch DKey', () => fetchDkeyForBid(reference, bid.chainId))}>Fetch DKey</button>}
                  </div>
                </article>
              ))}
              {profileOpenBids.length === 0 && <p className="empty">No open bids in this local profile.</p>}
            </div>
          </section>
        </section>
      )}

      {route.name === 'create' && (
        <section className="page create-page">
          <div className="form-grid">
            <section className="section-block create-form">
              <div className="section-title">
                <h2>Listing file</h2>
                <span>encrypted before upload</span>
              </div>
              <label>
                File to sell
                <input type="file" onChange={event => setSelectedFile(event.target.files?.[0] ?? null)} />
              </label>
              <button onClick={useSampleFile} disabled={operation !== null}>Use sample payload</button>
              {selectedFile && <p className="file-note">{selectedFile.name} · {formatBytes(selectedFile.size)}</p>}
              <label>
                Cover photo
                <input type="file" accept="image/*" onChange={event => setCoverPhoto(event.target.files?.[0] ?? null)} />
              </label>
              {coverPhoto && <p className="file-note">{coverPhoto.name} · {formatBytes(coverPhoto.size)}</p>}
            </section>

            <section className="section-block create-form">
              <div className="section-title">
                <h2>Terms</h2>
                <span>Base mainnet</span>
              </div>
              <label>
                Description
                <textarea value={description} onChange={event => setDescription(event.target.value)} />
              </label>
              <div className="inline-fields">
                <label>
                  Suggested price ETH
                  <input value={price} onChange={event => setPrice(event.target.value)} inputMode="decimal" />
                </label>
                <label>
                  Keys
                  <input value={maxKeys} onChange={event => setMaxKeys(event.target.value)} inputMode="numeric" />
                </label>
                <label>
                  Royalty %
                  <input value={royalty} onChange={event => setRoyalty(event.target.value)} inputMode="numeric" />
                </label>
              </div>
              <button className="primary" onClick={() => run('Create listing', createListing)} disabled={operation !== null || !selectedFile}>Encrypt, upload, list</button>
            </section>
          </div>
        </section>
      )}

      {route.name === 'listing' && (
        <section className="page listing-page">
          {listingLoading && <p className="empty">Loading metadata and on-chain listing details...</p>}
          {listingError && <p className="error-line">{listingError}</p>}
          {!listingLoading && listingDetails && (
            <>
              <section className="listing-hero">
                <div className="cover">
                  {coverUrl ? <img src={coverUrl} alt="" /> : <span>No cover photo</span>}
                </div>
                <div className="listing-summary">
                  <span>Base listing</span>
                  <h2>{listingDetails.fileName}</h2>
                  <p>{listingDetails.description || 'No description supplied.'}</p>
                  <code>{short(activeReference)}</code>
                </div>
              </section>

              <section className="details-grid">
                <div><span>Seller</span><strong>{short(listingDetails.listingOwnerAddress)}</strong></div>
                <div><span>File size</span><strong>{formatBytes(listingDetails.fileSizeInBytes)}</strong></div>
                <div><span>Network</span><strong>Base</strong></div>
                <div><span>Keys for sale</span><strong>{listingDetails.howManyDKeysForSale}</strong></div>
                <div><span>Suggested price</span><strong>{listingDetails.priceInEth} ETH</strong></div>
                <div><span>Keys sold</span><strong>{listingDetails.howManyDKeysSold}</strong></div>
                <div><span>Royalty</span><strong>{listingDetails.royaltyPercentage}%</strong></div>
                <div><span>Open bids</span><strong>{listingBids.length}</strong></div>
              </section>

              <section className="section-block bid-panel">
                <div className="section-title">
                  <h2>Bid</h2>
                  <span>{profile.hasOpenBid(activeReference, listingDetails.chainId) ? 'already in profile' : 'open offer'}</span>
                </div>
                <div className="bid-form">
                  <label>
                    Bid price ETH
                    <input value={bidAmount} onChange={event => setBidAmount(event.target.value)} inputMode="decimal" />
                  </label>
                  <button className="primary" onClick={() => run('Make bid', makeBid)} disabled={operation !== null}>Bid</button>
                </div>
              </section>

              <section className="section-block">
                <div className="section-title">
                  <h2>Current open bids</h2>
                  <span>{listingBids.length}</span>
                </div>
                <div className="bid-list">
                  {listingBids.map(bid => (
                    <article className="bid-card" key={`${bid.pubKeyX}-${bid.pubKeyY}`}>
                      <code>{short(bid.pubKeyX)}</code>
                      <strong>{bid.bidAmountInEth} ETH</strong>
                      <span>{bid.isOpen ? 'open' : 'closed'}</span>
                      {isCurrentUserListingOwner && <button onClick={() => run('Fill bid', () => fillBid(bid))}>Fill</button>}
                    </article>
                  ))}
                  {listingBids.length === 0 && <p className="empty">No open bids found for this listing.</p>}
                </div>
              </section>
            </>
          )}
        </section>
      )}

      <section className="ledger">
        <div className="section-title">
          <h2>Activity</h2>
          <span>{activity.length}</span>
        </div>
        <div className="activity-list">
          {activity.slice(0, 18).map(item => (
            <article key={item.id} className={`activity ${item.kind}`}>
              <span>{new Date(item.time).toLocaleTimeString()}</span>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
              {item.txHash && <a href={`https://basescan.org/tx/${item.txHash}`} target="_blank">{short(item.txHash)}</a>}
              {item.reference && <code>{short(item.reference)}</code>}
            </article>
          ))}
          {activity.length === 0 && <p className="empty">Activity will appear after wallet, Swarm, and listing actions.</p>}
        </div>
      </section>
    </main>
  )
}

export default App
