import { pushDropDecode } from '@1sat/actions'
import { LockingScript, Utils } from '@bsv/sdk'

export const GIB_PROTOCOL: [0 | 1 | 2, string] = [1, 'gib branch']
export const GIB_BASKET = 'gib'
export const GIB_FIELD0 = 'gib'

export type CommitToken = {
	origin: string
	branch: string
	/** Outpoint of the published root directory this head points at. */
	root: string
	identityPubkey: string
	/**
	 * The head this one branched from, or merged in: empty on an ordinary
	 * push, which has only the head it spends.
	 *
	 * A head's parents mirror its commit's parents by construction. The
	 * spend is the first parent's lineage; this field is the other one —
	 * set on a branch's first head (naming the head it forked from) and on
	 * a merge (naming a head publishing the second parent).
	 */
	branchedFrom: string
}

/**
 * Fields on the wire, in order. The signature pushDropLock appends makes
 * the seventh.
 */
export const COMMIT_TOKEN_FIELDS = 6

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

/** What git calls a deleted ref. */
export const NULL_SHA = '0'.repeat(40)

export function commitTag(sha: string): string {
	return `commit:${sha}`
}

/** Action description carrying the sha, ≤50 chars as BRC-100 requires. */
export function pushDescription(kind: 'content' | 'head', sha: string): string {
	return `gib ${kind} ${sha}`.slice(0, 50)
}

/**
 * An absent field is an empty push, which PushDrop encodes minimally as
 * OP_FALSE — the same opcode a single zero byte encodes to, so the two
 * cannot be told apart once on chain. Both read back as absent.
 */
function optional(field: number[] | undefined): string {
	if (!field || field.length === 0) return ''
	if (field.length === 1 && field[0] === 0) return ''
	return Utils.toUTF8(field)
}

/**
 * Decode a gib commit head.
 *
 * A head is a bare PushDrop: six fields plus the signature, and nothing
 * else on the output. The five-field heads with a commit inscription that
 * gib published before this are a different format and do not decode here;
 * that is deliberate, and there is no compatibility path.
 */
export function decodeCommitToken(lockingScript: LockingScript | string): CommitToken {
	const script =
		typeof lockingScript === 'string'
			? LockingScript.fromHex(lockingScript)
			: lockingScript
	const { fields } = pushDropDecode(script)
	if (fields.length !== COMMIT_TOKEN_FIELDS + 1) {
		throw new Error(
			`not a gib commit head: ${fields.length} fields, want ${COMMIT_TOKEN_FIELDS} and a signature`,
		)
	}
	const str = (i: number) => {
		const f = fields[i]
		if (!f) throw new Error(`commit head missing field ${i}`)
		return Utils.toUTF8(f)
	}
	if (str(0) !== GIB_FIELD0) {
		throw new Error(`not a gib commit head (field0=${str(0)})`)
	}
	return {
		origin: str(1),
		branch: str(2),
		root: str(3),
		identityPubkey: str(4),
		branchedFrom: optional(fields[5]),
	}
}

export function commitTokenFields(t: CommitToken): number[][] {
	return [
		Utils.toArray(GIB_FIELD0, 'utf8'),
		Utils.toArray(t.origin, 'utf8'),
		Utils.toArray(t.branch, 'utf8'),
		Utils.toArray(t.root, 'utf8'),
		Utils.toArray(t.identityPubkey, 'utf8'),
		t.branchedFrom ? Utils.toArray(t.branchedFrom, 'utf8') : [],
	]
}
