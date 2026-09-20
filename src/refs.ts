/**
 * What the client knows about a repository, on disk.
 *
 * There is no overlay here: no engine, no database, no chain tracker. The
 * client keeps the transactions it has been given in the store and, beside
 * them, this: the newest head it has seen for each (identity, branch) on a
 * repository origin, and where each branch's last refresh stopped. That is
 * enough to advertise refs, to resume a sync, and to know which head to
 * walk back from for a fetch.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultGibHome } from './txstore.ts'

/** The newest head seen for one publisher's branch. */
export type RefRecord = {
	identity: string
	branch: string
	/** Head outpoint, `txid_vout`. */
	head: string
	/** Commit sha the head publishes. */
	sha: string
	/** Root outpoint of the tree the head publishes. */
	root: string
}

export type RepoState = {
	origin: string
	/** The repository's first head: the one whose root is the origin. */
	genesis?: { identity: string; branch: string; head: string }
	/** Keyed `<identity>/<branch>`. */
	refs: Record<string, RefRecord>
	/** Where each branch's last refresh from the peer stopped. */
	cursors: Record<string, string>
	/** Branch names seen on this repository, including emptied ones. */
	branches: string[]
}

export function emptyRepoState(origin: string): RepoState {
	return { origin, refs: {}, cursors: {}, branches: [] }
}

export function refKey(identity: string, branch: string): string {
	return `${identity}/${branch}`
}

function statePath(origin: string, home?: string): string {
	return join(home ?? defaultGibHome(), 'repos', `${origin}.json`)
}

export async function loadRepoState(
	origin: string,
	home?: string,
): Promise<RepoState> {
	try {
		const raw = await readFile(statePath(origin, home), 'utf8')
		const parsed = JSON.parse(raw) as Partial<RepoState>
		return {
			origin,
			genesis: parsed.genesis,
			refs: parsed.refs ?? {},
			cursors: parsed.cursors ?? {},
			branches: parsed.branches ?? [],
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			return emptyRepoState(origin)
		}
		throw e
	}
}

export async function saveRepoState(
	state: RepoState,
	home?: string,
): Promise<void> {
	const path = statePath(state.origin, home)
	await mkdir(join(path, '..'), { recursive: true })
	const tmp = `${path}.${process.pid}.tmp`
	await writeFile(tmp, `${JSON.stringify(state, null, '\t')}\n`)
	await rename(tmp, path)
}

/** Record a head, keeping the newest one per publisher and branch. */
export function recordHead(
	state: RepoState,
	head: { identity: string; branch: string; head: string; sha: string; root: string },
): void {
	state.refs[refKey(head.identity, head.branch)] = { ...head }
	if (!state.branches.includes(head.branch)) state.branches.push(head.branch)
	if (!state.genesis && head.root === state.origin) {
		state.genesis = {
			identity: head.identity,
			branch: head.branch,
			head: head.head,
		}
	}
}

/** Forget a publisher's branch: its head was burned. */
export function forgetHead(
	state: RepoState,
	identity: string,
	branch: string,
): void {
	delete state.refs[refKey(identity, branch)]
}
