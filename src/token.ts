/**
 * gib branch tokens — signed push-drop coins naming a root outpoint.
 *
 * Pattern copied from the OPNS register/publish flow in @1sat/actions:
 *   - 1-sat P1Sat output, wallet basket so the coin is queryable/spendable
 *   - PushDrop fields: [identity pubkey, root outpoint string]
 *   - sealed by PushDrop.lock(..., forSelf=true, includeSignature=true)
 *   - spend = push: consume the coin, recreate it citing the new root
 *
 * A push-drop spend of the token IS the branch update — whoever can spend
 * it owns the branch. No extra authority machinery.
 */

import { LockingScript, PushDrop, Utils } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'

export const GIB_PROTOCOL: [0 | 1 | 2, string] = [1, 'gib branch']
export const GIB_BASKET = 'gib/branches'

/** keyID ties the signature to one token lineage (its genesis outpoint). */
export const gibKeyId = (tokenGenesisOutpoint: string) => `gib:${tokenGenesisOutpoint}`

/**
 * Build a sealed PushDrop locking script for a branch token naming `root`.
 */
export async function branchLockScript(
  wallet: WalletInterface,
  keyID: string,
  root: string,
): Promise<string> {
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  const fields: number[][] = [
    Utils.toArray(publicKey, 'hex'),
    Utils.toArray(root, 'utf8'),
  ]
  const script = await new PushDrop(wallet).lock(
    fields,
    GIB_PROTOCOL,
    keyID,
    'anyone',
    true, // forSelf: signature is recoverable, we hold the key
    true, // include the real signature now; spend authority is key ownership
  )
  return script.toHex()
}

/** CI the wallet needs to unlock our tokens in future actions (OPNS pattern). */
export const branchTokenCi = (keyID: string) =>
  JSON.stringify({
    protocolID: GIB_PROTOCOL,
    keyID,
    counterparty: 'anyone',
  })

/** Decode a branch token's locking script → { root, identity public key }. */
export function decodeBranchToken(lockingScriptHex: string): {
  root: string
  lockingPublicKey: string
} {
  const { fields, lockingPublicKey } = PushDrop.decode(
    LockingScript.fromHex(lockingScriptHex),
  )
  const rootField = fields[1]
  if (!rootField) throw new Error('not a gib branch token: missing root field')
  return {
    root: new TextDecoder().decode(new Uint8Array(rootField)),
    lockingPublicKey: lockingPublicKey.toDER('hex') as string,
  }
}
