import { HTTPWalletJSON, type WalletInterface } from '@bsv/sdk'

export const DEFAULT_WALLET_URL = 'http://127.0.0.1:3321'
export const ORIGINATOR = 'gib'

export function connectWallet(url = DEFAULT_WALLET_URL): WalletInterface {
	return new HTTPWalletJSON(ORIGINATOR, url)
}
