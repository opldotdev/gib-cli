import { HTTPWalletJSON, type WalletInterface } from '@bsv/sdk'

export const DEFAULT_WALLET_URL = 'http://127.0.0.1:3321'
export const ORIGINATOR = 'gib'

/** BRC-100 wallet endpoint: GIB_WALLET_URL, else the standard local port. */
export function walletUrl(): string {
	return process.env.GIB_WALLET_URL?.trim() || DEFAULT_WALLET_URL
}

export function connectWallet(url = walletUrl()): WalletInterface {
	return new HTTPWalletJSON(ORIGINATOR, url)
}
