#!/usr/bin/env node
/**
 * Test-count gate: run the suite and assert what actually ran.
 *
 * ## Why a count is worth asserting
 *
 * `node --test` treats a skipped test as a pass. Every live Figma check in
 * `test/` skips itself when its environment variables are absent — which is the
 * normal state on a developer machine, and also exactly what a *misconfigured*
 * environment looks like. Without this gate, "the suite is green" cannot tell
 * the difference between "184 tests passed" and "170 passed and 14 were quietly
 * skipped", and a broken fixture path degrades into a green build.
 *
 * So the numbers are asserted. Changing them stays possible — it just becomes a
 * deliberate edit to this file instead of something that happens on its own.
 *
 * ## The environment is stripped before the run
 *
 * Every `FIGMA_*` variable is removed from the child process. `npm run verify`
 * must never reach Figma: a machine that exports a token globally would
 * otherwise spend its owner's monthly quota (Tier 1 is 20 requests/month on a
 * view seat) on a routine local check. Live runs go through `npm run test:real`,
 * which loads `.env.local` on purpose; nothing here weakens that path.
 *
 * @module figma-mcp-dsh/scripts/check-test-counts
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Lowest number of passing tests this repository ships.
 *
 * Raise it when tests are added. Lowering it is a decision worth explaining in
 * the commit message: it means coverage that used to run no longer does.
 */
const MIN_PASS = 184

/**
 * Tests skipped when no live fixtures are configured.
 *
 * Each one is a real Figma request that needs `.env.local`; see
 * `docs/TOKEN_SETUP.md` for which variables unlock which test. A change here
 * means a test started (or stopped) being gated, not that a test was deleted.
 */
const EXPECTED_SKIPPED = 14

/** Wall-clock ceiling for the whole run; the suite has a 24 s timing test. */
const TIMEOUT_MS = 10 * 60 * 1000

/**
 * Remove every Figma variable from the inherited environment.
 *
 * @param {NodeJS.ProcessEnv} source - Environment to filter.
 * @returns {{env: NodeJS.ProcessEnv, stripped: string[]}} Filtered environment and what was removed.
 */
function stripFigmaEnv(source) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {}
  /** @type {string[]} */
  const stripped = []
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('FIGMA_')) {
      stripped.push(key)
      continue
    }
    env[key] = value
  }
  return { env, stripped: stripped.sort() }
}

/**
 * Read one `ℹ <name> <count>` line from the test runner's summary.
 *
 * @param {string} output - Runner output.
 * @param {string} name - Summary field, e.g. `pass`.
 * @returns {number|undefined} The count, when present.
 */
function summaryValue(output, name) {
  const match = new RegExp(`^ℹ\\s+${name}\\s+(\\d+)\\s*$`, 'm').exec(output)
  return match === null ? undefined : Number(match[1])
}

const { env, stripped } = stripFigmaEnv(process.env)

console.log('running the test suite with Figma variables stripped:')
console.log(
  stripped.length === 0
    ? '  🔒 nothing to strip — no FIGMA_* variable was set in this environment'
    : `  🔒 stripped ${stripped.length}: ${stripped.join(', ')}`,
)
console.log('')

const run = spawnSync(process.execPath, ['--test', 'test/'], {
  cwd: REPO_ROOT,
  env,
  encoding: 'utf8',
  timeout: TIMEOUT_MS,
})

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
process.stdout.write(run.stdout ?? '')
if (run.stderr !== undefined && run.stderr !== '') process.stderr.write(run.stderr)

if (run.error !== undefined) {
  console.error(`\ncould not run the suite: ${run.error.message}`)
  process.exit(1)
}

const pass = summaryValue(output, 'pass')
const fail = summaryValue(output, 'fail')
const skipped = summaryValue(output, 'skipped')

if (pass === undefined || fail === undefined || skipped === undefined) {
  console.error('\n❌ could not read the test summary — did the runner change its output format?')
  process.exit(1)
}

/** @type {string[]} */
const problems = []
if (fail !== 0) problems.push(`${fail} test(s) failed`)
if (skipped !== EXPECTED_SKIPPED) {
  problems.push(
    `skipped ${skipped}, expected ${EXPECTED_SKIPPED} — a live test changed its gate. ` +
      'If that is intended, update EXPECTED_SKIPPED in this file and say why.',
  )
}
if (pass < MIN_PASS) {
  problems.push(
    `${pass} test(s) passed, expected at least ${MIN_PASS} — either tests were removed, or they ` +
      'are being skipped. If the suite legitimately shrank, lower MIN_PASS here and say why.',
  )
}

if (problems.length > 0) {
  console.error(`\n❌ test-count gate failed:`)
  for (const problem of problems) console.error(`   - ${problem}`)
  process.exit(1)
}

console.log(`\ntest counts as expected — pass ${pass} (≥ ${MIN_PASS}), fail 0, skipped ${skipped} (live data not configured).`)
