import { PushDrop, type WalletInterface } from '@bsv/sdk'
import {
	type CommitToken,
	commitTokenFields,
	GIB_PROTOCOL,
	gibKeyId,
} from './token.ts'

export async function sealCommitLock(
	wallet: WalletInterface,
	token: CommitToken,
) {
	return new PushDrop(wallet).lock(
		commitTokenFields(token),
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
