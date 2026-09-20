/**
 * Naming refs for git.
 *
 * Heads signed by this wallet's identity advertise as plain
 * `refs/heads/<branch>`; every other publisher's as
 * `refs/heads/@<identity>/<branch>`. With no wallet and no cached
 * identity, nothing is bare — a reader sees every branch attributed.
 *
 * The refs come from what the store holds, not from the wallet's basket: a
 * repository is not "the coins I own", it is the heads on a repository
 * origin, whoever published them.
 */

import { parseIdentity } from './url.ts'
import type { RepoState } from '../refs.ts'

export type Ref = {
	sha: string
	name: string
	/** Who published the head this ref names. */
	identity: string
	branch: string
	head: string
}

export function refName(publisher: string, branch: string, me: string): string {
	if (me && publisher === me) return `refs/heads/${branch}`
	return `refs/heads/@${publisher}/${branch}`
}

/**
 * The (publisher, branch) an advertised ref names. A bare
 * `refs/heads/<branch>` is the user's own.
 */
export function splitRef(
	ref: string,
	me: string,
): { publisher: string; branch: string } {
	const name = ref.replace(/^refs\/heads\//, '')
	if (!name || name === ref) {
		throw new Error(
			`bad ref ${ref}: gib serves refs/heads/<branch> and refs/heads/@<identity>/<branch>`,
		)
	}
	if (!name.startsWith('@')) return { publisher: me, branch: name }
	const slash = name.indexOf('/')
	if (slash < 0 || slash === name.length - 1) {
		throw new Error(`bad ref ${ref}: want refs/heads/@<identity>/<branch>`)
	}
	const id = parseIdentity(name.slice(1, slash))
	if (!id) throw new Error(`bad ref ${ref}: not an identity key`)
	return { publisher: id, branch: name.slice(slash + 1) }
}

/** Every current head on the repository, named relative to `me`. */
export function advertise(state: RepoState, me: string): Ref[] {
	return Object.values(state.refs)
		.map((r) => ({
			sha: r.sha,
			name: refName(r.identity, r.branch, me),
			identity: r.identity,
			branch: r.branch,
			head: r.head,
		}))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * The HEAD symref: the branch the repository was created on — the genesis
 * head's, the earliest head on the repository origin — then main, master,
 * and finally the first ref. For that branch the user's own ref wins over
 * a publisher-prefixed one, and the repository owner's over a stranger's.
 */
export function chooseHead(
	refs: Ref[],
	state: RepoState,
	me: string,
): string | undefined {
	if (refs.length === 0) return undefined
	const owner = state.genesis?.identity ?? ''
	const pick = (branch: string): string | undefined => {
		if (!branch) return undefined
		let ownerRef: string | undefined
		let anyRef: string | undefined
		for (const r of refs) {
			if (r.branch !== branch) continue
			if (me && r.identity === me) return r.name
			if (owner && r.identity === owner && !ownerRef) ownerRef = r.name
			if (!anyRef) anyRef = r.name
		}
		return ownerRef ?? anyRef
	}
	for (const branch of [state.genesis?.branch ?? '', 'main', 'master']) {
		const name = pick(branch)
		if (name) return name
	}
	return refs[0].name
}
