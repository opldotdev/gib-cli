# gib

On-chain git for BSV. Content is write-once chain outputs; directories are `ordfs/dir`
inscriptions; branch pointers are sealed push-drop coins ("commit tokens"); gib sits on
top of local git as the chain codec + pointer/authority layer via a `git-remote-gib`
remote helper. Git stays git — only push/fetch touch the chain.

**Start here:**
- `docs/plans/ROADMAP.md` — workstreams, build order, settled decisions.
- `docs/plans/ordfs-formats.html` — the `ordfs/dir` / `ordfs/patch` byte specs (the
  contract between 1sat-stack, 1sat-sdk, and gib).
- `docs/plans/gib-token.html`, `gib-cli.html`, `gib-format.html`, `gib-rationale.html` —
  design. `gib-status.html` — what was proven on mainnet (full txids inside).
- `docs/plans/questions.md` — open items vs answered decisions.

**This branch is docs-only.** The working tree is greenfield: no implementation yet.
The first prototype (clone/commit/push proven end-to-end on mainnet, wallet API,
push-drop token chain) lives on branch **`archive/prototype`**. It uses a superseded
model (full-tree republish, `.gib` project state, ORDFS content reads, pre-final token
fields) — read it for the wallet/BRC-100 mechanics that work, not for architecture.

Related repos: `b-open-io/1sat-sdk` (dir/patch encoding + push-drop lifecycle
abstraction land there directly; opldotdev is the same repo under rename),
`b-open-io/1sat-stack` (gateway serving the new content types).
