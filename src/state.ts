/**
 * .gib — local repository state.
 *
 * Layout (flat on purpose; nothing here is authoritative — the chain is):
 *   .gib/HEAD              the root outpoint the worktree stands on
 *   .gib/branch.json       { tokenGenesis?, tokenOutpoint?, keyID } if a
 *                          branch token exists for this repo
 *   .gib/bases.json        path -> outpoint the working copy was materialized
 *                          from (the diff bases for the next commit)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface BranchState {
  tokenGenesis: string // genesis outpoint of the token lineage (keyID anchor)
  tokenOutpoint: string // current coin outpoint (spend = push)
  keyID: string
}

export class GibState {
  constructor(public dir: string) {}

  private p(...parts: string[]) {
    return join(this.dir, '.gib', ...parts)
  }

  ensure() {
    mkdirSync(this.p('.'), { recursive: true })
  }

  get head(): string | null {
    const f = this.p('HEAD')
    return existsSync(f) ? readFileSync(f, 'utf8').trim() : null
  }
  setHead(root: string) {
    this.ensure()
    writeFileSync(this.p('HEAD'), `${root}\n`)
  }

  get branch(): BranchState | null {
    const f = this.p('branch.json')
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as BranchState) : null
  }
  setBranch(b: BranchState) {
    this.ensure()
    writeFileSync(this.p('branch.json'), JSON.stringify(b, null, 2))
  }

  get bases(): Record<string, string> {
    const f = this.p('bases.json')
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
  }
  setBases(b: Record<string, string>) {
    this.ensure()
    writeFileSync(this.p('bases.json'), JSON.stringify(b, null, 2))
  }
}
