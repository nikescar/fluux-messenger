import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'

// The committed live icons (git HEAD) must equal the hollow variant's dist, so
// the shipped default can't silently drift from its source. Reads live bytes
// from git HEAD (not the working tree), so a local `plain` build does not trip
// this. hollow/dist is read from disk (it equals HEAD when committed).
const APP = process.cwd() // apps/fluux
const REPO = resolve(APP, '../..')
const HOLLOW_DIST = resolve(APP, 'src-tauri/icons/icon-variants/hollow/dist')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

// Check if git repository has full history (needed for git show HEAD:...)
function hasGitHistory(): boolean {
  try {
    // Try to access git history - this will fail in shallow clones or non-git environments
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, stdio: 'pipe' })

    // Check if .git directory exists (act might copy files without .git)
    const gitDir = resolve(REPO, '.git')
    if (!existsSync(gitDir)) {
      return false
    }

    return true
  } catch {
    return false
  }
}

const GIT_AVAILABLE = hasGitHistory()

describe('committed live icon default matches hollow/dist', () => {
  if (!GIT_AVAILABLE) {
    it.skip('skipped - git history not available (shallow clone or act environment)', () => {
      // This test requires full git history to run `git show HEAD:...`
      // In CI environments with shallow clones or act, we skip these tests
    })
    return
  }

  for (const kind of ['icons', 'public'] as const) {
    const base = join(HOLLOW_DIST, kind)
    for (const abs of walk(base)) {
      const rel = relative(base, abs)
      const repoRel =
        kind === 'icons'
          ? join('apps/fluux/src-tauri/icons', rel)
          : join('apps/fluux/public', rel)
      it(`live ${repoRel} == hollow/dist`, () => {
        const committed = execFileSync('git', ['show', `HEAD:${repoRel.split('\\').join('/')}`], {
          cwd: REPO,
          maxBuffer: 200 * 1024 * 1024,
        })
        expect(committed.equals(readFileSync(abs))).toBe(true)
      })
    }
  }
})
