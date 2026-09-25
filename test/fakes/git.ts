/** Small git helpers for tests: a scratch repository and commits in it. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export async function git(
	cwd: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<string> {
	const proc = Bun.spawn(['git', ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, ...gitEnv(), ...env },
	})
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	if (code !== 0) throw new Error(`git ${args.join(' ')}: ${err || out}`)
	return out.trim()
}

export function gitEnv(): Record<string, string> {
	return {
		GIT_AUTHOR_NAME: 't',
		GIT_AUTHOR_EMAIL: 't@t',
		GIT_COMMITTER_NAME: 't',
		GIT_COMMITTER_EMAIL: 't@t',
		GIT_AUTHOR_DATE: '2026-01-01T00:00:00+0000',
		GIT_COMMITTER_DATE: '2026-01-01T00:00:00+0000',
		GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_CONFIG_SYSTEM: '/dev/null',
	}
}

export async function tempRepo(
	files: Record<string, string>,
	branch = 'main',
): Promise<{ dir: string; gitDir: string; sha: string }> {
	const dir = await mkdtemp(join(tmpdir(), 'gib-repo-'))
	await git(dir, ['init', '-q', '-b', branch])
	const sha = await commitFiles(dir, files, 'init')
	return { dir, gitDir: join(dir, '.git'), sha }
}

export async function commitFiles(
	dir: string,
	files: Record<string, string>,
	message: string,
): Promise<string> {
	for (const [path, body] of Object.entries(files)) {
		const full = join(dir, path)
		await mkdir(dirname(full), { recursive: true })
		await writeFile(full, body)
	}
	await git(dir, ['add', '-A'])
	await git(dir, ['commit', '-q', '-m', message])
	return git(dir, ['rev-parse', 'HEAD'])
}

export async function removeFile(dir: string, path: string): Promise<void> {
	await rm(join(dir, path), { force: true })
}
