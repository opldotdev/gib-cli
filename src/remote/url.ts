/**
 * `gib://` remote URLs. A git remote is one peer on one repository:
 *
 *   gib://<host>/<repository origin>   the peer overlay at that host
 *   gib://<repository origin>          local only, no peer
 *
 * "repository origin" is always the genesis `ordfs/dir` root outpoint —
 * never bare "origin", which ordinals and git both already use for
 * something else. No identity appears in the URL: every head names its
 * signer, and which heads are the user's own comes from the wallet.
 */

import { formatOutpoint, parseOutpoint } from '../outpoint.ts'

export type GibUrl = {
	/** Empty for a local-only URL. */
	host: string
	/** Repository origin, normalised to `txid_vout`. */
	origin: string
}

const USAGE =
	'gib URLs are gib://<host>/<repository origin> or gib://<repository origin>'

/** A compressed identity key in lowercase hex, or undefined. */
export function parseIdentity(s: string): string | undefined {
	const id = s.trim().toLowerCase()
	if (!/^0[23][0-9a-f]{64}$/.test(id)) return undefined
	return id
}

export function parseGibUrl(s: string): GibUrl {
	const raw = s.trim()
	if (!raw.startsWith('gib://')) {
		throw new Error(`not a gib:// url: ${s} (${USAGE})`)
	}
	const rest = raw.slice('gib://'.length).replace(/^\/+|\/+$/g, '')
	const parts = rest.split('/')
	let host = ''
	let origin: string
	if (parts.length === 1) {
		origin = parts[0]
	} else if (parts.length === 2) {
		host = parts[0]
		origin = parts[1]
		if (!host || /[\s?#@]/.test(host)) {
			throw new Error(`bad gib url ${s}: invalid host "${host}"`)
		}
		if (parseIdentity(host)) {
			throw new Error(
				`bad gib url ${s}: an identity is not part of the URL; use gib://<host>/${origin} or gib://${origin}`,
			)
		}
	} else {
		throw new Error(`bad gib url ${s}: ${USAGE}`)
	}
	let op: ReturnType<typeof parseOutpoint>
	try {
		op = parseOutpoint(origin)
	} catch (e) {
		throw new Error(
			`bad gib url ${s}: repository origin: ${e instanceof Error ? e.message : e} (${USAGE})`,
		)
	}
	return { host, origin: formatOutpoint(op, '_') }
}

export function formatGibUrl(u: GibUrl): string {
	return u.host ? `gib://${u.host}/${u.origin}` : `gib://${u.origin}`
}

export function isRemote(u: GibUrl): boolean {
	return u.host !== ''
}

/** Loopback hosts are reached over plain HTTP; everything else over HTTPS. */
export function hostBaseUrl(host: string): string {
	const h = host.toLowerCase()
	const local =
		h === 'localhost' ||
		h.startsWith('localhost:') ||
		h === '127.0.0.1' ||
		h.startsWith('127.0.0.1:') ||
		h === '[::1]' ||
		h.startsWith('[::1]:')
	return `${local ? 'http' : 'https'}://${host}`
}
