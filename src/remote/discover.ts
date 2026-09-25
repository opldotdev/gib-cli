/**
 * BRC-180 overlay discovery.
 *
 * A domain declares the overlay services it hosts in a `metanet.overlays`
 * object in its `/manifest.json`, mapping each BRC-22 topic manager or
 * BRC-24 lookup service name to the base URL that serves it. gib's are
 * `tm_gib` (submit) and `ls_gib` (lookup):
 *
 *   {"metanet":{"overlays":{
 *      "tm_gib":"https://api.1sat.app/1sat/gib/overlay",
 *      "ls_gib":"https://api.1sat.app/1sat/gib/overlay"}}}
 *
 * That is what makes gib://gibhub.net/<repository origin> work: gibhub.net
 * is a website serving no overlay, and its manifest names the host that
 * does. A declared value is used verbatim — submission posts to it +
 * "/submit", lookup to it + "/lookup", and nothing else is appended.
 *
 * When the manifest is missing, unreadable, has no `metanet.overlays`, or
 * declares neither of gib's services, the host the user named is used as
 * the overlay itself, at the path 1sat-stack mounts by default. That is not
 * probing — which the spec forbids — it is contacting exactly the host in
 * the gib:// URL and nothing else. api.1sat.app serves no manifest and
 * works this way. Do not "fix" this into guessing another hostname.
 */

import { type GibUrl, hostBaseUrl } from './url.ts'

/** BRC-22 topic manager name for gib commit heads. */
export const TOPIC_NAME = 'tm_gib'
/** BRC-24 lookup service name for gib commit heads. */
export const LOOKUP_NAME = 'ls_gib'
/** Where 1sat-stack mounts the gib overlay when a peer declares nothing. */
export const DEFAULT_OVERLAY_PATH = '/1sat/gib/overlay'

const MANIFEST_PATH = '/manifest.json'
/** The manifest fetch runs before the first peer request; fail fast. */
const DISCOVER_TIMEOUT_MS = 5_000
const MAX_MANIFEST = 1 << 20

export type Endpoints = {
	/** BRC-22 endpoint; submission posts to `${submit}/submit`. */
	submit: string
	/** BRC-24 endpoint; a lookup posts to `${lookup}/lookup`. */
	lookup: string
}

export type DiscoverOptions = {
	fetchImpl?: typeof fetch
	/** Skip the process-wide cache (tests). */
	noCache?: boolean
}

const cache = new Map<string, Endpoints>()

/** Forget every cached manifest answer (tests). */
export function clearDiscoveryCache(): void {
	cache.clear()
}

export async function resolveEndpoints(
	url: GibUrl,
	opts: DiscoverOptions = {},
): Promise<Endpoints> {
	// A local-only URL names no peer, so there is nothing to resolve.
	if (!url.host) return { submit: '', lookup: '' }
	const base = hostBaseUrl(url.host)
	const fallback: Endpoints = {
		submit: base + DEFAULT_OVERLAY_PATH,
		lookup: base + DEFAULT_OVERLAY_PATH,
	}
	if (!opts.noCache) {
		const hit = cache.get(url.host)
		if (hit) return hit
	}
	const declared = await declaredOverlays(base, opts.fetchImpl ?? fetch)
	const resolved: Endpoints = {
		submit: declared.submit || fallback.submit,
		lookup: declared.lookup || fallback.lookup,
	}
	if (!opts.noCache) cache.set(url.host, resolved)
	return resolved
}

async function declaredOverlays(
	hostBase: string,
	fetchImpl: typeof fetch,
): Promise<{ submit: string; lookup: string }> {
	const none = { submit: '', lookup: '' }
	try {
		const res = await fetchImpl(hostBase + MANIFEST_PATH, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
		})
		if (!res.ok) return none
		const text = (await res.text()).slice(0, MAX_MANIFEST)
		const doc = JSON.parse(text) as {
			metanet?: { overlays?: Record<string, unknown> }
		}
		// Only gib's own keys are read; every other key is ignored, as the
		// spec requires.
		const overlays = doc?.metanet?.overlays
		if (!overlays || typeof overlays !== 'object') return none
		return {
			submit: endpointUrl(overlays[TOPIC_NAME]),
			lookup: endpointUrl(overlays[LOOKUP_NAME]),
		}
	} catch {
		return none
	}
}

/** A declared endpoint, or "" when it is not a usable http(s) URL. */
function endpointUrl(declared: unknown): string {
	if (typeof declared !== 'string') return ''
	const s = declared.trim().replace(/\/+$/, '')
	try {
		const u = new URL(s)
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
		if (!u.host) return ''
		return s
	} catch {
		return ''
	}
}
