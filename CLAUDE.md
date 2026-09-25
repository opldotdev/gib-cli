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
| planning a tree, packing it into transactions | `src/cascade.ts`, `src/chain.ts` |
| push, fetch, init | `src/push.ts`, `src/fetch.ts`, `src/init.ts` |
| published trees, and the `.git` store | `src/tree.ts` |
| head token | `src/token.ts`, `src/seal.ts`, `src/head.ts`, `src/publish.ts` |
| byte formats | `src/ordfs/` |
| local state | `src/txstore.ts`, `src/refs.ts`, `src/identity.ts`, `src/pending.ts` |

## Things that will bite you

- **`.git` in a published root is not a git directory.** It is the repository's object
  store, keyed by sha: commit objects as files, their trees as directories, and a `.`
  default entry aliasing the tip commit. `stripGitDir` removes it, and every path that
  turns a published tree back into git's tree must call it or the sha will not match.
- **Ancestor trees are not optional.** git's connectivity check is
  `git rev-list --objects`, which walks commit to tree to blob; a history missing one
  ancestor tree is one git refuses to fetch. Test it with `git fsck --strict`.
- **A same-transaction directory reference is one byte.** A transaction holds at most
  256 outputs. `chain.ts` packs a plan across as many transactions as it needs, laying
  nodes down in dependency order, so nothing has to fit in one.
- **A patch needs a base with a txid.** Bytes still waiting in the transaction being
  built cannot be patched against, so they are written whole. Identical content is a
  citation, never a no-op patch.
- **A head has no inscription.** It is a bare PushDrop of six fields plus the signature.
  Reading the commit it publishes means reading its root's `.git`, which costs content —
  so `list` resolves the sha for a branch's newest head only, never for every head on
  the chain.
- **A directory reached twice is not a cycle.** Ancestor trees share every subdirectory
  that has not changed. A cycle is a directory that contains itself.
- **A loose git object is written read-only.** Never rewrite one that exists.
- **`list for-push` must advertise the peer's view**, not everything this client knows,
  or git will decide the remote already has a head that was only ever minted locally and
  send nothing.
- **The wallet's basket is spend authority, not a ref list.** Refs come from the store
  and `src/refs.ts`; the basket is only consulted to find the head this wallet may spend.
- BRC-24 answers carry `result` as a JSON document encoded *into a string*: parse twice.
- The client never asks a third party for a repository's transactions. There is no
  default gateway; the only host it contacts is the one in the `gib://` URL (resolved
  through BRC-180).

## Known gaps

- `ls_gib` now has a `branches` query (1sat-stack #55), which answers a repository's
  branches with their publisher, tip, and the repository's `defaultBranch` and `owner`
  taken from the genesis head. This client does not use it yet: `branchCandidates` in
  `src/remote/sync.ts` still guesses from what is already known, the genesis tree's
  `.gib` `defaultBranch`, and `main`/`master`, and `gib sync <url> <branch>` is still how
  a user names one it could not guess. Wiring it up removes the guessing and the reason
  `gib init` writes `defaultBranch`.
- A push reads every reachable commit's tree it has not published before, one
  `git ls-tree` at a time, and holds the tree being planned in memory. The first push of
  a long history is bounded by that.
- Every push walks the peer's whole branch twice — once for `list for-push`, once in
  `syncPeer` — because both start from an empty cursor on purpose. Correct, but linear in
  history, for ever.
- A `.git` manifest lists every reachable commit and tree, so it is rewritten in full on
  every push and grows linearly with history. `ordfs/dir` counts entries in a uint16, so
  a repository is capped at ~32k commits (two entries each).
- An octopus merge of three or more parents only fits two lineages in a head: the spend
  and the one `branchedFrom` field.
- A file edited in N commits ends up behind an N-deep patch chain; there is no
  "rewrite it whole after N" policy, and `prefetchTree` stops following at depth 64.
- `headsSince` says nothing about whether a branch's last head has been spent, so a
  branch deleted by burning its head still advertises to anyone who learns about it from
  a peer rather than from their own delete. See the TODO on `pullBranch`.
