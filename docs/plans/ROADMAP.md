# gib roadmap / workstreams

Four independent workstreams. Specs are authoritative; this file only sequences and
assigns. Read the spec links before touching code.

## WS-A — 1sat-stack (Go gateway)
Repo: b-open-io/1sat-stack (`pkg/ordfs`).
- Serve `ordfs/dir` manifests: parse per spec, path traversal, default entry
  (`.` then `index.html`), existing maxDirectoryDepth=8, 400 on invalid manifest.
- Serve `ordfs/patch`: resolve base chain, apply vcdiff (RFC 3284), serve resolved
  bytes with the base's content type; Range/stream unchanged.
- Keep `ord-fs/json` read support (legacy). Never write new types with the hyphen.
Spec: `docs/plans/ordfs-formats.html` (self-contained).

## WS-B — 1sat-sdk (TypeScript)
Repo: b-open-io/1sat-sdk (work lands here directly; opldotdev is a renamed mirror —
same repo). Package: `packages/actions`.
- `ordfs/dir` encoder: canonical form (sorted names, reserved bits 0) + decoder.
- `ordfs/patch` encode/apply: envelope [1B version][36B base outpoint][vcdiff];
  vcdiff codec choice verified under Bun (vcdiff-wasm proven).
- Push-drop lifecycle abstraction lifted from OPNS
  (`src/opns/*`, `apply/opnsRegister.ts`, `utils/completeSignedAction.ts`):
  mint / seal-forward spend / decode / customInstructions at lock time. Gib passes
  fields + keyID; SDK owns PushDrop mechanics.
- Note: OP_FALSE fix for standalone ORDFS data outputs already merged (f7e434f6).
Spec: `docs/plans/ordfs-formats.html` + `gib-token.html` (token fields/keyID).

## WS-C — gib (this repo)
New tree; prototype archived on branch `archive/prototype` (see its README for what
was proven on mainnet). Build order respects dependencies on A/B interfaces — code
against the specs, not the gateway implementation.
1. txstore: global store per install, `get/put(txid)`, stores SIGNED bytes only,
   verify by recomputing txid. Medium: files behind the interface (see questions.md).
2. resolver: outpoint -> content. Chain/BEEF only, never ORDFS content. Walk
   `ordfs/dir` + `ordfs/patch` to file bytes and manifest state.
3. git-remote-gib helper: advertise (wallet list-by-tags origin:/branch:), fetch
   (walk-from-outpoint), push intake (pack -> records + cascade + commit head + seal).
   Ref lifecycle = coin lifecycle. Requirements: `gib-cli.html`.
4. seal/mint lifecycle + recovery: two-phase push (content txs first, head tx last),
   BRC-100 basket/labels (`gib`, `push:<sha>`, tags `origin:`/`branch:`), crash
   recovery via listActions + abort/resume. KeyID = named root outpoint.
   Genesis: auto-mint on first push to null remote; origin = genesis root outpoint.
5. validation gate: after content lands, before sealing, resolve new root and verify
   git hashes match the sealed commit object byte-for-byte.

## WS-D — GibHub (website)
Consumes the same specs; chain-reader only (no wallet authority). Start from
`gib-token.html` (what tokens mean) + `ordfs-formats.html` (what content means).

## Cross-cutting, settled — do not relitigate in code
- Write-once content; unchanged files emit nothing; manifests full re-inscribe
  (diff-encoded dirs remain format-compatible, not now).
- git stays git: only push/fetch touch chain; no gib workflow commands.
- Record = vcdiff only; no diff-type byte; empty delta is invalid (links are
  manifest entries citing existing outpoints).
- One wallet + one txstore per gib install; no `.gib` in projects.
- Content types: `ordfs/dir`, `ordfs/patch`, `ordfs/stream`; `ord-fs/json` legacy.
- ≤256 outputs per publishing tx; batch/stream big commits; provisional content may
  orphan; pending state = wallet actions (labels) + txstore, never a third cache.

Open items live in `docs/plans/questions.md` — none currently block any workstream.
