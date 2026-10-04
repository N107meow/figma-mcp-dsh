#!/usr/bin/env node
/**
 * Dependency gate: two different questions, answered separately.
 *
 * ## 1. Can this repository resolve the host packages it imports?
 *
 * The plugin is installed into a DSH profile via `link:`. Node resolves imports
 * from the symlink's REAL PATH — this repo — and NOT from the profile's
 * `node_modules`, so these packages must be present here even though the host
 * also supplies them at runtime. Installing a different version does not fail
 * at load; it fails later, at tool-call time, as a type or behaviour mismatch.
 *
 * ## 2. Would the host actually accept this plugin?
 *
 * That is a **different** question, and conflating the two is how `0.1.0`
 * shipped: every local check was green, and the package was rejected the moment
 * a user installed it. DSH's own gate (`dsh-app-boot`) walks
 * `peerDependencies`, keeps only names that are `@deepseek-ai/dsh` or
 * `@deepseek-ai/dsh-*`, and asks whether the **DSH runtime version** satisfies
 * each range — not whether the repository's installed copy does.
 *
 * So both are checked here, and the summary says which one was verified. When
 * the runtime version cannot be determined, that is stated rather than papered
 * over: "resolvable" is not "acceptable".
 *
 * Usage:
 *   node scripts/check-deps.mjs [--runtime <dsh-version>]
 *
 * `--runtime` forces the version to judge against, which is how the matrix case
 * ("would this plugin still load on 0.3.0?") is tested without installing it.
 *
 * See docs/P0-IMPLEMENTATION.md §1.0.
 *
 * @module figma-mcp-dsh/scripts/check-deps
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Packages this plugin imports directly, and why.
 *
 * This is the resolvability list, not the judgment list — the host judges
 * ranges, and it decides which names count by a rule rather than a table. See
 * {@link DSH_PEER_FILTER}.
 */
const MODULES = [
  ['@deepseek-ai/dsh-tools', 'defineTool — tool definitions'],
  ['@deepseek-ai/schemastery', 'Config schema for the plugin entry'],
  ['@deepseek-ai/cordis', 'Context type (types only)'],
]

/** Package whose version IS the DSH runtime version, as the host computes it. */
const RUNTIME_PACKAGE = 'dsh-app-boot'

/**
 * Which peer names the host's compatibility gate looks at.
 *
 * Mirrors `dsh-app-boot`: `@deepseek-ai/dsh` itself, plus anything under the
 * `@deepseek-ai/dsh-` prefix. `@deepseek-ai/cordis` and
 * `@deepseek-ai/schemastery` are therefore *not* judged by the host, however
 * much they look like host packages — which is why the `0.1.0` rejection named
 * `dsh-tools` alone.
 *
 * @param {string} name - Peer dependency name.
 * @returns {boolean} Whether the host would judge this peer.
 */
function isJudgedPeer(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

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
 * @returns {Promise<any|undefined>} The module, or `undefined` when absent.
 */
async function loadSemver() {
  try {
    return await import('semver')
  } catch {
    return undefined
  }
}

/**
 * Read the version out of a package's `package.json`, following a resolved URL.
 *
 * @param {string} specifier - Package specifier to resolve.
 * @returns {{version: string, dir: string, file: string}|undefined} Facts, or `undefined` when unresolvable.
 */
function readPackage(specifier) {
  try {
    const file = fileURLToPath(import.meta.resolve(`${specifier}/package.json`))
    const version = JSON.parse(readFileSync(file, 'utf8')).version
    return { version: typeof version === 'string' ? version : '(unreadable)', dir: dirname(file), file }
  } catch {
    return undefined
  }
}

/**
 * Find the DSH runtime version, the way the host computes it.
 *
 * The deployment keeps every `@deepseek-ai/*` package side by side, so the
 * sibling of a resolved host package is where `dsh-app-boot` lives. Nothing is
 * assumed when it is absent: the caller reports that the host's verdict could
 * not be checked, instead of implying it was fine.
 *
 * @param {string|undefined} fromDir - Directory of a resolved host package.
 * @returns {string|undefined} Runtime version.
 */
function detectRuntimeVersion(fromDir) {
  if (fromDir === undefined) return undefined
  const candidate = join(dirname(fromDir), RUNTIME_PACKAGE, 'package.json')
  try {
    const version = JSON.parse(readFileSync(candidate, 'utf8')).version
    return typeof version === 'string' ? version : undefined
  } catch {
    return undefined
  }
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{runtime: string|undefined}} Parsed options.
 */
function parseArgs(argv) {
  let runtime
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--runtime') {
      runtime = argv[index + 1]
      index += 1
    } else if (arg.startsWith('--runtime=')) {
      runtime = arg.slice('--runtime='.length)
    } else {
      console.error(`unknown option "${arg}"\n\nusage: node scripts/check-deps.mjs [--runtime <dsh-version>]`)
      process.exit(2)
    }
  }
  return { runtime }
}

const { runtime: forcedRuntime } = parseArgs(process.argv.slice(2))
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const peers = manifest.peerDependencies ?? {}
const semver = await loadSemver()

/** @type {string[]} */
const problems = []

console.log('resolving host packages from this repository:\n')

/** @type {string|undefined} */
let firstResolvedDir
for (const [name, why] of MODULES) {
  const found = readPackage(name)
  let importable = true
  try {
    await import(name)
  } catch {
    importable = false
  }

  if (!importable || found === undefined) {
    problems.push(`${name} is not resolvable from this repository`)
    console.log(`  ❌ ${name.padEnd(30)} ${' '.repeat(12)} (${why})`)
    console.log(`     ${found === undefined ? 'could not read its package.json' : 'import failed'}`)
    continue
  }

  firstResolvedDir ??= found.dir
  console.log(`  ✅ ${name.padEnd(30)} ${found.version.padEnd(12)} (${why})`)
}

// ---------------------------------------------------------------------------
// Peer ranges: first that they are well-formed, then what the host would say.
// ---------------------------------------------------------------------------

const judged = Object.entries(peers).filter(([name]) => isJudgedPeer(name))
const runtime = forcedRuntime ?? detectRuntimeVersion(firstResolvedDir)

console.log('\npeer ranges:\n')
for (const [name, range] of Object.entries(peers)) {
  const label = `${name}@${range}`
  // An empty range is not "no constraint": the host rejects it outright
  // (`requirement.trim() === ""` → incompatible), while semver on its own reads
  // `""` as `*` and accepts everything. Checked before anything else, because
  // it is the one malformed range that looks like a pass.
  if (typeof range !== 'string' || range.trim() === '') {
    problems.push(`${name} has an empty peer range — the host treats that as incompatible`)
    console.log(`  ❌ ${label} — empty range`)
    continue
  }
  if (semver !== undefined && semver.validRange(range) === null) {
    problems.push(`${name} has an unparsable peer range "${range}"`)
    console.log(`  ❌ ${label} — not a valid semver range`)
    continue
  }
  if (!isJudgedPeer(name)) {
    console.log(`  ·  ${label} — not judged by the host (only @deepseek-ai/dsh and dsh-* are)`)
    continue
  }
  if (runtime === undefined) {
    console.log(`  ⚠️  ${label} — host verdict NOT checked (no runtime version)`)
    continue
  }
  // The host's own call, option for option: a prerelease runtime must satisfy a
  // range like `>=0.1.5-rc.2 <0.3.0-0`, and without includePrerelease semver
  // refuses every prerelease outright — the false negative that got 0.1.0
  // rejected at install time.
  const ok = semver === undefined ? undefined : semver.satisfies(runtime, range, { includePrerelease: true })
  if (ok === undefined) {
    console.log(`  ⚠️  ${label} — host verdict NOT checked (semver unavailable)`)
  } else if (ok) {
    console.log(`  ✅ ${label} — dsh ${runtime} satisfies it`)
  } else {
    problems.push(`the host would reject this plugin: dsh ${runtime} does not satisfy ${label}`)
    console.log(`  ❌ ${label} — dsh ${runtime} does NOT satisfy it`)
  }
}

// ---------------------------------------------------------------------------
// Repository alignment: the other half, and the one the host never looks at.
// ---------------------------------------------------------------------------

console.log('\nrepository alignment (what this checkout resolves):\n')
for (const [name, why] of MODULES) {
  const found = readPackage(name)
  const range = peers[name]
  if (found === undefined) continue // already reported above
  if (range === undefined) {
    // Imported but undeclared. The host judges ranges, so a missing range is a
    // missing judgement — and npm has nothing to install against. Silence here
    // would mean this whole section passes on an empty set.
    problems.push(`${name} is imported by this plugin but not declared in peerDependencies`)
    console.log(`  ❌ ${name.padEnd(30)} ${found.version} — not declared in peerDependencies`)
    continue
  }
  if (typeof range !== 'string' || range.trim() === '') continue // already reported above

  if (semver !== undefined && semver.valid(found.version) === null) {
    // A version that cannot be read cannot be judged, and a silent pass here is
    // how "installed something unexpected" stays invisible.
    problems.push(`${name}: could not read a version to test against ${range}`)
    console.log(`  ❌ ${name.padEnd(30)} (${why})`)
    console.log(`     the resolved version "${found.version}" is not a semver version`)
    continue
  }

  const ok = semver === undefined ? undefined : semver.satisfies(found.version, range, { includePrerelease: true })
  if (ok === false) {
    problems.push(`${name}: resolved ${found.version} does not satisfy ${range}`)
    console.log(`  ❌ ${name.padEnd(30)} ${found.version} does not satisfy ${range}`)
  } else {
    console.log(`  ✅ ${name.padEnd(30)} ${found.version} (${why})`)
  }
}

if (semver === undefined) {
  problems.push('semver is not installed, so no peer range could be tested')
  console.log(`
  ❌ semver is not installed, so no peer range could be tested.

     pnpm add -D semver
`)
}

if (problems.length > 0) {
  console.error(`
${problems.length} dependency problem(s):

${problems.map((problem) => `  - ${problem}`).join('\n')}

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

console.log('')
if (runtime === undefined) {
  console.log(`peer ranges: ${judged.map(([name, range]) => `${name}@${range}`).join('  ') || '(none judged by the host)'}`)
  console.log(
    'the versions this repository resolves satisfy every peer range — and that is all this proves.\n' +
      `The running deployment's version could not be determined (no ${RUNTIME_PACKAGE} next to the resolved host\n` +
      'packages), so whether DSH accepts the plugin at startup was NOT checked. Pass\n' +
      '`--runtime <version>` to answer that question.',
  )
} else {
  console.log(`peer ranges: ${judged.map(([name, range]) => `${name}@${range}`).join('  ') || '(none judged by the host)'}`)
  console.log(
    `the versions this repository resolves satisfy every peer range, and dsh ${runtime} would accept the plugin\n` +
      `at startup (checked the host's way: the runtime version against every @deepseek-ai/dsh* peer, prereleases included).`,
  )
}
