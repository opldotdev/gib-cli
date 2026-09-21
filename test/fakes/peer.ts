/**
 * A fake gib peer: a BRC-180 manifest, a BRC-22 submit endpoint and the two
 * BRC-24 sync lookups (`headsSince`, `txs`), backed by an in-memory index of
 * whatever has been submitted to it. It validates nothing on chain, which is
 * exactly what a test needs: the shapes are real, the consensus is not.
 */

import { Beef, Transaction } from '@bsv/sdk'
import { decodeCommitToken } from '../../src/token.ts'

export type FakeHead = {
	outpoint: string
	txid: string
	vout: number
	origin: string
	branch: string
	identity: string
	root: string
	/** Insertion order: the peer's notion of "newer". */
	order: number
}

export type FakePeer = {
	url: string
	host: string
	heads: () => FakeHead[]
	txids: () => string[]
	/** Requests served, as `<method> <path>` or `lookup:<type>`. */
	calls: string[]
	stop: () => void
	/** Serve /manifest.json (default true). */
	setManifest: (on: boolean) => void
}

type Options = {
	/** Serve a BRC-180 manifest pointing at this peer's own overlay. */
	manifest?: boolean
	/** Mount the overlay endpoint here (default /1sat/gib/overlay). */
	overlayPath?: string
	/** Cap one headsSince page. */
	maxHeads?: number
}

export function startFakePeer(opts: Options = {}): FakePeer {
	const overlayPath = opts.overlayPath ?? '/1sat/gib/overlay'
	const maxHeads = opts.maxHeads ?? 100
	let manifest = opts.manifest ?? true
	const txs = new Map<string, Transaction>()
	const heads: FakeHead[] = []
	const calls: string[] = []

	const index = (tx: Transaction) => {
		const txid = tx.id('hex')
		if (!txs.has(txid)) txs.set(txid, tx)
		tx.outputs.forEach((out, vout) => {
			if (out.satoshis !== 1) return
			let token: ReturnType<typeof decodeCommitToken>
			try {
				token = decodeCommitToken(out.lockingScript)
			} catch {
				return
			}
			const outpoint = `${txid}_${vout}`
			if (heads.some((h) => h.outpoint === outpoint)) return
			heads.push({
				outpoint,
				txid,
				vout,
				origin: token.origin,
				branch: token.branch,
				identity: token.identityPubkey,
				root: token.root,
				order: heads.length,
			})
		})
	}

	const absorb = (bytes: Uint8Array) => {
		const beef = Beef.fromBinary(Array.from(bytes))
		for (const btx of beef.txs) {
			if (btx.tx) index(btx.tx)
		}
	}

	const beefFor = (wanted: string[]): Uint8Array => {
		const merged = new Beef()
		for (const txid of wanted) {
			const tx = txs.get(txid)
			if (tx) merged.mergeTransaction(tx)
		}
		return new Uint8Array(merged.toBinary())
	}

	const answerHeadsSince = (q: {
		origin?: string
		branch?: string
		identity?: string
		since?: string
		limit?: number
	}) => {
		const all = heads.filter(
			(h) =>
				h.origin === q.origin &&
				h.branch === q.branch &&
				(!q.identity || h.identity === q.identity),
		)
		let start = 0
		if (q.since) {
			const at = all.findIndex((h) => h.outpoint === q.since)
			if (at < 0) {
				return {
					type: 'output-list',
					outputs: [],
					result: JSON.stringify({
						query: 'headsSince',
						outpoints: [],
						more: false,
						code: 'unknown-since',
					}),
				}
			}
			start = at + 1
		}
		const limit = Math.min(q.limit && q.limit > 0 ? q.limit : maxHeads, maxHeads)
		const page = all.slice(start, start + limit)
		const more = start + page.length < all.length
		return {
			type: 'output-list',
			outputs: page.map((h) => ({
				beef: base64(beefFor([h.txid])),
				outputIndex: h.vout,
			})),
			result: JSON.stringify({
				query: 'headsSince',
				origin: q.origin,
				branch: q.branch,
				outpoints: page.map((h) => h.outpoint),
				more,
			}),
		}
	}

	let port = 0
	const server = Bun.serve({
		port: 0,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url)
			calls.push(`${req.method} ${url.pathname}`)
			if (url.pathname === '/manifest.json') {
				if (!manifest) return new Response('not found', { status: 404 })
				const base = `http://127.0.0.1:${port}${overlayPath}`
				return Response.json({
					name: 'fake peer',
					metanet: { overlays: { tm_gib: base, ls_gib: base } },
				})
			}
			if (url.pathname === `${overlayPath}/submit`) {
				absorb(new Uint8Array(await req.arrayBuffer()))
				return Response.json({ status: 'success', topics: { tm_gib: [] } })
			}
			if (url.pathname === `${overlayPath}/lookup`) {
				const body = (await req.json()) as {
					service?: string
					query?: Record<string, unknown>
				}
				if (body.service !== 'ls_gib') {
					return new Response('unsupported service', { status: 400 })
				}
				const q = body.query ?? {}
				calls.push(`lookup:${String(q.type ?? 'heads')}`)
				if (q.type === 'headsSince') {
					return Response.json(answerHeadsSince(q))
				}
				if (q.type === 'txs') {
					const txids = (q.txids ?? []) as string[]
					if (txids.length === 0 || txids.length > 50) {
						return new Response('bad txids', { status: 400 })
					}
					return Response.json({
						type: 'freeform',
						result: JSON.stringify({
							query: 'txs',
							beef: base64(beefFor(txids)),
						}),
					})
				}
				return new Response('unknown query type', { status: 400 })
			}
			return new Response('not found', { status: 404 })
		},
	})

	port = server.port ?? 0
	return {
		url: `http://127.0.0.1:${port}`,
		host: `127.0.0.1:${port}`,
		heads: () => heads.map((h) => ({ ...h })),
		txids: () => [...txs.keys()],
		calls,
		stop: () => server.stop(true),
		setManifest: (on: boolean) => {
			manifest = on
		},
	}
}

function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64')
}
