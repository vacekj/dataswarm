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

const BASE_CHAIN_ID = 8453
const BASE_CHAIN_HEX = '0x2105'
const REGISTRY_FEED = 'dkey-swarm-demo-registry'
const ACTIVITY_FEED = 'dkey-swarm-demo-activity'
const ACTIVITY_STORAGE_KEY = 'dkey.swarm.activity.v1'
const REGISTRY_STORAGE_KEY = 'dkey.swarm.registry.v1'
const PROFILE_STORAGE_KEY = 'dkey.swarm.profile.v1'
const SAMPLE_PAYLOAD = {
  title: 'DKey Swarm Hackathon Sample',
  rows: [
    { metric: 'swarm_reference_model', value: 'manifest-directory' },
    { metric: 'chain', value: 'base-mainnet' },
    { metric: 'tracking', value: 'local-ledger-and-swarm-feed' },
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

const baseChainParams = {
  chainId: BASE_CHAIN_HEX,
  chainName: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://mainnet.base.org'],
  blockExplorerUrls: ['https://basescan.org'],
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

const fetchBzzBytes = async (bzzUrl: string, path: string) => {
  const url = `${bzzUrl.replace(/\/$/, '')}/${path}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

const fetchBzzJSON = async <T,>(bzzUrl: string, path: string) => {
  const bytes = await fetchBzzBytes(bzzUrl, path)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

function App() {
  const [activity, setActivity] = useState<ActivityEntry[]>(() => loadJSON(ACTIVITY_STORAGE_KEY, []))
  const [registry, setRegistry] = useState<RegistryEntry[]>(() => loadJSON(REGISTRY_STORAGE_KEY, []))
  const [address, setAddress] = useState<Address | null>(null)
  const [swarmReady, setSwarmReady] = useState(false)
  const [walletReady, setWalletReady] = useState(false)
  const [feedReady, setFeedReady] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [description, setDescription] = useState('Encrypted data drop')
  const [price, setPrice] = useState('0.0001')
  const [maxKeys, setMaxKeys] = useState('3')
  const [royalty, setRoyalty] = useState('5')
  const [manualReference, setManualReference] = useState('')
  const [bidAmount, setBidAmount] = useState('0.0001')
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null)
  const [openBids, setOpenBids] = useState<BidLite[]>([])
  const [lastUploadStatus, setLastUploadStatus] = useState<UploadStatus | null>(null)

  const config = useMemo(() => createConfig({
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
  }), [])

  const profile = useMemo(() => {
    const serialized = localStorage.getItem(PROFILE_STORAGE_KEY)
    if (serialized) {
      try {
        return DkeyUserProfile.deserialize(serialized, config)
      } catch {
        localStorage.removeItem(PROFILE_STORAGE_KEY)
      }
    }
    return new DkeyUserProfile({ app: 'dkey-swarm-demo' }, {}, {}, {}, {}, config)
  }, [config])

  const selectedListing = registry.find(item => item.id === selectedListingId) ?? registry[0]
  const canUseSwarm = Boolean(window.swarm)
  const canUseWallet = Boolean(window.ethereum)

  const addActivity = async (entry: ActivityEntry, publish = true) => {
    setActivity(current => {
      const next = [entry, ...current].slice(0, 160)
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

  const persistProfile = () => {
    localStorage.setItem(PROFILE_STORAGE_KEY, profile.serialize())
  }

  const useSampleFile = () => {
    const bytes = new TextEncoder().encode(JSON.stringify(SAMPLE_PAYLOAD, null, 2))
    const file = new File([bytes], 'dkey-swarm-sample.json', { type: 'application/json' })
    setSelectedFile(file)
    setDescription('Sample encrypted JSON dataset for the DKey Swarm demo')
  }

  const connectWallet = async () => {
    if (!window.ethereum) throw new Error('Freedom wallet provider not found')
    setBusy('wallet')
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
      setBusy(null)
    }
  }

  const connectSwarm = async () => {
    if (!window.swarm) throw new Error('Freedom Swarm provider not found')
    setBusy('swarm')
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
      setBusy(null)
    }
  }

  const pollUpload = async (tagUid: number) => {
    if (!window.swarm) return
    for (let i = 0; i < 80; i += 1) {
      const status = await window.swarm.getUploadStatus({ tagUid })
      setLastUploadStatus(status)
      await addActivity(makeActivity('swarm', 'Upload status', `${status.progress}% sent (${status.sent}/${status.split})`, { detail: JSON.stringify(status) }), false)
      if (status.done) return
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }

  const publishRegistryEntry = async (entry: RegistryEntry) => {
    setRegistry(current => {
      const next = [entry, ...current.filter(item => item.id !== entry.id)]
      localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(next))
      return next
    })

    if (window.swarm && feedReady) {
      await window.swarm.writeFeedEntry({ name: REGISTRY_FEED, data: JSON.stringify(entry) })
      await addActivity(makeActivity('swarm', 'Registry feed entry', `${entry.fileName} at ${short(entry.swarmReference)}`, { reference: entry.swarmReference }))
    }
  }

  const createListing = async () => {
    const account = address ?? await connectWallet()
    if (!selectedFile) throw new Error('Choose a file first')
    if (!window.swarm) throw new Error('Freedom Swarm provider not found')

    setBusy('listing')
    try {
      if (!swarmReady) await connectSwarm()
      await dkey.loadSnarkJS()
      dkey.configureCircuits('/circuits')

      await addActivity(makeActivity('file', 'Encrypting file', `${selectedFile.name}, ${selectedFile.size} bytes`))
      const encrypted = await dkey.createKeyAndEncryptFile(await selectedFile.arrayBuffer())
      const encryptedBytes = new Uint8Array(await encrypted.encryptedData.arrayBuffer())
      const currentBlock = Number(await dkey.getCurrentBlock(config, BASE_CHAIN_ID))

      const draftMetadata = {
        seller: { address: account },
        fileName: selectedFile.name,
        fileDescription: description,
        fileSizeInBytes: selectedFile.size,
        suggestedPriceInEth: Number(price),
        coverPhotoReference: '',
        coverPhotoLink: '',
        chainIds: [BASE_CHAIN_ID],
        listingCreatedAfterBlock: currentBlock,
        content: {
          encryptedPath: 'encrypted.bin',
          originalType: selectedFile.type || 'application/octet-stream',
        },
      }

      const metadataBytes = new TextEncoder().encode(JSON.stringify(draftMetadata, null, 2))
      const upload = await window.swarm.publishFiles({
        files: [
          { path: 'encrypted.bin', bytes: encryptedBytes, contentType: 'application/octet-stream' },
          { path: 'metadata.json', bytes: metadataBytes, contentType: 'application/json' },
        ],
      })

      await addActivity(makeActivity('swarm', 'Manifest published', upload.bzzUrl, { reference: upload.reference }))
      if (upload.tagUid) await pollUpload(upload.tagUid)

      const metadata = new ListingMetadata(
        { address: account },
        selectedFile.name,
        description,
        selectedFile.size,
        Number(price),
        '',
        '',
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

      if (!result.success || !result.receipt) throw new Error(`createListing failed: ${result.result}`)
      persistProfile()
      await addActivity(makeActivity('chain', 'Listing created', `Block ${result.receipt.blockNumber.toString()}`, {
        txHash: result.receipt.transactionHash,
        reference: upload.reference,
      }))

      await publishRegistryEntry({
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
      })
    } finally {
      setBusy(null)
    }
  }

  const importManualListing = async () => {
    if (!manualReference.trim()) return
    const formatted = dkey.formatSwarmReference(manualReference)
    const bzzUrl = formatted.bzzUrl
    let metadata: Partial<RegistryEntry> = {}
    try {
      const manifestMetadata = await fetchBzzJSON<Record<string, unknown>>(bzzUrl, 'metadata.json')
      metadata = {
        fileName: String(manifestMetadata.fileName ?? 'Swarm data'),
        fileDescription: String(manifestMetadata.fileDescription ?? ''),
        fileSizeInBytes: Number(manifestMetadata.fileSizeInBytes ?? 0),
        suggestedPriceInEth: Number(manifestMetadata.suggestedPriceInEth ?? bidAmount),
      }
    } catch {
      metadata = { fileName: 'Swarm data', fileDescription: 'Manual import', fileSizeInBytes: 0, suggestedPriceInEth: Number(bidAmount) }
    }

    const entry: RegistryEntry = {
      id: `${BASE_CHAIN_ID}:${formatted.normalizedReference}`,
      swarmReference: formatted.normalizedReference,
      bzzUrl,
      fileName: metadata.fileName ?? 'Swarm data',
      fileDescription: metadata.fileDescription ?? '',
      fileSizeInBytes: metadata.fileSizeInBytes ?? 0,
      suggestedPriceInEth: metadata.suggestedPriceInEth ?? Number(bidAmount),
      chainId: BASE_CHAIN_ID,
      contractAddress: dkey.contracts.DKeyStoreL2[BASE_CHAIN_ID].address,
      sellerAddress: '',
      listingTxHash: '',
      listingBlockNumber: '0',
      createdAt: Date.now(),
    }
    await publishRegistryEntry(entry)
    await addActivity(makeActivity('swarm', 'Listing imported', `${entry.fileName} at ${short(entry.swarmReference)}`, {
      reference: entry.swarmReference,
    }), false)
    setSelectedListingId(entry.id)
    setManualReference('')
  }

  const refreshRegistryFromFeed = async () => {
    if (!window.swarm) throw new Error('Freedom Swarm provider not found')
    setBusy('registry')
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
          // Sparse or missing feed entries are acceptable in a demo journal.
        }
      }
      const deduped = [...entries].reverse().filter((item, index, all) => all.findIndex(candidate => candidate.id === item.id) === index)
      setRegistry(deduped)
      localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(deduped))
      await addActivity(makeActivity('swarm', 'Registry loaded', `${deduped.length} listing records`), false)
    } finally {
      setBusy(null)
    }
  }

  const fetchDetailsAndBids = async () => {
    if (!selectedListing) return
    setBusy('bids')
    try {
      const metadata = new ListingMetadata(
        { address: selectedListing.sellerAddress },
        selectedListing.fileName,
        selectedListing.fileDescription,
        selectedListing.fileSizeInBytes,
        selectedListing.suggestedPriceInEth,
        '',
        '',
        [BASE_CHAIN_ID],
        Number(selectedListing.listingBlockNumber || dkey.contracts.DKeyStoreL2[BASE_CHAIN_ID].deploymentBlockNumber),
      )
      const details = await dkey.fetchListingDetails(selectedListing.swarmReference, metadata, config)
      const endBlock = Number(await dkey.getCurrentBlock(config, BASE_CHAIN_ID))
      const bids = await dkey.fetchBids(
        selectedListing.swarmReference,
        BASE_CHAIN_ID,
        config,
        Number(details.listingCreatedAfterBlock || dkey.contracts.DKeyStoreL2[BASE_CHAIN_ID].deploymentBlockNumber),
        Number(details.listingCreatedAfterBlock || dkey.contracts.DKeyStoreL2[BASE_CHAIN_ID].deploymentBlockNumber),
        endBlock,
        5000,
      )
      const withStatuses = await dkey.fetchBidStatuses(BASE_CHAIN_ID, bids, config)
      setOpenBids(withStatuses)
      await addActivity(makeActivity('chain', 'Listing refreshed', `${withStatuses.length} bids found for ${short(selectedListing.swarmReference)}`))
    } finally {
      setBusy(null)
    }
  }

  const makeBid = async () => {
    const account = address ?? await connectWallet()
    if (!selectedListing) throw new Error('Select a listing first')
    setBusy('bid')
    try {
      const metadata = new ListingMetadata(
        { address: selectedListing.sellerAddress },
        selectedListing.fileName,
        selectedListing.fileDescription,
        selectedListing.fileSizeInBytes,
        selectedListing.suggestedPriceInEth,
        '',
        '',
        [BASE_CHAIN_ID],
        Number(selectedListing.listingBlockNumber || dkey.contracts.DKeyStoreL2[BASE_CHAIN_ID].deploymentBlockNumber),
      )
      const result = await profile.makeBid(selectedListing.swarmReference, Number(bidAmount), metadata, account, BASE_CHAIN_ID)
      if (!result.success || !result.receipt) throw new Error(`makeBid failed: ${result.result}`)
      persistProfile()
      await addActivity(makeActivity('chain', 'Bid placed', `${bidAmount} ETH on ${short(selectedListing.swarmReference)}`, {
        txHash: result.receipt.transactionHash,
        reference: selectedListing.swarmReference,
      }))
    } finally {
      setBusy(null)
    }
  }

  const fillFirstBid = async () => {
    if (!selectedListing) throw new Error('Select a listing first')
    const bid = openBids.find(item => item.isOpen)
    if (!bid) throw new Error('No open bid loaded')
    setBusy('fill')
    try {
      await dkey.loadSnarkJS()
      dkey.configureCircuits('/circuits')
      const result = await profile.fillBid(
        selectedListing.swarmReference,
        bid.pubKeyX,
        bid.pubKeyY,
        Number(bid.bidAmountInEth),
        BASE_CHAIN_ID,
      )
      if (!result.success || !result.receipt) throw new Error(`fillBid failed: ${result.result}`)
      persistProfile()
      await addActivity(makeActivity('chain', 'DKey provided', `${short(bid.pubKeyX)} received key material`, {
        txHash: result.receipt.transactionHash,
        reference: selectedListing.swarmReference,
      }))
    } finally {
      setBusy(null)
    }
  }

  const fetchDKeyAndDownload = async () => {
    if (!selectedListing) throw new Error('Select a listing first')
    const open = Object.values(profile.myOpenBids[BASE_CHAIN_ID] ?? {}).find(bid => bid.swarmReference === selectedListing.swarmReference)
    if (!open) throw new Error('No local open bid for this listing')
    setBusy('download')
    try {
      const result = await profile.fetchDkey(open)
      if (!result.success) throw new Error(`fetchDkey failed: ${result.result}`)
      persistProfile()
      const acquired = profile.getDKey(selectedListing.swarmReference, BASE_CHAIN_ID)
      const encryptedBytes = await fetchBzzBytes(selectedListing.bzzUrl, 'encrypted.bin')
      const clearBytes = await acquired.decryptFile(encryptedBytes.buffer)
      const blob = new Blob([clearBytes.slice()], { type: 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = acquired.fileName
      link.click()
      URL.revokeObjectURL(url)
      await addActivity(makeActivity('file', 'Downloaded and decrypted', acquired.fileName, { reference: selectedListing.swarmReference }))
    } finally {
      setBusy(null)
    }
  }

  const run = (label: string, action: () => Promise<void>) => {
    action().catch(error => {
      void addActivity(makeActivity('error', label, formatError(error)), false)
      setBusy(null)
    })
  }

  useEffect(() => {
    dkey.configureCircuits('/circuits')
    void dkey.loadSnarkJS()
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

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">DKey Swarm Demo</p>
          <h1>Encrypted data marketplace</h1>
        </div>
        <div className="status-row">
          <span className={canUseWallet ? 'status good' : 'status bad'}>wallet {walletReady ? short(address ?? '') : canUseWallet ? 'ready' : 'missing'}</span>
          <span className={canUseSwarm ? 'status good' : 'status bad'}>swarm {swarmReady ? 'publish' : canUseSwarm ? 'detected' : 'missing'}</span>
          <span className={feedReady ? 'status good' : 'status'}>feed {feedReady ? 'on' : 'idle'}</span>
        </div>
      </header>

      <section className="actions">
        <button onClick={() => run('Connect wallet', async () => { await connectWallet() })} disabled={busy !== null || !canUseWallet}>Add Base + connect wallet</button>
        <button onClick={() => run('Connect Swarm', connectSwarm)} disabled={busy !== null || !canUseSwarm}>Connect Swarm + feeds</button>
        <button onClick={() => run('Load registry', refreshRegistryFromFeed)} disabled={busy !== null || !canUseSwarm}>Load registry feed</button>
        {busy && <span className="working">Working: {busy}</span>}
      </section>

      <section className="workspace">
        <div className="panel seller">
          <div className="panel-heading">
            <span>Seller</span>
            <strong>Publish encrypted data</strong>
          </div>
          <label>
            Data file
            <input type="file" onChange={event => setSelectedFile(event.target.files?.[0] ?? null)} />
          </label>
          <button onClick={useSampleFile} disabled={busy !== null}>Use sample payload</button>
          {selectedFile && <p className="file-note">{selectedFile.name} · {selectedFile.size} bytes</p>}
          <label>
            Description
            <input value={description} onChange={event => setDescription(event.target.value)} />
          </label>
          <div className="inline-fields">
            <label>
              Price ETH
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
          <button className="primary" onClick={() => run('Create listing', createListing)} disabled={busy !== null || !selectedFile}>Encrypt, upload, list</button>
          {lastUploadStatus && <progress value={lastUploadStatus.progress} max={100} />}
        </div>

        <div className="panel market">
          <div className="panel-heading">
            <span>Registry</span>
            <strong>{registry.length} listing records</strong>
          </div>
          <div className="manual">
            <input placeholder="bzz:// or 64-char Swarm reference" value={manualReference} onChange={event => setManualReference(event.target.value)} />
            <button onClick={() => run('Import listing', importManualListing)} disabled={busy !== null}>Import</button>
          </div>
          <div className="listing-list">
            {registry.map(item => (
              <button
                key={item.id}
                className={selectedListing?.id === item.id ? 'listing selected' : 'listing'}
                onClick={() => setSelectedListingId(item.id)}
              >
                <span>{item.fileName}</span>
                <code>{short(item.swarmReference)}</code>
                <small>{item.suggestedPriceInEth} ETH · {item.fileSizeInBytes} bytes</small>
              </button>
            ))}
            {registry.length === 0 && <p className="empty">No registry entries yet. Publish or import a Swarm listing.</p>}
          </div>
        </div>

        <div className="panel buyer">
          <div className="panel-heading">
            <span>Buyer</span>
            <strong>{selectedListing ? selectedListing.fileName : 'No listing selected'}</strong>
          </div>
          {selectedListing && (
            <>
              <dl>
                <div><dt>Reference</dt><dd>{short(selectedListing.swarmReference)}</dd></div>
                <div><dt>Contract</dt><dd>{short(selectedListing.contractAddress)}</dd></div>
                <div><dt>Seller</dt><dd>{short(selectedListing.sellerAddress)}</dd></div>
              </dl>
              <label>
                Bid amount ETH
                <input value={bidAmount} onChange={event => setBidAmount(event.target.value)} inputMode="decimal" />
              </label>
              <div className="button-grid">
                <button onClick={() => run('Refresh listing', fetchDetailsAndBids)} disabled={busy !== null}>Details + bids</button>
                <button onClick={() => run('Make bid', makeBid)} disabled={busy !== null}>Make bid</button>
                <button onClick={() => run('Fill bid', fillFirstBid)} disabled={busy !== null}>Fill first bid</button>
                <button onClick={() => run('Fetch DKey', fetchDKeyAndDownload)} disabled={busy !== null}>Fetch key + download</button>
              </div>
              <div className="bids">
                {openBids.map(bid => (
                  <div key={`${bid.pubKeyX}-${bid.pubKeyY}`}>
                    <code>{short(bid.pubKeyX)}</code>
                    <span>{bid.bidAmountInEth} ETH</span>
                    <span>{bid.isOpen ? 'open' : 'closed'}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      <section className="ledger">
        <div className="panel-heading">
          <span>Interaction ledger</span>
          <strong>{activity.length} local events</strong>
        </div>
        <div className="activity-list">
          {activity.map(item => (
            <article key={item.id} className={`activity ${item.kind}`}>
              <span>{new Date(item.time).toLocaleTimeString()}</span>
              <strong>{item.label}</strong>
              <p>{item.detail}</p>
              {item.txHash && <a href={`https://basescan.org/tx/${item.txHash}`} target="_blank">{short(item.txHash)}</a>}
              {item.reference && <code>{short(item.reference)}</code>}
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}

export default App
