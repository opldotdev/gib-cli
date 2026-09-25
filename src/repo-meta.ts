/**
 * `.gib` — repository metadata, a committed dotfile at the tree root.
 *
 *   { "name": "my-repo", "description": "…", "defaultBranch": "main" }
 *
 * gib itself never needs it: the repository origin is the repository's
 * identity, and the branch a repository was created on is the genesis
 * head's. The file gives humans and indexers (gibhub, the overlay) a
 * display name.
 *
 * `defaultBranch` is still written for one reason: no lookup enumerates a
 * repository's branches, so a clone that has never heard of this
 * repository has nothing else to ask a peer for. It goes when that query
 * exists.
 *
 * The file may later carry publishing hints — how deep a patch chain to
 * allow before writing a file whole, how many outputs to put in one
 * transaction, how large a stream to publish at once. They would be
 * hints a client MAY honour and nothing more: a reader cannot check them,
 * a publisher cannot be made to follow them, and every one of them is a
 * preference about cost, not a rule about format. None is implemented;
 * the client uses its own defaults and would go on doing so.
 */

export const GIB_FILE = '.gib'

export type RepoMeta = {
	name?: string
	description?: string
	defaultBranch?: string
}

const BRANCH_RE = /^[^\s~^:?*[\\]+$/

export function parseRepoMeta(text: string): RepoMeta {
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch (e) {
		throw new Error(`${GIB_FILE}: invalid JSON (${e instanceof Error ? e.message : e})`)
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new Error(`${GIB_FILE}: must be a JSON object`)
	}
	const o = raw as Record<string, unknown>
	const meta: RepoMeta = {}
	for (const key of ['name', 'description', 'defaultBranch'] as const) {
		const v = o[key]
		if (v === undefined) continue
		if (typeof v !== 'string') throw new Error(`${GIB_FILE}: ${key} must be a string`)
		meta[key] = v
	}
	if (meta.defaultBranch !== undefined && !BRANCH_RE.test(meta.defaultBranch)) {
		throw new Error(`${GIB_FILE}: defaultBranch is not a valid branch name`)
	}
	return meta
}

export function formatRepoMeta(meta: RepoMeta): string {
	const out: RepoMeta = {}
	if (meta.name) out.name = meta.name
	if (meta.description) out.description = meta.description
	if (meta.defaultBranch) out.defaultBranch = meta.defaultBranch
	return `${JSON.stringify(out, null, 2)}\n`
}
