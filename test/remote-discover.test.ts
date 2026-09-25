import { afterAll, describe, expect, it } from 'bun:test'
import {
	DEFAULT_OVERLAY_PATH,
	clearDiscoveryCache,
	resolveEndpoints,
} from '../src/remote/discover.ts'
import { parseGibUrl } from '../src/remote/url.ts'

const origin = `${'a'.repeat(64)}_0`

function serve(handler: (req: Request) => Response | Promise<Response>) {
	return Bun.serve({ port: 0, fetch: handler })
}

const servers: Array<{ stop: () => void }> = []
afterAll(() => {
	for (const s of servers) s.stop()
})

describe('BRC-180 overlay discovery', () => {
	it('reads tm_gib and ls_gib from metanet.overlays and uses them verbatim', async () => {
		const s = serve((req) =>
			new URL(req.url).pathname === '/manifest.json'
				? Response.json({
						name: 'demo',
						metanet: {
							overlays: {
								tm_gib: 'https://api.example.com/1sat/gib/overlay/',
								ls_gib: 'https://lookup.example.com/gib',
								tm_other: 'https://other.example.net',
							},
						},
					})
				: new Response('no', { status: 404 }),
		)
		servers.push(s)
		clearDiscoveryCache()
		const e = await resolveEndpoints(
			parseGibUrl(`gib://127.0.0.1:${s.port}/${origin}`),
			{ noCache: true },
		)
		expect(e).toEqual({
			submit: 'https://api.example.com/1sat/gib/overlay',
			lookup: 'https://lookup.example.com/gib',
		})
	})

	it('falls back to the named host when there is no manifest', async () => {
		const s = serve(() => new Response('nope', { status: 404 }))
		servers.push(s)
		const e = await resolveEndpoints(
			parseGibUrl(`gib://127.0.0.1:${s.port}/${origin}`),
			{ noCache: true },
		)
		expect(e.lookup).toBe(`http://127.0.0.1:${s.port}${DEFAULT_OVERLAY_PATH}`)
		expect(e.submit).toBe(e.lookup)
	})

	it('falls back per service when the manifest declares neither, or junk', async () => {
		const s = serve(() =>
			Response.json({ metanet: { overlays: { ls_gib: 'ftp://nope' } } }),
		)
		servers.push(s)
		const e = await resolveEndpoints(
			parseGibUrl(`gib://127.0.0.1:${s.port}/${origin}`),
			{ noCache: true },
		)
		expect(e.lookup).toBe(`http://127.0.0.1:${s.port}${DEFAULT_OVERLAY_PATH}`)
	})

	it('caches one answer per host', async () => {
		let hits = 0
		const s = serve(() => {
			hits++
			return Response.json({
				metanet: { overlays: { ls_gib: 'https://x.example/lookup' } },
			})
		})
		servers.push(s)
		clearDiscoveryCache()
		const url = parseGibUrl(`gib://127.0.0.1:${s.port}/${origin}`)
		await resolveEndpoints(url)
		await resolveEndpoints(url)
		expect(hits).toBe(1)
		clearDiscoveryCache()
	})

	it('resolves nothing for a local-only URL', async () => {
		expect(await resolveEndpoints(parseGibUrl(`gib://${origin}`))).toEqual({
			submit: '',
			lookup: '',
		})
	})
})
