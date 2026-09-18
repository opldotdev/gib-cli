# HANDOFF — SDK implementation stream (WS-B+WS-C)

Date: 2026-09-18. For the agent picking up the SDK/Gib build work.
Read first: `ROADMAP.md`, `ordfs-formats.html`, `gib-format.html`,
`gib-token.html`, `gib-cli.html`, `questions.md` (all in this folder).

## Repo state right now

### gib-cli (github.com/opldotdev/gib-cli)
- `master` = docs-only (specs + this handoff). Prototype code archived on
  `archive/prototype` — do not build from it; its model is superseded.

### 1sat-sdk (github.com/b-open-io/1sat-sdk, opldotdev is the same org)
- Local checkout: `code/1sat-sdk`. Branch: `feat/ordfs-dir-patch` (pushed).
- Branch contains 3 pre-existing commits (OP_FALSE OP_RETURN ORDFS fix,
  `serve wallet-api`, P1SAT rename docs) + 2 from this session:
  1. `feat(actions): ordfs/dir binary directory codec` — DONE.
  2. `wip(actions): hand-rolled RFC-3284 vcdiff codec` — INCOMPLETE, do not
     merge as-is (details below).
- Uncommitted: nothing. package.json is clean (probe deps were removed).

## Done: `ordfs/dir` codec (packages/actions/src/ordfs/dir.ts)

- Types `DirEntry`/`DirManifest`, `dirEncode`/`dirDecode`, canonical sort by
  raw name bytes, flags byte (dir/exec/symlink/ref-kind), 1B name length,
  same-tx vout vs native 36B outpoint refs, strict decode errors,
  `dirDefault()` implementing the "." then "index.html" convention.
- Tests: `test/ordfsDir.test.ts` — 10 pass / 0 fail, including the byte
  golden test against the worked example in `ordfs-formats.html`.
- NOT yet exported from `packages/actions/src/index.ts` — add when the
  module set settles.

## Settled: vcdiff codec (`xdelta3-wasm`, RFC-plain profile)

Decision (follow-up branch `feat/ordfs-patch` in 1sat-sdk; spec on
`docs/vcdiff-profile` in this repo): **`xdelta3-wasm`** encode+decode.
On-chain profile is RFC 3284 with `Hdr_Indicator = 0` — same bytes as
`xdelta3 -e -n -S none -A`. `@limrun/xdelta3-wasm` encodes the same
profile but is encode-only. `vcdiff-wasm` remains REJECT.

## Was in progress: vcdiff codec — DECISION PENDING, then finish or delete

The record codec needs VCDIFF (RFC 3284) deltas that any third party can
read. Findings from an exhaustive probe of available libraries:

| Option | Verdict |
|---|---|
| `vcdiff-wasm` (npm) | NOT RFC-conformant: writes Header4 = 0x53 (must be 0x00). xdelta3 CLI rejects its deltas. Self-consistent only with its own decoder. Non-commercial license on the compiled lib. REJECT. |
| `vcdiff` / `simple-vcdiff` (open-vcdiff native wrappers) | Dead since 2014/2016; native build fails in sandbox; native addons can't run in browser (GibHub needs client-side decode). REJECT. |
| `@ably/vcdiff-decoder` | Decoder ONLY (export name is `decode`, not `decodeSync`). Fine as an extra test-side validator, not an encoder. |
| `@limrun/xdelta3-wasm` (2026-07, Apache-2.0) | Real xdelta3 compiled to wasm. Encoder-only API: `encode(target: AsyncIterable, source: SourceReader)`. Streaming. UNTESTED — top candidate for encode. |
| `xdelta3-wasm` (2023, Apache-2.0) | Memory API: `xd3_encode_memory/xd3_decode_memory(input, source, max, cfg)` returning `{ret, str, output}`. UNTESTED — candidate for decode. |
| `xdelta3` CLI (apt) | Reference RFC implementation; available in sandbox. Use `-S none` (else it embeds a soft header with filenames) and `-n` (no secondary compression) for interop tests. |
| Hand-rolled pure-TS codec | Written as WIP (see commit). Currently broken. |

**Unfinished interop analysis.** Scratch project was at `/tmp/vc-test/`
(ephemeral, now gone). Recreate: bun project with
`@limrun/xdelta3-wasm`, `xdelta3-wasm`, `@ably/vcdiff-decoder` + xdelta3
CLI, and test these edges, both directions:
- @limrun encodes → xdelta3 CLI decodes? → @ably decodes? → xdelta3-wasm decodes?
- xdelta3 CLI `-e -n -S none` → xdelta3-wasm decodes? (earlier: vcdiff-wasm
  FAILED this because it can't handle xdelta3 secondary compression; with
  `-n` it should, VERIFY)
- xdelta3-wasm encodes → xdelta3 CLI decodes? → @ably decodes?
Pick the pair that round-trips through the CLI reference in both
directions; that output becomes the on-chain profile. Document the exact
profile (secondary compression on/off etc.) in `ordfs-formats.html` — the
gateway and GibHub must know it. Note: deltas with VCD_DECOMPRESS/Hdr
indicator bits set need matching decoder support everywhere.

### If the decision is instead to finish the hand-rolled codec (src/ordfs/vcdiff.ts)

Current state: last measured 4 pass / 8 fail; xdelta3 CLI still rejects
emitted deltas ("unrecognized delta indicator bits"). Known-remaining
framing bugs:
1. Both encoder and decoder still OMIT `Length of the delta encoding`
   (integer) and `Delta_Indicator` (byte) between the source-segment
   fields and the target-window size. RFC 4.2/4.3 layout:
   `Win_Indicator [srcLen srcPos] <delta-enc: length, targetSize,
   Delta_Indicator, dataLen, instLen, addrLen, sections>`. Only the
   empty-target path got the two fields; the normal path did not.
2. Decoder must also validate Delta_Indicator == 0 (reject compressed
   sections) and read the checksum after Delta_Indicator only when the
   (non-RFC, xdelta3-specific) Win_Indicator 0x10 bit is set — verify
   ordering against xdelta3 output with `-D`.
3. RFC 2 integer convention is base-128 BE with MSB set on all bytes
   EXCEPT the last (already fixed in `putVarint` — protobuf-style
   trailing-continuation was the original bug).
4. Source bytes are NEVER embedded in the delta (Win_Indicator references
   the source file the decoder must already have). The Gib record format
   carries the base outpoint for that — see `gib-format.html`.
Test file `test/vcdiff.test.ts` already has the right expectations,
including xdelta3 CLI interop (skips when CLI absent).

## Remaining work, in order

1. ~~Settle vcdiff.~~ Done on `feat/ordfs-patch` (1sat-sdk) +
   `docs/vcdiff-profile` (this repo). Profile in `ordfs-formats.html`.
2. ~~`ordfs/patch` envelope helpers.~~ Done (`patchEncode`/`patchDecode`/
   `patchFromContent`/`patchApply`; identical-content refused).
3. ~~PushDrop lifecycle abstraction.~~ Done (`pushDropLock`/`pushDropSeal`/
   `pushDropDecode`/`pushDropCustomInstructions` in
   `packages/actions/src/utils/pushdrop.ts`). Gib-specific fields and
   keyID policy still live in gib, not the SDK.
4. ~~Export modules.~~ Done from `ordfs/index.ts` + actions `index.ts`.
   Package build passes. PR against `master` in b-open-io/1sat-sdk still
   needed (do not use `feat/ordfs-dir-patch`).
5. Gib stream (WS-C) on branch `feat/gib` — in progress:
   txstore, resolver (B + ord, dir walk, patch chain), commit-token
   seal/decode, recovery plan, cascade planner (`planCommit`: genesis
   + cite-unchanged), `git-remote-gib` capabilities/list/fetch.
   Still open: wallet publish of planned outputs, push intake from
   git pack, validation gate, live advertise, pending-upload cache.

## Environment notes

- bun workspace; run tests with `bun test` inside `packages/actions`.
- Pre-existing lint noise from bun-types vs node types — ignore unless your
  change adds new errors.
- Sandbox may lack `xdelta3` — `apt-get install xdelta3`.
- 1sat-stack gateway work (WS-A) is handled externally against
  `ordfs-formats.html`; do not touch that repo from this stream.
