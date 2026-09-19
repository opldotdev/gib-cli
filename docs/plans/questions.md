# gib open questions (one per turn; answered ones move out)

- [ ] wallet label scheme (BRC-100): basket `gib`; tx label push:<sha> on every tx of a
      push; output tags origin:<o>/branch:<n> on commit heads. Txstore stores SIGNED bytes
      only (txid changes at signing — build-time writes are useless). Recovery =
      listActions by label (gives txid/status/reference only) → txstore hit = resume;
      unsigned/nosend = abort by reference + rebuild; sent/mined but missing = refetch
      bytes by txid from chain. Sole real gap: signed-but-never-broadcast-before-crash
      → handled by abort + rebuild
- [ ] clone entry point form (root outpoint vs token outpoint)
- [ ] txstore medium: sharded files (txid-prefix buckets) vs key-value store (LMDB/SQLite);
      many txs → inode/backup concerns. Start with files behind a get/put interface
- [ ] txstore scoping/housekeeping: correlate which repos each tx is used for (many-to-many —
      shared txs must NOT duplicate) so unused projects can be pruned. GC-style reachability,
      not ownership. Note now, solve later

# answered 2026-09-19 (details in gib-cli.html §metadata)
- repository metadata = committed dotfile `.gib` (JSON: name, description, defaultBranch);
  labels not identifiers, origin stays the id; default branch = git HEAD symref home
- `gib init`: git init if needed, write `.gib`, add remote `gib://new`; helper rewrites the
  remote to `gib://<origin>` after the genesis push and reports it

# answered 2026-09-18 → decisions (details in gib-token.html / gib-cli.html / gib-format.html)
- file modes: SOLVED by ordfs/dir flags byte (EXEC/SYMLINK bits; symlink leaf bytes =
  target path) — see ordfs-formats.html; content types settled: ordfs/dir, ordfs/patch,
  ordfs/stream (ord-fs/json legacy read-only); SDK work lands in b-open-io/1sat-sdk
- repository = origin genesis directory inscription; (origin, branch) is the namespace
- commit token fields [gib, origin, branch, root, pubkey]; commit head = single final tx,
  git commit object inscribed on the head output; keyID = root outpoint (computable because
  content txs are published FIRST — no single-tx commit; batch/stream freely; provisional
  content may orphan; pending-upload cache for push recovery)
- codec vcdiff only; envelope [1B version][36B base][vcdiff]; git diff formats out
- git stays git: no gib workflow commands; add/commit/etc are pure local git; ONLY
  git push (via git-remote-gib helper) writes chain, fetch/pull reads it;
  push = fused tx per new git commit (inscribe=add semantics superseded)
- wallet = gib's database (one wallet; tags = ref inventory; no local remote)
- all public/discoverable; discovery itself external
- txstore: ONE global store per install (supersedes earlier repo-local .gib decision —
  no .gib at all, repos are plain git repos with gib:// remotes); no ORDFS content ever
- git sits UNDER gib as disposable compute; gib = codec + pointers + addressing
- remote-helper shim (git-remote-gib) is the push/pull interface; requirements listed in gib-cli.html
- prior: cascade definitional; manifest entries opaque to outsiders = fine; pubkey required

# backlog
- merge across two outpoints; SDK push-drop abstraction (lift from OPNS, check vs 1sat CI);
  SDK directory-upload mechanics; vcdiff integration test in bun; SDK OP_FALSE patch upstream;
  bundle/export; monitor supervision; publish-skip policy (.gitignore-style; current code
  also wrongly publishes .gib itself — moot once .gib is gone)
