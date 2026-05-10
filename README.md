# DataSwarm

DataSwarm is a peer-to-peer marketplace for encrypted files. Sellers encrypt a file in the browser, publish the encrypted payload and listing metadata to Swarm, then sell DKeys on Gnosis Chain. Buyers bid in xDAI, sellers fill bids by delivering encrypted key material on-chain, and buyers use their DKey profile to decrypt and download the file.

The app is built as a static single-page app so it can be hosted directly on Swarm.

## What it does

- Creates encrypted file listings with a cover image, description, suggested price, royalty, and number of keys for sale.
- Publishes encrypted payloads and metadata manifests to Swarm through Freedom Browser.
- Creates and reads DKey listings on Gnosis Chain through `dkey-lib`.
- Lets buyers place, increase, reclaim, and resolve bids.
- Lets sellers fill bids and receive royalties from later resales.
- Tracks local DKey profiles: listings, owned DKeys, and open bids.
- Backs up encrypted profile state to Swarm with the local `swarm-kv` package.
- Copies shareable listing URLs that work as hash routes inside the static SPA.

## Repository layout

```text
app/        React + Vite marketplace SPA
swarm-kv/   Small Swarm key-value library used for encrypted profile backup
```

## Stack

- React, TypeScript, Vite, Tailwind CSS
- Freedom Browser's injected wallet and Swarm provider
- Swarm for encrypted files, listing metadata, and profile backup
- Gnosis Chain for marketplace settlement
- `dkey-lib` for listings, bids, DKey delivery, and file decryption
- `swarm-kv` for feed-backed key-value storage on Swarm

## Requirements

- Node.js 20.19+ or 22+
- Freedom Browser with Swarm enabled and usable postage
- A wallet connected to Gnosis Chain with xDAI for transactions

The app expects `window.ethereum` and `window.swarm` from Freedom Browser for the full demo flow.

## Setup

Install and build the Swarm KV package first:

```bash
cd swarm-kv
npm install
npm run build
```

Install the app dependencies:

```bash
cd ../app
npm install
```

Run the dev server:

```bash
npm run dev
```

Then open the local URL in Freedom Browser.

## Build

From `app/`:

```bash
npm run build
```

The static site is emitted to `app/dist/`. Vite is configured with a relative base path so the build can be published to Swarm and still work as an SPA with hash routing.

## Demo flow

1. Open the app in Freedom Browser.
2. Connect the wallet and select Gnosis Chain.
3. Connect Swarm and create or restore a DKey profile.
4. Create a listing by selecting a file, optional cover image, description, price, key count, and royalty.
5. Share the copied listing URL.
6. Bid on the listing from a buyer profile.
7. Fill the bid from the seller profile.
8. Fetch the received DKey from the buyer profile and download/decrypt the file.

## Notes

- Listing pages are loaded from URL hash routes, so the app remains static-Swarm-hosting friendly.
- Listing metadata is fetched from Swarm first, then on-chain details and open bids are fetched from Gnosis.
- DKey profiles are local-first. The optional Swarm backup is encrypted before upload.
- The contract network for this submission is Gnosis Chain, not Base.

## Checks

```bash
cd app
npm run build
npm run lint
```
