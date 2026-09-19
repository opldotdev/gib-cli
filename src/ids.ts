import type { CreateActionArgs } from '@bsv/sdk'
import { Utils } from '@bsv/sdk'

export function randomActionId(): string {
	const bytes = new Uint8Array(8)
	crypto.getRandomValues(bytes)
	return Utils.toHex(Array.from(bytes))
}

export function stampManagedOutputIds(args: CreateActionArgs): string {
	const existing = actionIdFromOutputTags(args)
	const actionId = existing ?? randomActionId()
	if (args.outputs) {
		for (const [i, output] of args.outputs.entries()) {
			if (!output.basket) continue
			const tag = `id:${actionId}_${i}`
			const tags = (output.tags ?? []).filter((t) => !t.startsWith('id:'))
			output.tags = [...tags, tag]
		}
	}
	return actionId
}

export function idTagFromTags(tags: string[] | undefined): string | undefined {
	return tags?.find((t) => t.startsWith('id:'))
}

function actionIdFromOutputTags(args: CreateActionArgs): string | undefined {
	const ids = new Set<string>()
	for (const output of args.outputs ?? []) {
		for (const tag of output.tags ?? []) {
			if (!tag.startsWith('id:')) continue
			const rest = tag.slice(3)
			const us = rest.lastIndexOf('_')
			if (us <= 0) continue
			const id = rest.slice(0, us)
			const index = rest.slice(us + 1)
			if (id && /^\d+$/.test(index)) ids.add(id)
		}
	}
	if (ids.size === 0) return undefined
	if (ids.size > 1) {
		throw new Error(`outputs carry more than one action id (${[...ids].join(', ')})`)
	}
	return [...ids][0]
}
