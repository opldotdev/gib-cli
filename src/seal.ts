import { PushDrop, type WalletInterface } from '@bsv/sdk'

type SealWallet = Pick<WalletInterface, 'getPublicKey' | 'createSignature'>
import {
	type CommitToken,
	commitTokenFields,
	GIB_PROTOCOL,
	gibKeyId,
} from './token.ts'

export async function sealCommitLock(
	wallet: SealWallet,
	token: CommitToken,
) {
	return new PushDrop(wallet as WalletInterface).lock(
		[...commitTokenFields(token)],
		GIB_PROTOCOL,
		gibKeyId(token.root),
		'anyone',
		true,
		true,
	)
}

export function commitHeadCustomInstructions(root: string): string {
	return JSON.stringify({
		protocolID: GIB_PROTOCOL,
		keyID: gibKeyId(root),
		counterparty: 'anyone',
	})
}
