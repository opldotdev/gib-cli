/**
 * gib commands: init / clone / commit / push.
 *
 * Model (see docs/plans/gib-*.html):
 *   - content resolution is ORDFS + outpoint walk (no local object store)
 *   - a branch is a 1-sat push-drop coin naming the current root
 *   - commit = publish the new tree (genesis-style batch for now; per-file
 *     diff records land next) and remember the new root locally
 *   - push = spend the branch coin, recreate it naming the new root
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Transaction, PushDrop } from '@bsv/sdk'
import { deployOrdfsDir } from '@1sat/actions'
import { collectDir } from './directory.ts'
import { connectWallet, createContextForWallet } from './wallet.ts'
import { childOutpoint, fetchManifest, fetchText, fetchTree, ORDFS_BASE, splitOutpoint } from './ordfs.ts'
import { GibState } from './state.ts'
import { GIB_BASKET, GIB_PROTOCOL, branchLockScript, branchTokenCi, decodeBranchToken, gibKeyId } from './token.ts'

// ---------------------------------------------------------------- helpers

function sha(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex')
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

// ---------------------------------------------------------------- init

async function cmdInit(argv: string[]) {
  const dir = argv[0] ?? '.'
  const state = new GibState(dir)
  if (state.head) {
    console.error(`init: ${dir} is already a gib repo (HEAD=${state.head})`)
    process.exit(1)
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`init: no such directory: ${dir}`)
    process.exit(1)
  }
  state.ensure()
  console.log(`initialized empty gib repo in ${dir}`)
  console.log('next: gib publish <dir> to create the genesis root')
}

// ---------------------------------------------------------------- publish
// genesis batch — the tree, all B outputs, OP_FALSE-fixed SDK.

async function cmdPublish(argv: string[]) {
  const dir = argv[0] ?? '.'
  const writeMode = (argValue(argv, '--write-mode') ?? 'b') as 'b' | 'mixed'
  const state = new GibState(dir)
  if (state.head) {
    console.error(
      `publish: ${dir} already has a root (${state.head}).\n` +
        'genesis publish is once per repo; use `gib commit` for updates.',
    )
    process.exit(1)
  }
  const files = collectDir(dir)
  if (!files.length) {
    console.error(`publish: no publishable files under ${dir}`)
    process.exit(1)
  }
  console.log(`publish ${dir} → ${files.length} files (writeMode: ${writeMode})`)

  const wallet = connectWallet()
  const ctx = createContextForWallet(wallet)
  const result = await deployOrdfsDir.execute(ctx, { files, writeMode, sign: false })
  if (result.error) {
    console.error(`publish failed: ${result.error}`)
    process.exit(1)
  }
  const root = `${result.txid}_${result.manifestVout}`
  state.setHead(root)
  // record bases: every file's leaf outpoint, by walking what we just built
  const bases = await basesFromRoot(root)
  state.setBases(bases)
  console.log(`txid:   ${result.txid}`)
  console.log(`https://bananablocks.com/tx/${result.txid}`)
  console.log(`root:   ${root}`)
}

/** Walk a published root, mapping each file path to its leaf outpoint. */
async function basesFromRoot(root: string): Promise<Record<string, string>> {
  const bases: Record<string, string> = {}
  const walk = async (op: string, prefix: string) => {
    const dir = await fetchManifest(op)
    for (const [name, ptr] of Object.entries(dir)) {
      const child = childOutpoint(op, ptr)
      const { text } = await fetchText(`${ORDFS_BASE}/${child}?raw=1`)
      if (looksLikeManifest(text)) {
        await walk(child, `${prefix}${name}/`)
      } else {
        bases[`${prefix}${name}`] = child
      }
    }
  }
  await walk(root, '')
  return bases
}

function looksLikeManifest(text: string): boolean {
  try {
    const p = JSON.parse(text)
    return (
      typeof p === 'object' && p !== null && !Array.isArray(p) &&
      Object.values(p).every((v) => typeof v === 'string' && v.startsWith('_'))
    )
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- clone

async function cmdClone(argv: string[]) {
  const root = argv[0]
  const dest = argv[1]
  if (!root) {
    console.error('usage: gib clone <root-outpoint> [dir]')
    process.exit(1)
  }
  splitOutpoint(root) // validate shape early
  const target = dest ?? root.slice(0, 8)
  if (existsSync(target)) {
    console.error(`clone: ${target} already exists`)
    process.exit(1)
  }
  console.log(`cloning ${root} → ${target}`)
  const tree = await fetchTree(root)
  for (const { path, bytes } of tree) {
    const abs = join(target, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, bytes)
  }
  const state = new GibState(target)
  state.ensure()
  state.setHead(root)
  state.setBases(await basesFromRoot(root))
  console.log(`cloned ${tree.length} files`)
}

// ---------------------------------------------------------------- commit
// V1 commit = republish the whole tree as a new genesis-style batch and
// move local HEAD. Per-file diff records (the binary envelope) replace this
// next; the command surface stays identical.

async function cmdCommit(argv: string[]) {
  const dir = argv[0] ?? '.'
  const state = new GibState(dir)
  const head = state.head
  if (!head) {
    console.error('commit: no HEAD — run `gib publish` first (or `gib clone`)')
    process.exit(1)
  }
  const files = collectDir(dir)
  if (!files.length) {
    console.error('commit: nothing to publish')
    process.exit(1)
  }
  console.log(`commit ${dir} → ${files.length} files (full republish, v1)`)
  const wallet = connectWallet()
  const ctx = createContextForWallet(wallet)
  const result = await deployOrdfsDir.execute(ctx, { files, writeMode: 'b', sign: false })
  if (result.error) {
    console.error(`commit failed: ${result.error}`)
    process.exit(1)
  }
  const root = `${result.txid}_${result.manifestVout}`
  state.setHead(root)
  state.setBases(await basesFromRoot(root))
  console.log(`txid:   ${result.txid}`)
  console.log(`https://bananablocks.com/tx/${result.txid}`)
  console.log(`new root: ${root}  (HEAD moved; not yet pushed)`)
}

// ---------------------------------------------------------------- push
// Spend the branch coin (if any) and recreate it naming HEAD. First push
// mints the coin. The push-drop spend itself is the authorization.
//
// Flow follows @1sat/actions completeSignedAction: createAction returns a
// SIGNABLE tx (nothing is on the network yet) — we build the token's PushDrop
// unlock locally, then signAction({reference, spends}) is where the wallet
// signs funding inputs and broadcasts.

async function cmdPush(argv: string[]) {
  const dir = argv[0] ?? '.'
  const state = new GibState(dir)
  const head = state.head
  if (!head) {
    console.error('push: no HEAD — commit first')
    process.exit(1)
  }
  const wallet = connectWallet()
  const branch = state.branch
  const keyID = branch?.keyID ?? gibKeyId(head) // lineage anchored on first push root

  // Current coin, if we've pushed before. The wallet is the source of truth.
  let sourceOutpoint: string | undefined
  let inputBEEF: number[] | undefined
  if (branch?.tokenOutpoint) {
    const list = await wallet.listOutputs({
      basket: GIB_BASKET,
      tags: ['gib'],
      include: 'entire transactions',
      limit: 10,
    })
    // Pick the coin named in branch.json; fall back to the newest in the basket.
    const want = branch.tokenOutpoint.replace('_', '.')
    const coin =
      list.outputs.find((o) => o.outpoint === want) ?? list.outputs[0]
    if (!coin || !list.BEEF?.length) {
      console.error(`push: no spendable branch coin in wallet (branch.json says ${branch.tokenOutpoint})`)
      process.exit(1)
    }
    sourceOutpoint = coin.outpoint.replace('.', '_')
    inputBEEF = Array.from(list.BEEF)
  }

  const lockingScript = await branchLockScript(wallet, keyID, head)

  const created = await wallet.createAction({
    description: `gib push ${head.slice(0, 16)}...`.slice(0, 50),
    ...(inputBEEF ? { inputBEEF } : {}),
    inputs: sourceOutpoint
      ? [{
          outpoint: sourceOutpoint.replace('_', '.'),
          inputDescription: 'gib branch token',
          unlockingScriptLength: 73, // PushDrop.unlock.estimateLength()
        }]
      : undefined,
    outputs: [
      {
        lockingScript,
        satoshis: 1,
        outputDescription: 'gib branch tip',
        basket: GIB_BASKET,
        tags: ['gib', `root:${head}`],
        customInstructions: branchTokenCi(keyID),
      },
    ],
    options: { randomizeOutputs: false },
  } as never) as {
    txid?: string
    tx?: number[]
    signableTransaction?: { reference: string; tx: number[] }
  }

  // Two server responses:
  //  - completed: wallet could sign everything itself (first mint, no custom
  //    input) -> {txid, tx, sendWithResults}, already signed + broadcast.
  //  - signable: our token input needs a client-side PushDrop unlock ->
  //    {signableTransaction:{reference,tx}}; sign it, then signAction.
  let txid: string
  if (created.txid) {
    txid = created.txid
  } else if (created.signableTransaction) {
    const { reference, tx: txBeeF } = created.signableTransaction
    try {
      const tx = Transaction.fromBEEF(txBeeF)
      if (!sourceOutpoint) throw new Error('signable tx but no token input was planned')
      const idx = tx.inputs.findIndex(
        (i) => (i.sourceTXID ?? '') === sourceOutpoint.split('_')[0],
      )
      if (idx === -1) throw new Error('token input missing from funded tx')
      const input = tx.inputs[idx]
      const src = input.sourceTransaction?.outputs[input.sourceOutputIndex]
      if (!src) throw new Error('token input source tx missing')
      const unlock = new PushDrop(wallet).unlock(
        GIB_PROTOCOL,
        keyID,
        'anyone',
        'all',
        false,
        src.satoshis,
        src.lockingScript,
      )
      const script = await unlock.sign(tx, idx)
      const signed = await wallet.signAction({
        reference,
        spends: { [idx]: { unlockingScript: script.toHex() } },
        options: { acceptDelayedBroadcast: false },
      } as never)
      if ('error' in signed) throw new Error(String(signed.error))
      txid = signed.txid
    } catch (err) {
      await wallet.abortAction({ reference }).catch(() => {})
      throw err
    }
  } else {
    throw new Error('unexpected createAction response shape')
  }

  const newOutpoint = `${txid}_0`
  state.setBranch({
    tokenGenesis: branch?.tokenGenesis ?? newOutpoint,
    tokenOutpoint: newOutpoint,
    keyID,
  })
  console.log(`pushed. txid: ${txid}`)
  console.log(`https://bananablocks.com/tx/${txid}`)
  console.log(`branch token: ${newOutpoint} -> ${head}`)
}

// ---------------------------------------------------------------- status

async function cmdStatus(argv: string[]) {
  const dir = argv[0] ?? '.'
  const state = new GibState(dir)
  console.log(`HEAD:   ${state.head ?? '(none)'}`)
  const b = state.branch
  console.log(`branch: ${b ? `${b.tokenOutpoint}` : '(no token — push to mint)'}`)
  if (b) {
    // verify what the coin actually names on-chain (decode the lock we hold)
    console.log(`        genesis ${b.tokenGenesis}`)
  }
  const bases = state.bases
  const dirty: string[] = []
  for (const [path, _op] of Object.entries(bases)) {
    if (!existsSync(join(dir, path))) dirty.push(`D ${path}`)
  }
  const tracked = new Set(Object.keys(bases))
  for (const f of collectDir(dir)) {
    if (!tracked.has(f.path)) dirty.push(`? ${f.path}`)
  }
  if (dirty.length) console.log(`changes:\n  ${dirty.join('\n  ')}`)
  else console.log('clean vs. published bases')
}

// ---------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const rest = argv.slice(1)
  switch (cmd) {
    case 'init':
      return cmdInit(rest)
    case 'publish':
      return cmdPublish(rest)
    case 'clone':
      return cmdClone(rest)
    case 'commit':
      return cmdCommit(rest)
    case 'push':
      return cmdPush(rest)
    case 'status':
      return cmdStatus(rest)
    default:
      console.log(
        `gib — git semantics on BSV\n\n` +
          `usage:\n` +
          `  gib init <dir>                  create an empty repo\n` +
          `  gib publish <dir>               genesis: upload the whole tree\n` +
          `  gib clone <root-outpoint> [dir] materialize a tree from chain\n` +
          `  gib commit [dir]                publish current state, move HEAD\n` +
          `  gib push [dir]                  mint/spend the branch token -> HEAD\n` +
          `  gib status [dir]                local state vs chain`,
      )
      process.exit(cmd ? 1 : 0)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err))
  process.exit(1)
})
