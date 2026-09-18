# gib-cli (prototype)

On-chain git for BSV. Content is write-once chain outputs; directory manifests are
`ordfs/dir` inscriptions; branch pointers are sealed push-drop coins ("commit tokens");
gib sits on top of local git as the chain codec + pointer/authority layer via a
`git-remote-gib` helper.

**Status: prototype.** The design docs in `docs/` (and `docs/plans` upstream) are the
source of truth; the code here is a first end-to-end proof, partially superseded by the
current design. What is proven on mainnet:

- ORDFS directory publish + read (`c657be5a7dacd7bb7343d92b7195d1366dbecd3ec31874576189efd28eee007c`)
- clone / edit / commit / push roundtrip (commit `e6f27ce723b2923e93227ecef64b6cecf9464bd0c6ba71a66502aa20c5de82a1`)
- push-drop commit-token chain via the BRC-100 wallet API
  (`ea37133ee0c26db03568cb074f111ee3398f3bbbc106a7c85dcc33b3a7fea5f3` →
  `83c55ad839d8bca1042909663b6a1d7468e7dfd71c67cd43d52363a254359138`)

Known-divergent from the current design (being rebuilt):

- `commit` republishes the full tree — must become vcdiff `ordfs/patch` records +
  manifest cascade (write-once content)
- `.gib/` project state — gone; gib is one app with one global txstore and one wallet
- `src/ordfs.ts` reads content from ORDFS — removed in the new design (chain/BEEF only)
- token fields/keyID predate the final spec: `["gib", origin, branch, root, pubkey]`,
  keyID = named root outpoint

Docs: `docs/gib-format.html`, `docs/gib-token.html`, `docs/gib-cli.html`,
`docs/gib-rationale.html`.

Run: `bun run src/main.ts <clone|commit|push|status>` (requires a local 1Sat wallet API
on `http://127.0.0.1:3321`).
