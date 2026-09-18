import { Transaction } from '@bsv/sdk'
import { decodeBranchToken } from './src/token.ts'

const txid = process.argv[2] ?? '83c55ad839d8bca1042909663b6a1d7468e7dfd71c67cd43d52363a254359138'
const res = await fetch(`https://api.1sat.app/1sat/beef/${txid}`)
const buf = new Uint8Array(await res.arrayBuffer())
const tx = Transaction.fromBEEF(buf, txid)
const dec = decodeBranchToken(tx.outputs[0].lockingScript.toHex())
console.log('coin names root:', dec.root)
console.log('identity:', dec.lockingPublicKey)
