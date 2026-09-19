/**
 * `.gib` — repository metadata, a committed dotfile at the tree root.
 *
 *   { "name": "my-repo", "description": "…", "defaultBranch": "main" }
 *
 * gib itself never needs it: the origin outpoint is the repository's
 * identity. The file gives humans and indexers (gibhub, the overlay) a
 * display name and tells clones which branch HEAD should point at.
 * `gib init` writes it; it travels with the tree like any other file.
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
