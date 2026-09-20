/**
 * A fake BRC-100 wallet, in memory and over HTTP.
 *
 * It derives keys with a ProtoWallet, funds every action from a fabricated
 * "mined" P2PKH coin, verifies the unlocking scripts it is handed, and
 * never touches a network: broadcast is recorded, not performed. It is
 * enough for createAction / signAction / abortAction / listOutputs /
 * listActions / getPublicKey / createSignature, which is everything gib
 * asks a wallet for.
 */

import {
	Beef,
	type CreateActionArgs,
	type CreateActionOutput,
	MerklePath,
	P2PKH,
	PrivateKey,
	ProtoWallet,
	Script,
	Spend,
	Transaction,
	UnlockingScript,
	type WalletInterface,
} from '@bsv/sdk'

type BasketOutput = {
	outpoint: string
	satoshis: number
	lockingScript: string
	customInstructions?: string
	tags: string[]
	spent: boolean
}

type Action = {
	txid?: string
	status: string
	description: string
	labels: string[]
	reference?: string
}

type Pending = { tx: Transaction; args: CreateActionArgs; action: number }

const FEE = 1000
const COIN = 500_000

export class FakeWallet {
	readonly proto: ProtoWallet
	readonly identityKey: string
	readonly calls: string[] = []
	private readonly fundKey = PrivateKey.fromRandom()
	private readonly txs = new Map<string, Transaction>()
	private readonly coins: Array<{ tx: Transaction; vout: number; spent: boolean }> = []
	private readonly outputs: BasketOutput[] = []
	private readonly actions: Action[] = []
	private readonly pending = new Map<string, Pending>()
	private refs = 0

	private constructor(proto: ProtoWallet, identityKey: string) {
		this.proto = proto
		this.identityKey = identityKey
	}

	static async create(key: PrivateKey): Promise<FakeWallet> {
		const proto = new ProtoWallet(key)
		const { publicKey } = await proto.getPublicKey({ identityKey: true })
		const w = new FakeWallet(proto, publicKey)
		w.fund(8)
		return w
	}

	/** Actions the wallet has been asked to build. */
	actionLog(): Action[] {
		return this.actions.map((a) => ({ ...a }))
	}

	private fund(n: number): void {
		const tx = new Transaction()
		const lock = new P2PKH().lock(this.fundKey.toPublicKey().toAddress())
		tx.addInput({
			sourceTXID: `${'0'.repeat(62)}${(this.txs.size + 1).toString().padStart(2, '0')}`,
			sourceOutputIndex: 0,
			unlockingScript: new UnlockingScript(),
			sequence: 0xffffffff,
		})
		for (let i = 0; i < n; i++) tx.addOutput({ satoshis: COIN, lockingScript: lock })
		tx.merklePath = new MerklePath(900_000, [
			[{ offset: 0, hash: tx.id('hex'), txid: true }],
		])
		this.txs.set(tx.id('hex'), tx)
		for (let i = 0; i < n; i++) this.coins.push({ tx, vout: i, spent: false })
	}

	private nextCoin() {
		const coin = this.coins.find((c) => !c.spent)
		if (!coin) throw new Error('fake wallet out of coins')
		return coin
	}

	private source(outpoint: string, inputBeef?: Beef): Transaction {
		const [txid] = outpoint.split(/[._]/)
		const own = this.txs.get(txid)
		if (own) return own
		const found = inputBeef?.findAtomicTransaction(txid) ?? inputBeef?.findTxid(txid)?.tx
		if (!found) throw new Error(`input ${outpoint}: source transaction unknown`)
		return found
	}

	async createAction(args: CreateActionArgs): Promise<Record<string, unknown>> {
		if (!args.description || args.description.length < 5 || args.description.length > 50) {
			throw new Error('description must be 5-50 chars')
		}
		if (args.options?.randomizeOutputs) {
			throw new Error('fake wallet does not randomize outputs')
		}
		const tx = new Transaction()
		const inputBeef = args.inputBEEF?.length
			? Beef.fromBinary(Array.from(args.inputBEEF))
			: undefined
		for (const input of args.inputs ?? []) {
			const src = this.source(input.outpoint, inputBeef)
			tx.addInput({
				sourceTransaction: src,
				sourceOutputIndex: Number(input.outpoint.split(/[._]/)[1]),
				unlockingScript: input.unlockingScript
					? Script.fromHex(input.unlockingScript)
					: new UnlockingScript(),
				sequence: 0xffffffff,
			})
		}
		const coin = this.nextCoin()
		tx.addInput({
			sourceTransaction: coin.tx,
			sourceOutputIndex: coin.vout,
			unlockingScriptTemplate: new P2PKH().unlock(this.fundKey),
			sequence: 0xffffffff,
		})
		for (const [i, o] of (args.outputs ?? []).entries()) {
			if (!o.outputDescription || o.outputDescription.length < 5 || o.outputDescription.length > 50) {
				throw new Error(`output ${i} description must be 5-50 chars`)
			}
			tx.addOutput({
				satoshis: o.satoshis,
				lockingScript: Script.fromHex(o.lockingScript),
			})
		}
		const spent = (args.outputs ?? []).reduce((n, o) => n + o.satoshis, 0)
		tx.addOutput({
			satoshis: COIN - FEE - spent,
			lockingScript: new P2PKH().lock(this.fundKey.toPublicKey().toAddress()),
		})
		coin.spent = true
		await tx.sign()

		if (args.options?.signAndProcess === false) {
			const reference = Buffer.from(`ref-${++this.refs}`).toString('base64')
			this.actions.push({
				status: 'unsigned',
				description: args.description,
				labels: args.labels ?? [],
				reference,
			})
			this.pending.set(reference, { tx, args, action: this.actions.length - 1 })
			return {
				signableTransaction: { tx: tx.toBEEF(true), reference },
			}
		}
		if ((args.inputs ?? []).length > 0) {
			throw new Error('external inputs need signAndProcess:false')
		}
		this.actions.push({
			status: 'unproven',
			description: args.description,
			labels: args.labels ?? [],
		})
		return this.finalize(tx, args, this.actions.length - 1)
	}

	async signAction(args: {
		reference: string
		spends: Record<string, { unlockingScript: string }>
	}): Promise<Record<string, unknown>> {
		const p = this.pending.get(args.reference)
		if (!p) throw new Error('unknown reference')
		for (const [index, spend] of Object.entries(args.spends ?? {})) {
			const i = Number(index)
			if (!Number.isInteger(i) || i < 0 || i >= p.tx.inputs.length) {
				throw new Error(`bad spend index ${index}`)
			}
			p.tx.inputs[i].unlockingScript = Script.fromHex(spend.unlockingScript)
		}
		this.pending.delete(args.reference)
		return this.finalize(p.tx, p.args, p.action)
	}

	async abortAction(args: { reference: string }): Promise<{ aborted: true }> {
		const p = this.pending.get(args.reference)
		if (p) {
			this.pending.delete(args.reference)
			this.actions[p.action].status = 'failed'
		}
		return { aborted: true }
	}

	private finalize(
		tx: Transaction,
		args: CreateActionArgs,
		action: number,
	): Record<string, unknown> {
		verifyScripts(tx)
		const txid = tx.id('hex')
		this.txs.set(txid, tx)
		for (const input of tx.inputs) {
			const src = input.sourceTXID ?? input.sourceTransaction?.id('hex')
			const op = `${src}.${input.sourceOutputIndex}`
			for (const o of this.outputs) if (o.outpoint === op) o.spent = true
		}
		for (const [i, o] of (args.outputs ?? []).entries()) {
			if (!o.basket) continue
			this.outputs.push({
				outpoint: `${txid}.${i}`,
				satoshis: o.satoshis,
				lockingScript: o.lockingScript,
				customInstructions: o.customInstructions,
				tags: o.tags ?? [],
				spent: false,
			})
		}
		this.coins.push({ tx, vout: tx.outputs.length - 1, spent: false })
		this.actions[action].txid = txid
		this.actions[action].status = 'unproven'
		return {
			txid,
			tx: tx.toAtomicBEEF(true),
			sendWithResults: [{ txid, status: 'unproven' }],
		}
	}

	async listOutputs(args: {
		basket?: string
		tags?: string[]
		tagQueryMode?: string
		include?: string
		includeTags?: boolean
		includeCustomInstructions?: boolean
		limit?: number
	}): Promise<Record<string, unknown>> {
		const limit = args.limit ?? 10
		const hits = this.outputs.filter(
			(o) => !o.spent && matchTags(o.tags, args.tags, args.tagQueryMode),
		)
		const page = hits.slice(0, limit)
		const beef = new Beef()
		for (const o of page) {
			if (args.include !== 'entire transactions') continue
			const tx = this.txs.get(o.outpoint.split('.')[0])
			if (tx) beef.mergeTransaction(tx)
		}
		return {
			totalOutputs: hits.length,
			BEEF: args.include === 'entire transactions' ? beef.toBinary() : undefined,
			outputs: page.map((o) => ({
				outpoint: o.outpoint,
				satoshis: o.satoshis,
				spendable: true,
				lockingScript:
					args.include === 'locking scripts' || args.include === 'entire transactions'
						? o.lockingScript
						: undefined,
				tags: args.includeTags ? o.tags : undefined,
				customInstructions: args.includeCustomInstructions
					? o.customInstructions
					: undefined,
			})),
		}
	}

	async listActions(args: {
		labels?: string[]
		labelQueryMode?: string
		limit?: number
	}): Promise<Record<string, unknown>> {
		const hits = this.actions.filter((a) =>
			matchTags(a.labels, args.labels, args.labelQueryMode),
		)
		return {
			totalActions: hits.length,
			actions: hits.slice(0, args.limit ?? 10),
		}
	}

	/** Serve the wallet over HTTP, the way a BRC-100 substrate expects. */
	listen(): { url: string; stop: () => void } {
		const server = Bun.serve({
			port: 0,
			fetch: async (req: Request): Promise<Response> => {
				const call = new URL(req.url).pathname.slice(1)
				this.calls.push(call)
				let body: Record<string, unknown> = {}
				try {
					body = (await req.json()) as Record<string, unknown>
				} catch {
					body = {}
				}
				try {
					const out = await this.dispatch(call, body)
					return Response.json(out ?? {})
				} catch (e) {
					return Response.json(
						{
							isError: true,
							status: 'error',
							code: 'WERR_FAKE',
							message: e instanceof Error ? e.message : String(e),
						},
						{ status: 400 },
					)
				}
			},
		})
		return {
			url: `http://127.0.0.1:${server.port}`,
			stop: () => server.stop(true),
		}
	}

	private async dispatch(
		call: string,
		body: Record<string, unknown>,
	): Promise<unknown> {
		const args = body as never
		switch (call) {
			case 'getPublicKey':
				return this.proto.getPublicKey(args)
			case 'createSignature':
				return this.proto.createSignature(args)
			case 'createAction':
				return this.createAction(args)
			case 'signAction':
				return this.signAction(args)
			case 'abortAction':
				return this.abortAction(args)
			case 'listOutputs':
				return this.listOutputs(args)
			case 'listActions':
				return this.listActions(args)
			default:
				throw new Error(`fake wallet: unsupported call ${call}`)
		}
	}

	/** The same wallet as a direct WalletInterface, with no HTTP in the way. */
	asWallet(): WalletInterface {
		const w: Partial<WalletInterface> = {
			getPublicKey: (a) => this.proto.getPublicKey(a as never),
			createSignature: (a) => this.proto.createSignature(a as never),
			createAction: (a) => this.createAction(a) as never,
			signAction: (a) => this.signAction(a as never) as never,
			abortAction: (a) => this.abortAction(a),
			listOutputs: (a) => this.listOutputs(a) as never,
			listActions: (a) => this.listActions(a) as never,
		}
		return w as WalletInterface
	}
}

function matchTags(have: string[], want?: string[], mode?: string): boolean {
	if (!want || want.length === 0) return true
	const set = new Set(have)
	const hits = want.filter((w) => set.has(w)).length
	return mode === 'all' ? hits === want.length : hits > 0
}

function verifyScripts(tx: Transaction): void {
	for (const [i, input] of tx.inputs.entries()) {
		const src = input.sourceTransaction?.outputs[input.sourceOutputIndex]
		if (!src) continue
		const spend = new Spend({
			sourceTXID: input.sourceTXID ?? input.sourceTransaction?.id('hex') ?? '',
			sourceOutputIndex: input.sourceOutputIndex,
			lockingScript: src.lockingScript,
			sourceSatoshis: src.satoshis ?? 0,
			transactionVersion: tx.version,
			otherInputs: tx.inputs.filter((_, j) => j !== i),
			unlockingScript: input.unlockingScript ?? new UnlockingScript(),
			inputSequence: input.sequence ?? 0xffffffff,
			inputIndex: i,
			outputs: tx.outputs,
			lockTime: tx.lockTime,
		})
		if (!spend.validate()) {
			throw new Error(`script verification failed for input ${i}`)
		}
	}
}

export type { CreateActionOutput }
