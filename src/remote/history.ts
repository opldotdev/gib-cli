/**
 * Fetching history: a branch's commits live one per head, and each head
 * spends the previous one. Walking that spend chain backwards from the tip
 * and importing every commit until git already has the parents is how a
 * clone or pull gets a complete history without replaying anything.
 *
 * Parents on other branches (merges) are not on this chain; they are found
 * when that branch is fetched. A parent that no reachable head carries
 * stays missing and git reports it.
 */

import { previousHead } from '../head.ts'
import type { TxStore } from '../txstore.ts'
import { importCommit } from './helper.ts'

/** Parent shas from a raw git commit object. */
export function commitParents(commit: Uint8Array): string[] {
	const text = new TextDecoder().decode(commit)
	const header = text.split('\n\n', 1)[0] ?? ''
	return header
		.split('\n')
		.filter((l) => l.startsWith('parent '))
		.map((l) => l.slice(7).trim())
}

export { previousHead }

export async function gitHasObject(gitDir: string, sha: string): Promise<boolean> {
	const proc = Bun.spawn(['git', '--git-dir', gitDir, 'cat-file', '-e', sha], {
		stdout: 'pipe',
		stderr: 'pipe',
	})
	return (await proc.exited) === 0
}

/**
 * Imports the tip head's commit and walks back through previous heads
 * until every parent of the last imported commit already exists in git.
 * Returns the imported commit shas, tip first.
 */
export async function importHistory(
	store: TxStore,
	gitDir: string,
	tipOutpoint: string,
	opts: { hasObject?: (sha: string) => Promise<boolean>; maxDepth?: number } = {},
): Promise<string[]> {
	const hasObject = opts.hasObject ?? ((sha: string) => gitHasObject(gitDir, sha))
	const maxDepth = opts.maxDepth ?? 100_000
	const imported: string[] = []
	const seen = new Set<string>()
	let head: string | undefined = tipOutpoint
	while (head && !seen.has(head) && imported.length < maxDepth) {
		seen.add(head)
		const r = await importCommit(store, gitDir, head)
		imported.push(r.commit)
		let missing = false
		for (const p of r.parents) {
			if (!(await hasObject(p))) {
				missing = true
				break
			}
		}
		if (!missing) break
		head = await previousHead(store, head)
	}
	return imported
}
