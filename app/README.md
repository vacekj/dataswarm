# DataSwarm app

This folder contains the static marketplace SPA for DataSwarm. It is a React + Vite app that talks to Freedom Browser for wallet and Swarm access, uses `dkey-lib` for the DKey marketplace contract flow, and uses the local `swarm-kv` package for encrypted profile backup.

## Development

Build the local dependency first:

```bash
cd ../swarm-kv
npm install
npm run build
```

Then install and run the app:

```bash
cd ../app
npm install
npm run dev
```

Open the printed localhost URL in Freedom Browser. The full app needs Freedom's injected `window.ethereum` and `window.swarm` providers.

## Scripts

```bash
npm run dev      # local Vite server
npm run build    # builds swarm-kv, type-checks, then emits the static site
npm run lint     # ESLint
npm run preview  # serves the production build locally
```

## Static hosting

The app uses hash routes and a relative Vite base path. Production builds from `app/dist/` can be uploaded to Swarm without a server-side router.

## Network

The submission build targets Gnosis Chain:

- Chain ID: `100`
- Currency: `xDAI`
- Marketplace calls: `dkey-lib`
