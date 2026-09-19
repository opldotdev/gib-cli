import { pushDropCustomInstructions, pushDropLock } from '@1sat/actions'
import type { WalletInterface } from '@bsv/sdk'
import {
	type CommitToken,
	commitTokenFields,
	GIB_PROTOCOL,
	gibKeyId,
} from './token.ts'

type SealWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>

/** Sealed commit-head lock: fields signed under keyID = the root outpoint. */
export async function sealCommitLock(wallet: SealWallet, token: CommitToken) {
	return pushDropLock(
		wallet as WalletInterface,
		{
			fields: commitTokenFields(token),
			protocolID: GIB_PROTOCOL,
			keyID: gibKeyId(token.root),
			counterparty: 'anyone',
			forSelf: true,
		},
		{ includeSignature: true },
	)
}

/** Wallet customInstructions needed to spend a commit head later. */
export function commitHeadCustomInstructions(root: string): string {
	return pushDropCustomInstructions({
		protocolID: GIB_PROTOCOL,
		keyID: gibKeyId(root),
		counterparty: 'anyone',
	})
}
