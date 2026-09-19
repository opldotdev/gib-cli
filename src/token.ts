import { pushDropDecode } from '@1sat/actions'
import { LockingScript, OP, Script, Utils } from '@bsv/sdk'

export const GIB_PROTOCOL: [0 | 1 | 2, string] = [1, 'gib branch']
export const GIB_BASKET = 'gib'
export const GIB_FIELD0 = 'gib'

export type CommitToken = {
	origin: string
	branch: string
	root: string
	identityPubkey: string
}

export function gibKeyId(rootOutpoint: string): string {
	return rootOutpoint
}

export function originTag(origin: string): string {
	return `origin:${origin}`
}

export function branchTag(branch: string): string {
	return `branch:${branch}`
}

/**
 * Action labels are a fixed vocabulary: BRC-100 wallets gate each distinct
 * label string as its own permission (`action label <label>`), so a
 * per-commit label would prompt on every push. The commit sha goes in a
 * tag on the head output (basketed, so tags exist) and in the description.
 */
export const LABEL_PUSH = 'gib push'
export const LABEL_DELETE = 'gib delete'

export function commitTag(sha: string): string {
	return `commit:${sha}`
}

/** Action description carrying the sha, ≤50 chars as BRC-100 requires. */
export function pushDescription(kind: 'content' | 'head', sha: string): string {
	return `gib ${kind} ${sha}`.slice(0, 50)
}

function prefixBeforeOrd(script: Script): Script {
	const chunks = script.chunks
	for (let i = 0; i < chunks.length - 2; i++) {
		const marker = chunks[i + 2]
		if (
			chunks[i]?.op === OP.OP_0 &&
			chunks[i + 1]?.op === OP.OP_IF &&
			marker?.data != null &&
			marker.data.length === 3 &&
			Utils.toUTF8(marker.data) === 'ord'
		) {
			const p = new Script()
			for (let j = 0; j < i; j++) p.chunks.push(chunks[j])
			return p
		}
	}
	return script
}

export function decodeCommitToken(lockingScript: LockingScript | string): CommitToken {
	const script =
		typeof lockingScript === 'string'
			? LockingScript.fromHex(lockingScript)
			: lockingScript
	const { fields } = pushDropDecode(prefixBeforeOrd(script))
	const str = (i: number) => {
		const f = fields[i]
		if (!f) throw new Error(`commit token missing field ${i}`)
		return Utils.toUTF8(f)
	}
	if (str(0) !== GIB_FIELD0) {
		throw new Error(`not a gib commit token (field0=${str(0)})`)
	}
	return {
		origin: str(1),
		branch: str(2),
		root: str(3),
		identityPubkey: str(4),
	}
}

export function commitTokenFields(t: CommitToken): number[][] {
	return [
		Utils.toArray(GIB_FIELD0, 'utf8'),
		Utils.toArray(t.origin, 'utf8'),
		Utils.toArray(t.branch, 'utf8'),
		Utils.toArray(t.root, 'utf8'),
		Utils.toArray(t.identityPubkey, 'utf8'),
	]
}
