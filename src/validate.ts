import { treeShaFromCommit } from './gitread.ts'
import { formatOutpoint, type Outpoint } from './outpoint.ts'
import { collectTree, materializeGit } from './tree.ts'
import type { TxStore } from './txstore.ts'

export async function validateRoot(
	store: TxStore,
	root: Outpoint,
	commitBytes: Uint8Array,
	scratchGitDir: string,
): Promise<void> {
	const files = await collectTree(store, root)
	const got = await materializeGit(scratchGitDir, files, commitBytes)
	const expectTree = treeShaFromCommit(commitBytes)
	if (got.tree !== expectTree) {
		throw new Error(
			`validation: resolved tree ${got.tree} != commit tree ${expectTree} (root ${formatOutpoint(root)})`,
		)
	}
}
