/**
 * `git fetch` for gib: turning a published root back into git objects.
 *
 * A head points at one root, and that root carries the whole history: git's
 * tree for the tip commit, plus a `.git` store holding every commit object
 * reachable from that tip and every one of those commits' trees, each named
 * by its sha. So a fetch is one resolve, not a walk along a chain of heads.
 *
 * Names in the store are shas, which means git already having an object is
 * proof it needs nothing from that entry — an incremental fetch skips
 * everything it has and pulls only what is new.
 */

import { gitHash, writeGitObject } from './git.ts'
import { hasObject as gitHasObject, treeShaFromCommit } from './gitread.ts'
import { readHead } from './head.ts'
import { formatOutpoint, type Outpoint } from './outpoint.ts'
import type { Peer } from './remote/peer.ts'
import { ensureTxs, prefetchTree } from './remote/sync.ts'
import { resolveOutpoint } from './resolver.ts'
import {
	collectSnapshot,
	type DirChild,
	GIT_DIR,
	readDir,
	writeTree,
} from './tree.ts'
import type { TxStore } from './txstore.ts'

export type Imported = {
	/** The commit the root publishes. */
	tip: string
	/** Commit objects written into git by this fetch. */
	commits: number
	/** Ancestor trees written into git by this fetch. */
	trees: number
}

/** Parent shas from a raw git commit object. */
export function commitParents(commit: Uint8Array): string[] {
	const text = new TextDecoder().decode(commit)
	const header = text.split('\n\n', 1)[0] ?? ''
	return header
		.split('\n')
		.filter((l) => l.startsWith('parent '))
		.map((l) => l.slice(7).trim())
}

/** Import everything a head publishes. */
export async function importHead(
	store: TxStore,
	gitDir: string,
	headOutpoint: string,
	peer?: Peer,
): Promise<Imported> {
	const head = await readHead(store, headOutpoint)
	return importRoot(store, gitDir, head.root, peer)
}

/**
 * Import a published root: the tip's tree, every commit object in `.git`,
 * and every ancestor tree those commits need. git's own connectivity check
 * walks commit to tree to blob, so a history missing one ancestor tree is
 * a history git will refuse — all of it goes in.
 */
export async function importRoot(
	store: TxStore,
	gitDir: string,
	root: Outpoint,
	peer?: Peer,
): Promise<Imported> {
	await ensureTxs(store, peer, [root.txid])
	const entries = await readDir(store, root)
	const gitEntry = entries.find((e) => e.name === GIT_DIR && e.isDir)
	if (!gitEntry) {
		throw new Error(
			`published root ${formatOutpoint(root)} has no ${GIT_DIR} store`,
		)
	}
	await ensureTxs(store, peer, [gitEntry.outpoint.txid])
	const objects = await readDir(store, gitEntry.outpoint)

	const tipEntry = objects.find((e) => e.name === '.')
	if (!tipEntry) {
		throw new Error(`${GIT_DIR} names no tip commit (no "." entry)`)
	}
	const tipBytes = (await resolveOutpoint(store, tipEntry.outpoint)).bytes
	const tip = gitHash('commit', tipBytes)

	// One request for everything this fetch still needs, rather than one
	// per object: what git already has is skipped by name.
	const wanted: DirChild[] = []
	for (const o of objects) {
		if (o.name === '.') continue
		if (await gitHasGitObject(gitDir, o.name)) continue
		wanted.push(o)
	}
	await ensureTxs(store, peer, wanted.map((o) => o.outpoint.txid))

	const names = new Set(objects.map((o) => o.name))
	let commits = 0
	let trees = 0
	for (const o of wanted) {
		if (o.isDir) {
			await importTree(store, gitDir, o.name, o.outpoint, peer)
			trees++
			continue
		}
		const bytes = (await resolveOutpoint(store, o.outpoint)).bytes
		const got = gitHash('commit', bytes)
		if (got !== o.name) {
			throw new Error(`${GIT_DIR}/${o.name} is a commit that hashes to ${got}`)
		}
		await writeGitObject(gitDir, 'commit', bytes)
		commits++
	}

	// The tip's own tree is the root, minus the store.
	await prefetchTree(store, peer, root)
	const snapshot = await collectSnapshot(store, root)
	const files = snapshot.files.filter(
		(f) => f.path !== GIT_DIR && !f.path.startsWith(`${GIT_DIR}/`),
	)
	const tipTree = await writeTree(gitDir, files)
	const wantTree = treeShaFromCommit(tipBytes)
	if (tipTree !== wantTree) {
		throw new Error(
			`published root ${formatOutpoint(root)} resolves to tree ${tipTree}, not ${wantTree} (the commit's own)`,
		)
	}
	await writeGitObject(gitDir, 'commit', tipBytes)

	// Every commit git now has must have its tree, or git will reject the
	// history as incomplete. Say so here rather than leaving git to.
	for (const o of objects) {
		if (o.isDir || o.name === '.') continue
		const bytes = (await resolveOutpoint(store, o.outpoint)).bytes
		const need = treeShaFromCommit(bytes)
		if (need === tipTree || names.has(need)) continue
		if (await gitHasGitObject(gitDir, need)) continue
		throw new Error(
			`${GIT_DIR} has commit ${o.name} but not its tree ${need}: the history is incomplete`,
		)
	}
	return { tip, commits, trees }
}

/** Write one ancestor tree, checking it is the tree its name claims. */
async function importTree(
	store: TxStore,
	gitDir: string,
	sha: string,
	dir: Outpoint,
	peer?: Peer,
): Promise<void> {
	await prefetchTree(store, peer, dir)
	const files = (await collectSnapshot(store, dir)).files
	const got = await writeTree(gitDir, files)
	if (got !== sha) {
		throw new Error(`${GIT_DIR}/${sha} is a tree that materialises as ${got}`)
	}
}

async function gitHasGitObject(gitDir: string, sha: string): Promise<boolean> {
	if (!/^[0-9a-f]{40}$/.test(sha)) return false
	return gitHasObject(gitDir, sha, 'any')
}
