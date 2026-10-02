#!/usr/bin/env node
/**
 * Check that the host packages this plugin imports are resolvable **from this
 * repository**, and that their versions line up with the deployment's.
 *
 * Why resolvability matters: the plugin is installed into a DSH profile via
 * `link:`. Node resolves imports from the symlink's REAL PATH — this repo — and
 * NOT from the profile's `node_modules`. So these packages must be present here
 * even though the host also supplies them at runtime.
 *
 * Why the version check matters more than it looks: `defineTool`, the config
 * schema contract, and the credential seam all come from the host. Installing a
 * different version does not fail at load — it fails later, at tool-call time,
 * as a type or behaviour mismatch. So every resolved version is tested against
 * its `peerDependencies` range with `{ includePrerelease: true }` — the same
 * call DSH's own compatibility gate makes (`dsh-app-boot`), with the same
 * option — and a version outside the range fails the check instead of becoming
 * a footnote.
 *
 * The peer ranges are therefore not decoration: they are what the host reads at
 * startup to decide whether to load this plugin at all. A range that is too
 * narrow disables the plugin (`is incompatible with dsh <version>`); too wide
 * and the host stops protecting anyone from a breaking upgrade.
 *
 * See docs/P0-IMPLEMENTATION.md §1.0.
 *
 * @module figma-mcp-dsh/scripts/check-deps
 */

import { readFileSync } from 'node:fs'

const MODULES = [
  ['@deepseek-ai/dsh-tools', 'defineTool — tool definitions'],
  ['@deepseek-ai/schemastery', 'Config schema for the plugin entry'],
  ['@deepseek-ai/cordis', 'Context type (types only)'],
]

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const peers = manifest.peerDependencies ?? {}

/**
 * Load `semver`, the implementation DSH's own compatibility gate calls.
 *
 * Taken from this repository's own dependencies rather than from the running
 * deployment on purpose: a gate whose verdict changes with whatever DSH happens
 * to be installed next to it is not a gate. `semver` is a dev dependency, so it
 * never reaches the published package.
 *
 * Loaded dynamically so that a missing dev dependency produces an actionable
 * message instead of a module-resolution stack trace — this script's first job
 * is telling you what to install.
 *
 * @returns {Promise<{satisfies: Function, valid: Function}|undefined>} The module, or `undefined` when absent.
 */
async function loadSemver() {
  try {
    return await import('semver')
  } catch {
    return undefined
  }
}

const semver = await loadSemver()

let failed = 0
console.log('resolving host packages from this repository:\n')

for (const [name, why] of MODULES) {
  let version = '(unknown)'
  try {
    const resolved = new URL(import.meta.resolve(`${name}/package.json`))
    version = JSON.parse(readFileSync(resolved, 'utf8')).version
  } catch {
    // package.json may not be exported; fall through to a bare import check
  }

  try {
    await import(name)
    console.log(`  ✅ ${name.padEnd(30)} ${version.padEnd(12)} (${why})`)

    const expected = peers[name]
    if (expected === undefined || semver === undefined) continue

    if (semver.valid(version) === null) {
      // Not a mismatch: a version that cannot be read cannot be judged, and
      // inventing a verdict for it would be worse than saying so.
      console.log(`     ⚠️  could not read a version to test against ${expected}`)
      continue
    }

    // `includePrerelease` is not optional here: `0.2.0-rc.2` must satisfy a
    // range like `>=0.1.5-rc.2 <0.3.0-0`, and without this option semver
    // refuses every prerelease outright — the exact false negative that made
    // the host disable this plugin at startup.
    if (!semver.satisfies(version, expected, { includePrerelease: true })) {
      failed++
      console.log(`     ❌ version mismatch: resolved ${version}, but peerDependencies asks for ${expected}`)
    }
  } catch (error) {
    failed++
    console.log(`  ❌ ${name.padEnd(30)} ${' '.repeat(12)} (${why})`)
    console.log(`     ${error.code ?? error.message}`)
  }
}

if (semver === undefined) {
  failed++
  console.log(`
  ❌ semver is not installed, so no peer range could be tested.

     pnpm add -D semver
`)
}

if (failed > 0) {
  console.error(`
${failed} host package problem(s).

Fix — read the versions off your own deployment rather than trusting npm's
\`latest\` tag, which lags behind what ships:

  D=<deployment>/node_modules/@deepseek-ai
  for p in dsh-tools schemastery cordis; do
    node -p "require('$D/$p/package.json').version"
  done

  pnpm add -D @deepseek-ai/dsh-tools@<version> \\
             @deepseek-ai/schemastery@<version> \\
             @deepseek-ai/cordis@<version>
`)
  process.exit(1)
}

console.log(`\npeer ranges: ${MODULES.map(([name]) => `${name}@${peers[name] ?? '—'}`).join('  ')}`)
console.log('all host packages resolvable and version-aligned — safe to continue.')
