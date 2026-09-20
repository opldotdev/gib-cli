/**
 * The wallet's identity key, cached beside the store.
 *
 * `list`, `fetch` and `clone` never need a wallet, but they do need to
 * know which heads are the user's own — those advertise as plain
 * refs/heads/<branch>, everyone else's as refs/heads/@<identity>/<branch>.
 * With no wallet and no cache, nothing is bare.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseIdentity } from './remote/url.ts'
import { defaultGibHome } from './txstore.ts'

const FILE = 'identity'

export async function loadIdentity(home?: string): Promise<string> {
	try {
		const raw = await readFile(join(home ?? defaultGibHome(), FILE), 'utf8')
		return parseIdentity(raw) ?? ''
	} catch {
		return ''
	}
}

export async function saveIdentity(
	identity: string,
	home?: string,
): Promise<void> {
	const id = parseIdentity(identity)
	if (!id) throw new Error(`not an identity key: ${identity}`)
	const dir = home ?? defaultGibHome()
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, FILE), `${id}\n`)
}
