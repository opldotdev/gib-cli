import { LockingScript, OP, Script, Utils } from '@bsv/sdk'

export const B_PREFIX = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'

export type Payload = {
	contentType: string
	bytes: Uint8Array
}

export function payloadFromScript(
	script: LockingScript | Script,
): Payload | undefined {
	return decodeOrd(script) ?? decodeB(script)
}

function decodeOrd(script: Script): Payload | undefined {
	const chunks = script.chunks
	for (let i = 0; i < chunks.length - 2; i++) {
		const a = chunks[i]
		const b = chunks[i + 1]
		const c = chunks[i + 2]
		if (
			a?.op !== OP.OP_0 ||
			b?.op !== OP.OP_IF ||
			c?.data == null ||
			c.data.length !== 3 ||
			Utils.toUTF8(c.data) !== 'ord'
		) {
			continue
		}
		let pos = i + 3
		let contentType = ''
		let content = new Uint8Array(0)
		while (pos < chunks.length) {
			if (chunks[pos].op === OP.OP_ENDIF) break
			const key = chunks[pos]
			let fieldNum: number | undefined
			if (key.op === OP.OP_0) fieldNum = 0
			else if (
				key.op !== undefined &&
				key.op > OP.OP_PUSHDATA4 &&
				key.op <= OP.OP_16
			) {
				fieldNum = key.op - 80
			} else if (key.data != null && key.data.length === 1) {
				fieldNum = key.data[0]
			}
			pos++
			if (pos >= chunks.length) break
			const data =
				chunks[pos]?.data != null
					? new Uint8Array(chunks[pos].data)
					: new Uint8Array(0)
			pos++
			if (fieldNum === 0) content = data
			else if (fieldNum === 1) {
				try {
					contentType = Utils.toUTF8(Array.from(data))
				} catch {
					contentType = ''
				}
			}
		}
		if (content.length === 0) return undefined
		return { contentType, bytes: content }
	}
	return undefined
}

function decodeB(script: Script): Payload | undefined {
	const chunks = script.chunks
	let i = 0
	if (chunks[0]?.op === OP.OP_FALSE || chunks[0]?.op === OP.OP_0) i++
	if (chunks[i]?.op !== OP.OP_RETURN) return undefined
	const ret = chunks[i]
	let rest = chunks.slice(i + 1)
	if (ret.data?.length && rest.length === 0) {
		rest = Script.fromBinary(Array.from(ret.data)).chunks
	}
	const prefix = rest[0]?.data
	if (!prefix || Utils.toUTF8(prefix) !== B_PREFIX) return undefined
	const data = rest[1]?.data
	const type = rest[2]?.data
	if (!data || !type) return undefined
	return {
		contentType: Utils.toUTF8(type),
		bytes: new Uint8Array(data),
	}
}
