/**
 * The peer client: BRC-24 lookups on `ls_gib` and BRC-22 submission to
 * `tm_gib`. Syncing is these two lookups, not REST, so a repository can be
 * followed on a domain that declares only an overlay endpoint (BRC-180).
 *
 *   headsSince  one branch's heads from a point forward, oldest first,
 *               each carrying its own BEEF
 *   txs         whole transactions by txid, as one merged BEEF
 *
 * Both post to `${lookup}/lookup` as a BRC-24 question. The answer's
 * `result` arrives JSON-encoded *into a string*, which is the BRC-24
 * response shape, so it is parsed twice.
 *
 * The client validates nothing on chain: no merkle proof is checked here
 * and there is no engine behind this. The server validates; the client
 * asked for what it got.
 */

import { Utils } from '@bsv/sdk'
import {
	type Endpoints,
	LOOKUP_NAME,
	TOPIC_NAME,
	resolveEndpoints,
} from './discover.ts'
import { type GibUrl, isRemote } from './url.ts'

/** Most heads one headsSince page can carry (the overlay's MaxLimit). */
export const MAX_HEADS_SINCE = 100
/** Most transactions one txs request may ask for; over it, it is rejected. */
export const MAX_TXIDS = 50

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_ANSWER = 64 << 20

/** One head from a headsSince page. */
export type SyncHead = {
	/** `txid_vout` of the head output. */
	outpoint: string
	vout: number
	/** BEEF of the transaction that created the head. */
	beef: Uint8Array
}

/**
 * The peer cannot answer from where local state left off. Nothing can be
 * synced until the local copy is repaired.
 */
export class SyncBrokenError extends Error {
	readonly code: string
	constructor(message: string, code: string) {
		super(message)
		this.name = 'SyncBrokenError'
		this.code = code
	}
}

type RawAnswer = {
	type?: string
	outputs?: Array<{ beef?: unknown; outputIndex?: number }>
	result?: unknown
}

type HeadsSinceResult = {
	outpoints?: string[]
	more?: boolean
	code?: string
}

export type PeerOptions = {
	fetchImpl?: typeof fetch
	timeoutMs?: number
}

export class Peer {
	readonly endpoints: Endpoints
	private readonly fetchImpl: typeof fetch
	private readonly timeoutMs: number

	constructor(endpoints: Endpoints, opts: PeerOptions = {}) {
		this.endpoints = {
			submit: endpoints.submit.replace(/\/+$/, ''),
			lookup: endpoints.lookup.replace(/\/+$/, ''),
		}
		this.fetchImpl = opts.fetchImpl ?? fetch
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
	}

	/** One BRC-24 question; returns the answer with `result` already parsed. */
	private async lookup(query: unknown): Promise<RawAnswer> {
		const url = `${this.endpoints.lookup}/lookup`
		let res: Response
		try {
			res = await this.fetchImpl(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: JSON.stringify({ service: LOOKUP_NAME, query }),
				signal: AbortSignal.timeout(this.timeoutMs),
			})
		} catch (e) {
			throw new Error(
				`remote lookup ${url}: ${e instanceof Error ? e.message : e}`,
			)
		}
		const text = (await res.text()).slice(0, MAX_ANSWER)
		if (!res.ok) {
			throw new Error(`remote lookup: HTTP ${res.status}: ${text.trim()}`)
		}
		let answer: RawAnswer
		try {
			answer = JSON.parse(text) as RawAnswer
		} catch (e) {
			throw new Error(
				`remote lookup: ${e instanceof Error ? e.message : 'bad JSON'}`,
			)
		}
		// BRC-24 answers carry `result` as a JSON document encoded into a
		// string; an overlay that hands back an object is accepted too.
		if (typeof answer.result === 'string' && answer.result !== '') {
			try {
				answer.result = JSON.parse(answer.result) as unknown
			} catch (e) {
				throw new Error(
					`remote lookup result: ${e instanceof Error ? e.message : 'bad JSON'}`,
				)
			}
		}
		return answer
	}

	/**
	 * One branch's heads after `since` (exclusive), oldest first. An empty
	 * `since` starts at the branch's first head; an empty identity takes
	 * every publisher's.
	 *
	 * A peer that cannot answer from `since` says so in the result rather
	 * than as an HTTP error, because the overlay collapses lookup errors to
	 * an opaque 500. Those come back as SyncBrokenError.
	 */
	async headsSince(q: {
		origin: string
		branch: string
		identity?: string
		since?: string
		limit?: number
	}): Promise<{ heads: SyncHead[]; more: boolean }> {
		const answer = await this.lookup({
			type: 'headsSince',
			origin: q.origin,
			branch: q.branch,
			...(q.identity ? { identity: q.identity } : {}),
			...(q.since ? { since: q.since } : {}),
			limit: Math.min(q.limit ?? MAX_HEADS_SINCE, MAX_HEADS_SINCE),
		})
		const result = (answer.result ?? {}) as HeadsSinceResult
		switch (result.code ?? '') {
			case '':
				break
			case 'unknown-since':
				throw new SyncBrokenError(
					`the peer does not know head ${q.since} on branch ${q.branch}`,
					'unknown-since',
				)
			case 'missing-beef':
				throw new SyncBrokenError(
					`the peer's copy of branch ${q.branch} stops at a head whose transaction it no longer has`,
					'missing-beef',
				)
			default:
				throw new SyncBrokenError(
					`branch ${q.branch}: ${result.code}`,
					String(result.code),
				)
		}
		const outputs = answer.outputs ?? []
		const outpoints = result.outpoints ?? []
		if (outputs.length !== outpoints.length) {
			throw new Error(
				`remote lookup: ${outputs.length} outputs for ${outpoints.length} outpoints`,
			)
		}
		const heads = outputs.map((o, i) => ({
			outpoint: outpoints[i],
			vout: o.outputIndex ?? 0,
			beef: toBytes(o.beef, 'head beef'),
		}))
		return { heads, more: result.more === true }
	}

	/**
	 * Whole transactions as one merged BEEF, with whatever proofs the peer
	 * has. Transactions it does not hold are simply absent; holding none of
	 * them is a valid empty BEEF. At most MAX_TXIDS per call.
	 */
	async txs(txids: string[]): Promise<Uint8Array> {
		if (txids.length === 0) return new Uint8Array(0)
		if (txids.length > MAX_TXIDS) {
			throw new Error(
				`remote txs: ${txids.length} txids requested, at most ${MAX_TXIDS} per request`,
			)
		}
		const answer = await this.lookup({ type: 'txs', txids })
		const result = (answer.result ?? {}) as { beef?: unknown }
		if (result.beef === undefined || result.beef === null) {
			return new Uint8Array(0)
		}
		return toBytes(result.beef, 'txs beef')
	}

	/** Post an atomic BEEF to the peer's BRC-22 endpoint for tm_gib. */
	async submit(atomicBeef: Uint8Array): Promise<void> {
		const url = `${this.endpoints.submit}/submit`
		let res: Response
		try {
			res = await this.fetchImpl(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/octet-stream',
					'x-topics': TOPIC_NAME,
				},
				body: atomicBeef as unknown as BodyInit,
				signal: AbortSignal.timeout(this.timeoutMs),
			})
		} catch (e) {
			throw new Error(
				`remote submit ${url}: ${e instanceof Error ? e.message : e}`,
			)
		}
		if (!res.ok) {
			const body = (await res.text()).slice(0, 4096)
			throw new Error(`remote submit: HTTP ${res.status}: ${body.trim()}`)
		}
	}
}

/** The peer a remote URL names, or undefined for a local-only URL. */
export async function peerFor(
	url: GibUrl,
	opts: PeerOptions = {},
): Promise<Peer | undefined> {
	if (!isRemote(url)) return undefined
	const endpoints = await resolveEndpoints(url, { fetchImpl: opts.fetchImpl })
	return new Peer(endpoints, opts)
}

/** Byte fields arrive base64 (Go) or as a number array (JS overlays). */
function toBytes(value: unknown, what: string): Uint8Array {
	if (typeof value === 'string') {
		return new Uint8Array(Utils.toArray(value, 'base64'))
	}
	if (Array.isArray(value)) return new Uint8Array(value as number[])
	throw new Error(`remote lookup: ${what} is not bytes`)
}
