#!/usr/bin/env node
/**
 * Run the test suite, portably.
 *
 * The obvious command is `node --test test/`, and it is not portable:
 *
 * 1. **A directory argument means different things to different Nodes.** Node 26
 *    scans it; Node 22 tries to execute it as a module and fails with
 *    `Cannot find module '…/test'`. Glob patterns are the mirror image: they
 *    work on Node 21+ and not on Node 20. Enumerating the files here and passing
 *    explicit paths is the one form every supported version understands — and
 *    the CI failure that prompted this file was exactly the directory form
 *    passing on this machine's Node 26 while failing on CI's Node 22.
 *
 * 2. **The default reporter depends on the Node version and on whether stdout is
 *    a TTY.** A terminal gets `spec` (`ℹ pass 198`); a pipe or CI gets `tap`
 *    (`# pass 198`). Anything that reads the summary has to pin the reporter, so
 *    this pins `spec` — and {@link module:figma-mcp-dsh/scripts/check-test-counts}
 *    still accepts both spellings, because a gate should not depend on which
 *    Node ran it.
 *
 * Usage:
 *   node scripts/run-tests.mjs [dir ...]     # default: test/
 *
 * @module figma-mcp-dsh/scripts/run-tests
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Directories that hold fixtures, not tests. */
const NOT_TEST_DIRECTORIES = new Set(['fixtures', 'support', 'node_modules'])

/** Suffix that marks a file as a test. */
const TEST_SUFFIX = '.test.js'

/** Wall-clock ceiling; the suite contains a real 24-second timing test. */
const TIMEOUT_MS = 10 * 60 * 1000

/**
 * Collect test files under the given directories.
 *
 * @param {readonly string[]} [directories] - Directories to walk, relative to the repository root.
 * @returns {string[]} Absolute file paths, sorted.
 */
export function listTestFiles(directories = ['test']) {
  /** @type {string[]} */
  const found = []

  /**
   * @param {string} directory - Directory to walk.
   */
  const walk = (directory) => {
    /** @type {import('node:fs').Dirent[]} */
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!NOT_TEST_DIRECTORIES.has(entry.name)) walk(path)
        continue
      }
      if (entry.name.endsWith(TEST_SUFFIX)) found.push(path)
    }
  }

  for (const directory of directories) walk(resolve(REPO_ROOT, directory))
  return found.sort()
}

/**
 * Read one `ℹ <name> <count>` (spec) or `# <name> <count>` (tap) summary line.
 *
 * Both spellings are accepted on purpose: pinning the reporter is this module's
 * job, but the gate must not silently pass just because a future Node changed
 * the default back.
 *
 * @param {string} output - Runner output.
 * @param {string} name - Summary field, e.g. `pass`.
 * @returns {number|undefined} The count, when present.
 */
export function summaryValue(output, name) {
  const match = new RegExp(`^(?:ℹ|#)\\s+${name}\\s+(\\d+)\\s*$`, 'm').exec(output)
  return match === null ? undefined : Number(match[1])
}

/**
 * Run the suite and return both its output and its summary.
 *
 * @param {{directories?: readonly string[], env?: NodeJS.ProcessEnv, args?: readonly string[]}} [options] - Run options.
 * @returns {{code: number, output: string, tests?: number, pass?: number, fail?: number, skipped?: number, files: string[]}} Result.
 */
export function runSuite(options = {}) {
  const files = listTestFiles(options.directories ?? ['test'])
  if (files.length === 0) return { code: 1, output: 'no test files found\n', files }

  const run = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=spec', ...files, ...(options.args ?? [])],
    {
      cwd: REPO_ROOT,
      env: options.env ?? process.env,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      // The runner's output is captured for parsing and printed by the caller,
      // so it is not duplicated here.
      maxBuffer: 64 * 1024 * 1024,
    },
  )

  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  if (run.error !== undefined) return { code: 1, output: `${output}\ncould not run the suite: ${run.error.message}\n`, files }

  return {
    code: run.status ?? 1,
    output,
    files,
    tests: summaryValue(output, 'tests'),
    pass: summaryValue(output, 'pass'),
    fail: summaryValue(output, 'fail'),
    skipped: summaryValue(output, 'skipped'),
  }
}

/** Whether this file is the process entry point. */
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const result = runSuite({ directories: process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['test'] })
  process.stdout.write(result.output)
  if (result.files.length === 0) console.error('nothing matched — expected test files under test/')
  else console.error(`\nran ${result.files.length} file(s) from ${relative(REPO_ROOT, REPO_ROOT) || '.'}`)
  process.exit(result.code)
}
