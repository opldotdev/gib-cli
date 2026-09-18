/**
 * Wallet connection for gib.
 *
 * gib is a BRC-100 client (same posture as the bitplan CLI): it never holds an
 * identity key, derives nothing, signs nothing. All key operations and
 * transaction creation go to the user's wallet over the local BRC-100 JSON
 * API. If nothing answers on the bridge, commands fail and say so.
 */

import { HTTPWalletJSON, type WalletInterface } from '@bsv/sdk'
import { createContext, type OneSatContext } from '@1sat/actions'

export const DEFAULT_WALLET_URL = 'http://127.0.0.1:3321'
export const ORIGINATOR = 'gib'

export function connectWallet(url: string = DEFAULT_WALLET_URL): WalletInterface {
  return new HTTPWalletJSON(ORIGINATOR, url)
}

export function createContextForWallet(wallet: WalletInterface): OneSatContext {
  return createContext(wallet, {
    chain: 'main',
    // Actions route through the wallet's 1sat module regardless; the field is
    // deprecated for routing purposes upstream.
    isBaseWallet: false,
  })
}
