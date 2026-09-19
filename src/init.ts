/**
 * `gib init` — write `.gib` and point a remote at `gib://new`.
 *
 * Runs `git init` first when the directory is not a repository yet, so a
 * gib-first user needs one command. Touches nothing on chain: the first
 * `git push` mints the repository and the helper rewrites the remote URL to
 * the real `gib://<origin>`.
 */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { formatRepoMeta, GIB_FILE, parseRepoMeta, type RepoMeta } from './repo-meta.ts'

export const NEW_REMOTE_URL = 'gib://new'

export type InitOptions = {
	cwd: string
	name?: string
	description?: string
	defaultBranch?: string
	/** Remote to create or check; defaults to `origin`. */
	remote?: string
	/** Overwrite an existing `.gib`. */
	force?: boolean
	/** Called with computed defaults when interactive; returns final values. */
	prompt?: (defaults: Required<Pick<RepoMeta, 'name' | 'defaultBranch'>> & RepoMeta) => Promise<RepoMeta>
}

export type InitResult = {
	root: string
	file: string
	meta: RepoMeta
	remote: string
	remoteUrl: string
	remoteAction: 'added' | 'unchanged'
	/** True when `gib init` ran `git init` for this directory. */
	gitInitialized: boolean
}

async function git(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	return { code, out: out.trim(), err: err.trim() }
}

/** Current branch name, or `main` when HEAD is unborn/detached. */
export async function currentBranch(cwd: string): Promise<string> {
	const r = await git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
	return r.code === 0 && r.out ? r.out : 'main'
}

export async function gibInit(opts: InitOptions): Promise<InitResult> {
	let gitInitialized = false
	let top = await git(opts.cwd, ['rev-parse', '--show-toplevel'])
	if (top.code !== 0) {
		const branch = opts.defaultBranch ?? 'main'
		const init = await git(opts.cwd, ['init', '-q', '-b', branch])
		if (init.code !== 0) throw new Error(`git init: ${init.err}`)
		gitInitialized = true
		top = await git(opts.cwd, ['rev-parse', '--show-toplevel'])
		if (top.code !== 0) throw new Error(`git init succeeded but the repository is unreadable: ${top.err}`)
	}
	const root = resolve(top.out)
	const file = join(root, GIB_FILE)
	const remote = opts.remote ?? 'origin'

	let existing: RepoMeta = {}
	if (existsSync(file)) {
		if (!opts.force) {
			throw new Error(`${GIB_FILE} already exists (use --force to overwrite)`)
		}
		existing = parseRepoMeta(await readFile(file, 'utf8'))
	}

	const defaults = {
		name: opts.name ?? existing.name ?? basename(root),
		description: opts.description ?? existing.description,
		defaultBranch: opts.defaultBranch ?? existing.defaultBranch ?? (await currentBranch(root)),
	}
	const chosen = opts.prompt ? await opts.prompt(defaults) : defaults
	const meta: RepoMeta = {
		name: (chosen.name ?? defaults.name).trim() || defaults.name,
		description: chosen.description?.trim() || undefined,
		defaultBranch: (chosen.defaultBranch ?? defaults.defaultBranch).trim() || defaults.defaultBranch,
	}
	// Round-trip through the parser so a bad branch name fails here, not at push.
	parseRepoMeta(formatRepoMeta(meta))
	await writeFile(file, formatRepoMeta(meta))

	const url = await git(root, ['remote', 'get-url', remote])
	let remoteAction: InitResult['remoteAction']
	let remoteUrl: string
	if (url.code !== 0) {
		const add = await git(root, ['remote', 'add', remote, NEW_REMOTE_URL])
		if (add.code !== 0) throw new Error(`git remote add ${remote}: ${add.err}`)
		remoteAction = 'added'
		remoteUrl = NEW_REMOTE_URL
	} else if (url.out.startsWith('gib://')) {
		remoteAction = 'unchanged'
		remoteUrl = url.out
	} else {
		throw new Error(
			`remote '${remote}' already points at ${url.out}; pick another name with --remote <name>`,
		)
	}
	return { root, file, meta, remote, remoteUrl, remoteAction, gitInitialized }
}
