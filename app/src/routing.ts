import { listingKeyToSwarmRootHex, listingRefToSwarmRootHexForUrl, toCanonicalListingKey } from './lib/swarmListingCid'

/**
 * `listing.reference`: Swarm manifest root from `?hash=` (0x + 64 hex), or legacy `?cid=` (hex or synthetic CID string).
 * `listing.manifestBzzBase`: optional Swarm manifest root for `?bzz=` — stored as **64 hex chars only** (no `bzz://`, no
 * full URL) so the query string stays valid; `readRoute` rebuilds `{Bee origin or public gateway}/bzz/0x{root}/`.
 * Legacy bookmarks may still use a full `http(s)://…/bzz/…/` value in `?bzz=`; those are left as-is after decode.
 * Internally we still canonicalize to the synthetic multiformats string for dkey-lib; see `src/lib/swarmListingCid.ts`.
 */
export type AppRoute =
  | { name: 'profile' }
  | { name: 'create' }
  | { name: 'listing'; reference: string; manifestBzzBase?: string }
  | { name: 'about' }

export const ROUTE_EVENT = 'dkey-swarm-route'

const LISTING_HASH_PARAM = 'hash'
/** Swarm manifest root (64 lowercase hex) — wire format for `?bzz=`; see `manifestHttpBaseFromSwarmManifestHint`. */
const LISTING_BZZ_PARAM = 'bzz'

/** Must match `FREEDOM_SWARM_HTTP_ORIGIN_KEY` in `App.tsx` (session-stashed Bee HTTP origin). */
const FREEDOM_SWARM_HTTP_ORIGIN_KEY = 'dkey.swarm.freedomHttpOrigin.v1'
const DEFAULT_SWARM_GATEWAY_ORIGIN = 'https://gateway.ethswarm.org'

const peekFreedomSwarmHttpOriginSession = (): string => {
  try {
    return sessionStorage.getItem(FREEDOM_SWARM_HTTP_ORIGIN_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

const BZZ_ROOT_IN_HTTP_PATH = /\/bzz\/(?:0x)?([0-9a-f]{64})(?:\/|$|\?|#)/i

/**
 * Extract the Swarm content root as **64 lowercase hex** (no `0x`) from `bzz://…`, a `/bzz/{root}/` HTTP URL,
 * or a bare `0x`+64 / 64-hex string.
 */
export const extractBareSwarmRoot64HexFromManifestHint = (input: string): string | undefined => {
  const s = input.trim()
  if (!s) return undefined
  if (/^bzz:\/\//i.test(s)) {
    const rest = s.slice(6).replace(/\/$/, '')
    const m = rest.match(/^(?:0x)?([0-9a-f]{64})$/i)
    return m ? m[1].toLowerCase() : undefined
  }
  if (/^https?:\/\//i.test(s)) {
    const m = s.match(BZZ_ROOT_IN_HTTP_PATH)
    return m ? m[1].toLowerCase() : undefined
  }
  const bare = s.replace(/\/$/, '')
  const m = bare.match(/^(?:0x)?([0-9a-f]{64})$/i)
  return m ? m[1].toLowerCase() : undefined
}

const reconstructManifestHttpBaseFromBareRoot64 = (bare64: string): string => {
  const origin = peekFreedomSwarmHttpOriginSession() || DEFAULT_SWARM_GATEWAY_ORIGIN
  return `${origin}/bzz/0x${bare64.toLowerCase()}/`
}

/**
 * Turn Freedom `publishFiles().bzzUrl` (`bzz://{root}`), a bare root, or an HTTP `/bzz/…` base into a normalized
 * manifest fetch base (`https://…/bzz/0x{root}/`). Used outside routing for registry, hints, and uploads.
 */
export const manifestHttpBaseFromSwarmManifestHint = (manifestBzzBase: string): string | undefined => {
  const t = manifestBzzBase.trim()
  if (!t) return undefined
  if (/^https?:\/\//i.test(t)) {
    return t.endsWith('/') ? t : `${t}/`
  }
  const bare = extractBareSwarmRoot64HexFromManifestHint(t)
  if (!bare) return undefined
  return reconstructManifestHttpBaseFromBareRoot64(bare)
}

const bareRoot64ForListingBzzQueryParam = (manifestBzzBase: string | undefined): string | undefined => {
  const t = manifestBzzBase?.trim()
  if (!t) return undefined
  return extractBareSwarmRoot64HexFromManifestHint(t)
}

/**
 * Same query + hash shape as the listing branch of {@link writeRoute}. Clears `hash`, `cid`, and `bzz` before applying
 * so stale params cannot leak into copied share links.
 */
const applyListingRouteToUrl = (url: URL, reference: string, manifestBzzBase?: string): void => {
  url.hash = ''
  url.searchParams.set('page', 'listing')
  url.searchParams.delete(LISTING_HASH_PARAM)
  url.searchParams.delete(LEGACY_LISTING_CID_PARAM)
  url.searchParams.delete(LISTING_BZZ_PARAM)
  url.searchParams.set(LISTING_HASH_PARAM, listingRefToSwarmRootHexForUrl(reference))
  const bare = bareRoot64ForListingBzzQueryParam(manifestBzzBase)
  if (bare) {
    url.searchParams.set(LISTING_BZZ_PARAM, bare)
  }
}

const manifestBzzBaseFromDecodedListingBzzParam = (decoded: string, listingRef: string): string | undefined => {
  const d = decoded.trim()
  if (!d) return undefined
  if (/^https?:\/\//i.test(d)) {
    return d.endsWith('/') ? d : `${d}/`
  }
  const bare = extractBareSwarmRoot64HexFromManifestHint(d)
  if (!bare) return undefined
  if (listingRef) {
    try {
      const want = listingKeyToSwarmRootHex(toCanonicalListingKey(listingRef)).replace(/^0x/i, '').toLowerCase()
      if (bare !== want) {
        console.warn('[routing] ?bzz= root does not match ?hash= / ?cid=; ignoring bzz', { bare, want, listingRef })
        return undefined
      }
    } catch {
      /* invalid listing ref */
    }
  }
  return reconstructManifestHttpBaseFromBareRoot64(bare)
}
/** Legacy query key — still read for bookmarks; new navigations use `hash` only. */
const LEGACY_LISTING_CID_PARAM = 'cid'

/**
 * `URLSearchParams.get` already applies one decode. We must not pre-encode with `encodeURIComponent`
 * before `searchParams.set` (that double-encodes `%` as `%25`). This still unwraps older bookmarks
 * that were saved with double-encoding by repeatedly decoding until stable.
 */
const fullyDecodeListingBzzParam = (raw: string): string => {
  let s = raw.trim()
  if (!s) return ''
  for (let i = 0; i < 8; i += 1) {
    try {
      const next = decodeURIComponent(s)
      if (next === s) break
      s = next
    } catch {
      break
    }
  }
  return s
}

export function readRoute(): AppRoute {
  const params = new URLSearchParams(window.location.search)
  const page = params.get('page') || 'profile'
  if (page === 'create') return { name: 'create' }
  if (page === 'about') return { name: 'about' }
  if (page === 'listing') {
    const ref =
      params.get(LISTING_HASH_PARAM)?.trim()
      || params.get(LEGACY_LISTING_CID_PARAM)?.trim()
      || ''
    const bzzRaw = params.get(LISTING_BZZ_PARAM)?.trim() ?? ''
    const decoded = bzzRaw ? fullyDecodeListingBzzParam(bzzRaw) : ''
    const manifestBzzBase = decoded ? manifestBzzBaseFromDecodedListingBzzParam(decoded, ref) : undefined
    if (bzzRaw || decoded) {
      console.log('[bzzUrl debug] readRoute listing', {
        bzzRawFromSearchParams: bzzRaw,
        decodedListingBzzParam: decoded || undefined,
        manifestBzzBaseReconstructed: manifestBzzBase,
        hash: ref,
      })
    }
    return { name: 'listing', reference: ref, manifestBzzBase }
  }
  return { name: 'profile' }
}

export function writeRoute(route: AppRoute, mode: 'push' | 'replace' = 'push') {
  const url = urlForRoute(route)
  if (mode === 'replace') {
    window.history.replaceState({}, '', url)
  } else {
    window.history.pushState({}, '', url)
  }
  window.dispatchEvent(new Event(ROUTE_EVENT))
}

export function urlForRoute(route: AppRoute): URL {
  const url = new URL(window.location.href)
  url.hash = ''
  const clearListingParams = () => {
    url.searchParams.delete(LISTING_HASH_PARAM)
    url.searchParams.delete(LEGACY_LISTING_CID_PARAM)
    url.searchParams.delete(LISTING_BZZ_PARAM)
  }
  if (route.name === 'profile') {
    url.searchParams.set('page', 'profile')
    clearListingParams()
  } else if (route.name === 'create') {
    url.searchParams.set('page', 'create')
    clearListingParams()
  } else if (route.name === 'about') {
    url.searchParams.set('page', 'about')
    clearListingParams()
  } else {
    applyListingRouteToUrl(url, route.reference, route.manifestBzzBase)
    const bare = bareRoot64ForListingBzzQueryParam(route.manifestBzzBase)
    if (bare) {
      console.log('[bzzUrl debug] writeRoute listing', {
        manifestBzzBaseInput: route.manifestBzzBase,
        bzzQueryWireValue: bare,
      })
    }
  }
  return url
}

export function listingShareUrl(reference: string, manifestBzzBase?: string): string {
  const url = urlForRoute({ name: 'listing', reference, manifestBzzBase })
  const bare = bareRoot64ForListingBzzQueryParam(manifestBzzBase)
  if (bare) {
    console.log('[bzzUrl debug] listingShareUrl', {
      manifestBzzBaseArg: manifestBzzBase,
      bzzQueryWireValue: bare,
    })
  }
  const out = url.toString()
  if (bare) {
    console.log('[bzzUrl debug] listingShareUrl result', { bzzQueryInUrl: new URL(out).searchParams.get(LISTING_BZZ_PARAM), fullUrl: out })
  }
  return out
}
