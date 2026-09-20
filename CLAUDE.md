# Working on gib-cli

Read `README.md` first: it states the model, and the model is not up for
re-litigation here. This file is about how to work in the repository.

## Ground rules

- `bun run typecheck` and `bun test` must both pass before anything is committed.
- **No network, no wallet, no chain in tests.** `test/fakes/` has a BRC-100 wallet that
  funds, signs and verifies in memory, a gib peer that serves the BRC-180 manifest, both
  BRC-24 lookups and the BRC-22 submit route, and git helpers. Anything that would touch
  mainnet belongs in a fake.
- Never perform an on-chain transaction or call a real wallet while developing.
- Say **"repository origin"** for the genesis `ordfs/dir` root outpoint, in code,
  comments, errors and commit messages. Never bare "origin": ordinals have origins and
  git has a remote named `origin`.
- Outpoints are `txid_vout` everywhere they are written down (`parseOutpoint` also reads
  `txid.vout`, because BRC-100 wallets use the dot form).
- Comments explain *why*. The what is in the code.

## What is where

| Area | Files |
| --- | --- |
| remote URLs, discovery, peer client | `src/remote/url.ts`, `discover.ts`, `peer.ts` |
| syncing, ref naming, helper protocol | `src/remote/sync.ts`, `advertise.ts`, `helper.ts` |
| commit chain planning and publishing | `src/cascade.ts`, `src/chain.ts` |
| push, fetch, init | `src/push.ts`, `src/fetch.ts`, `src/init.ts` |
| head token | `src/token.ts`, `src/seal.ts`, `src/head.ts`, `src/publish.ts` |
| byte formats | `src/ordfs/` |
| local state | `src/txstore.ts`, `src/refs.ts`, `src/identity.ts`, `src/pending.ts` |

## Things that will bite you

- **A same-transaction directory reference is one byte.** A content transaction holds at
  most 256 outputs. `chain.ts` starts a new transaction when the next commit will not
  fit; a single commit that needs more than that is refused, with a TODO.
- **A patch needs a base with a txid.** Bytes still waiting in the transaction being
  built cannot be patched against, so they are written whole. Identical content is a
  citation, never a no-op patch.
- **The head's locking script is a PushDrop with an ord envelope appended.** Decoding
  trims everything from the `ord` marker on; `PushDrop.decode` stops at the first DROP,
  so unlocking works on the whole script.
- **A loose git object is written read-only.** Never rewrite one that exists.
- **`list for-push` must advertise the peer's view**, not everything this client knows,
  or git will decide the remote already has a head that was only ever minted locally and
  send nothing.
- **The commits a push mints are the ones missing from this identity's own chain**, not
  from the repository. A branch's spend chain carries that branch's whole history, so a
  commit another publisher minted still needs a head of ours before our branch can point
  past it. Its content is cited, not rewritten.
- **The wallet's basket is spend authority, not a ref list.** Refs come from the store
  and `src/refs.ts`; the basket is only consulted to find the head this wallet may spend.
- BRC-24 answers carry `result` as a JSON document encoded *into a string*: parse twice.
- The client never asks a third party for a repository's transactions. There is no
  default gateway; the only host it contacts is the one in the `gib://` URL (resolved
  through BRC-180).

## Known gaps

- `ls_gib` has no query that enumerates a repository's branches. `branchCandidates` in
  `src/remote/sync.ts` guesses from what is already known, the genesis tree's `.gib`
  `defaultBranch`, and `main`/`master`. That is why `gib init` still writes
  `defaultBranch`.
- A push of many commits mints one wallet action per head. There is no batching, because
  each head spends the one before it.
- `headsSince` says nothing about whether a branch's last head has been spent, so a
  branch deleted by burning its head still advertises to anyone who learns about it from
  a peer rather than from their own delete. See the TODO on `pullBranch`.
