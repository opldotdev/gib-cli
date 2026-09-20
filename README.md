# gib

> **Deprecated.** This TypeScript implementation is superseded by the Go one at
> [b-open-io/gib](https://github.com/b-open-io/gib), which runs the gib overlay
> locally, speaks the same on-chain formats, and is the supported `git-remote-gib`.
> Published on chain as repository origin
> `6d46f3406ee04d1b9b1379d0c012b6b0bb8ff0bc18f19d4709f9f6cefb94569d_82`.
> This repository is kept for history only and receives no further work.

On-chain git for BSV. Content is write-once chain outputs; directories are `ordfs/dir`
inscriptions; a branch is a chain of sealed push-drop coins ("commit heads"). gib sits
on top of local git as the chain codec plus pointer/authority layer, via a
`git-remote-gib` remote helper. Git stays git — only push and fetch touch the chain.

## The model

**One head per commit.** A push of N commits mints N head tokens, each spending the
one before it, each carrying its own commit object and its own root tree. The branch's
spend chain *is* the commit history, so a fetch walks it back with no gaps. The content
for all N commits goes out first, in as few transactions as it fits in.

**The published tree is git's tree.** A commit's tree resolves, byte for byte, to the
tree sha the commit names — checked on every push before anything is minted, and again
on every fetch. Nothing extra is published in it.

**The client holds no overlay.** No engine, no database, no topic manager, no chain
tracker; the client never validates a merkle proof. It keeps the transactions it has
been given in `$GIB_HOME/txstore` and, beside them, the newest head it has seen per
`(identity, branch)` in `$GIB_HOME/repos/<repository origin>.json`. The peer's overlay
validates; the client asked it for what it got.

**Remotes are peers.** A remote URL is `gib://<host>/<repository origin>`, or
`gib://<repository origin>` for local only. "Repository origin" is always the genesis
`ordfs/dir` root outpoint — never bare "origin", which ordinals and git both already
use for something else.

**Syncing is the lookup service.** Two BRC-24 questions on `ls_gib`:
`headsSince` walks one branch's heads from a point forward, oldest first, each with its
own BEEF; `txs` fetches whole transactions by txid (at most 50) as one merged BEEF.
Publishing is a BRC-22 submission of an atomic BEEF to `tm_gib`.

**Discovery is BRC-180.** A host is resolved by fetching `https://<host>/manifest.json`
and reading `metanet.overlays`: `tm_gib` is the submit endpoint, `ls_gib` the lookup
endpoint, each used verbatim. A host with no manifest, or no entry for gib, is treated
as the overlay itself at `/1sat/gib/overlay` — that is not probing, it is contacting
exactly the host the user named. `gibhub.net` publishes
`https://api.1sat.app/1sat/gib/overlay` for both; `api.1sat.app` serves no manifest and
works through the fallback.

**Ref naming.** Heads signed by this wallet advertise as `refs/heads/<branch>`; every
other publisher's as `refs/heads/@<66-hex identity>/<branch>`. Pushing an `@…` ref is
refused. The identity is cached in `$GIB_HOME/identity`, so listing works with no
wallet; with neither wallet nor cache, nothing is bare. `HEAD` resolves to the genesis
head's branch — the earliest head on the repository origin, the one whose root *is* the
origin.

**The head token** is a 1-satoshi PushDrop with the git commit object inscribed on the
same output: fields `["gib", <repository origin>, <branch>, <root>, <identity>]`,
protocol `[1, "gib branch"]`, keyID = the root outpoint, counterparty `anyone`, basket
`gib`, labels `gib push` / `gib delete`, tags `origin:<o>`, `branch:<n>`,
`commit:<sha>`, `randomizeOutputs: false`.

## Use it

```bash
bun install
ln -s "$PWD/src/git-remote-gib.ts" ~/.local/bin/git-remote-gib   # git finds helpers on PATH
ln -s "$PWD/src/main.ts" ~/.local/bin/gib

cd my-project
git init && git add -A && git commit -m init     # gib init needs a commit
gib init                                         # mints the repository; writes .gib
git remote add gib gib://gibhub.net/<repository origin>
git push gib main                                # publishes the chain to that peer

git clone gib://gibhub.net/<repository origin>   # anyone, no wallet needed
```

`gib init` creates the repository and nothing else does: a push joins the repository its
URL names and never mints a second one. It adds a `local` remote (`gib://<origin>`, the
local store only) and prints the peer remote to add.

Other commands: `gib sync <gib url>` refreshes a repository from its peer, `gib doctor`
checks the wallet and store, `gib put <file>` stores a signed transaction.

Publishing needs a BRC-100 wallet on `http://127.0.0.1:3321` (`1sat serve wallet-api`,
or set `GIB_WALLET_URL`) and its monitor running (`1sat serve monitor`) so delayed
broadcasts go out. Reading needs no wallet at all.

## Environment

| Variable | Meaning |
| --- | --- |
| `GIB_HOME` | store, per-repository state, identity cache (default `~/.gib`) |
| `GIB_WALLET_URL` | BRC-100 wallet endpoint (default `http://127.0.0.1:3321`) |

## Layout

- `src/remote/` — `gib://` URLs, BRC-180 discovery, the peer client (both lookups and
  submit), syncing, ref naming, and the remote-helper protocol.
- `src/chain.ts`, `src/cascade.ts` — planning a chain of commits into content outputs.
- `src/push.ts`, `src/fetch.ts` — minting the head chain, and walking it back into git.
- `src/ordfs/` — the `ordfs/dir` and `ordfs/patch` codecs and vcdiff.
- `src/token.ts`, `src/seal.ts`, `src/head.ts` — the head token: fields, sealing, reading.
- `test/fakes/` — a fake BRC-100 wallet, a fake gib peer, and git helpers. Tests never
  touch a network, a real wallet or a chain.

## Reading

- `docs/plans/ordfs-formats.html` — the `ordfs/dir` / `ordfs/patch` byte specs (the
  contract between 1sat-stack, 1sat-sdk and gib).
- `docs/plans/gib-token.html`, `gib-cli.html`, `gib-format.html`, `gib-rationale.html` —
  design. `gib-status.html` — what was proven on mainnet.
- `docs/plans/ROADMAP.md`, `docs/plans/questions.md` — sequencing and open items.
- BRC-180 (overlay service discovery at an internet domain) for the manifest.

Related repos: `b-open-io/1sat-sdk` (dir/patch encoding and push-drop lifecycle),
`b-open-io/1sat-stack` (the gib overlay: `tm_gib`, `ls_gib`, and the gateway serving
the content types).
