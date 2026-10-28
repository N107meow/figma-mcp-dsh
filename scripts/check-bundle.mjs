#!/usr/bin/env node
/**
 * Bundle-surface gate: will the plugin page accept this package?
 *
 * The DSH plugin manager only installs packages that declare `dsh.bundle` with a
 * usable patch file; anything else is refused as `not-a-bundle` before pnpm is
 * even asked to fetch it. `npm pack` will happily ship a package that fails that
 * check, so the only way to find out is on a user's machine — unless this gate
 * asks the same question first.
 *
 * It deliberately does not start DSH and does not parse YAML: it answers "does
 * the metadata and the patch *file* have the shape the manager requires". The
 * real loading proof is `scripts/verify-bundle.sh`; this is the cheap, offline
 * half that can run in `npm run verify` on every commit.
 *
 * Usage:
 *   node scripts/check-bundle.mjs [--root <dir>]
 *
 * `--root` exists so the gate can be tested: point it at a directory with a
 * deliberate defect and it must exit non-zero.
 *
 * Output contract (the tests assert it): problems go to **stderr**, the
 * per-check lines and the success summary go to **stdout**.
 *
 * @module figma-mcp-dsh/scripts/check-bundle
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** The Cordis row id this package inserts. Kept stable so existing overrides work. */
const EXPECTED_ROW_ID = 'figma'

/**
 * Parse the command line.
 *
 * @param {string[]} argv - Arguments after the script name.
 * @returns {{root: string}} Parsed options.
 */
function parseArgs(argv) {
  let root = REPO_ROOT
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[index + 1]
      if (value === undefined) {
        console.error('--root needs a directory\n\nusage: node scripts/check-bundle.mjs [--root <dir>]')
        process.exit(2)
      }
      root = resolve(value)
      index += 1
    } else {
      console.error(`unknown option "${arg}"\n\nusage: node scripts/check-bundle.mjs [--root <dir>]`)
      process.exit(2)
    }
  }
  return { root }
}

/**
 * Whether a relative path would be published by the `files` list.
 *
 * The real npm semantics are a small subset in practice: a literal path, or a
 * directory prefix. Globs and negations are not supported here on purpose —
 * this repository's `files` is a plain list, and pretending to support the rest
 * would make the gate wrong in a way nobody would notice.
 *
 * @param {unknown} files - `package.json`'s `files` value.
 * @param {string} target - Path relative to the package root, POSIX separators.
 * @returns {boolean} Whether npm would include it.
 */
function isCoveredByFiles(files, target) {
  if (files === undefined) return true // no `files` means "publish everything"
  if (!Array.isArray(files)) return false
  for (const entry of files) {
    if (typeof entry !== 'string') continue
    const clean = entry.replace(/^\.\//, '')
    if (clean === target) return true
    if (clean.endsWith('/') && (target === clean.slice(0, -1) || target.startsWith(clean))) return true
  }
  return false
}

/**
 * Check one patch file's path: relative, inside the package, a real file, and
 * published.
 *
 * @param {string} root - Package root.
 * @param {string} patch - The declared patch path.
 * @param {unknown} files - `package.json`'s `files` value.
 * @param {string[]} problems - Collector.
 * @returns {string|undefined} The file content when readable.
 */
function checkPatchFile(root, patch, files, problems) {
  if (isAbsolute(patch)) {
    problems.push(`dsh.bundle.patch "${patch}" is absolute; it must be relative to the package root`)
    return undefined
  }
  const absolute = resolve(root, patch)
  const relativePath = relative(root, absolute)
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    problems.push(`dsh.bundle.patch "${patch}" escapes the package root`)
    return undefined
  }

  const posix = relativePath.split(sep).join('/')
  let stats
  try {
    stats = statSync(absolute)
  } catch {
    problems.push(`dsh.bundle.patch "${patch}" does not exist (expected a file at ${posix})`)
    return undefined
  }
  if (!stats.isFile()) {
    problems.push(`dsh.bundle.patch "${patch}" is not a regular file`)
    return undefined
  }
  if (!isCoveredByFiles(files, posix)) {
    problems.push(
      `"${posix}" is not covered by "files", so it would not be in the tarball; ` +
        `add "${posix}" to files[] in package.json`,
    )
    return undefined
  }

  console.log(`  ✅ ${posix} exists and is covered by "files"`)
  try {
    return readFileSync(absolute, 'utf8')
  } catch (error) {
    problems.push(`"${posix}" could not be read: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * Check that the patch inserts the row the loader needs.
 *
 * Text matching, not YAML: the file is owned by this repository and its shape is
 * fixed, so a parser would add a dependency to learn nothing extra. Whether the
 * loader can actually read it is `scripts/verify-bundle.sh`'s question.
 *
 * @param {string} content - Patch file content.
 * @param {string} packageName - `package.json` name.
 * @param {string} shown - Path, for messages.
 * @param {string[]} problems - Collector.
 * @returns {boolean} Whether both lines were found.
 */
function checkPatchContent(content, packageName, shown, problems) {
  const idLine = /^[ \t]*-[ \t]+id:[ \t]*['"]?(?<id>[A-Za-z0-9._-]+)['"]?[ \t]*$/m.exec(content)
  const nameLine = new RegExp(
    `^[ \\t]*(?:-[ \\t]+)?name:[ \\t]*['"]?${packageName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}['"]?[ \\t]*$`,
    'm',
  ).exec(content)

  if (idLine === null) {
    problems.push(`${shown} has no "  - id: …" insert line; the plugin row would never be added`)
  } else if (idLine.groups?.id !== EXPECTED_ROW_ID) {
    problems.push(
      `${shown} inserts id "${idLine.groups?.id}", expected "${EXPECTED_ROW_ID}" — that id is the ` +
        'stable override target existing users already have in their cordis.patch.yml',
    )
  }
  if (nameLine === null) {
    problems.push(`${shown} has no "name: '${packageName}'" line; the loader resolves the module by it`)
  }
  if (idLine !== null && nameLine !== null && idLine.groups?.id === EXPECTED_ROW_ID) {
    console.log(`  ✅ inserts id=${EXPECTED_ROW_ID} name=${packageName}`)
    return true
  }
  return false
}

const { root } = parseArgs(process.argv.slice(2))
/** @type {string[]} */
const problems = []

let manifest
try {
  manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
} catch (error) {
  console.error(`bundle gate: cannot read ${join(root, 'package.json')}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const name = typeof manifest.name === 'string' ? manifest.name : '(unnamed)'
const version = typeof manifest.version === 'string' ? manifest.version : '(unversioned)'
console.log(`bundle gate: ${name}@${version}`)

const bundle = manifest.dsh !== null && typeof manifest.dsh === 'object' ? manifest.dsh.bundle : undefined
if (bundle === undefined) {
  problems.push(
    'package.json has no "dsh.bundle" — the plugin manager would refuse this package as not-a-bundle. ' +
      'Add "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }.',
  )
} else {
  const declared = bundle.patch
  /** @type {string[]|undefined} */
  const patches =
    typeof declared === 'string' ? [declared] : Array.isArray(declared) && declared.every((p) => typeof p === 'string') ? declared : undefined

  if (patches === undefined) {
    problems.push('"dsh.bundle.patch" must be a string or an array of strings')
  } else if (patches.length === 0) {
    problems.push('"dsh.bundle.patch" is an empty array; nothing would be applied')
  } else {
    console.log(`  ✅ dsh.bundle.patch → ${patches.map((p) => JSON.stringify(p)).join(', ')}`)
    for (const patch of patches) {
      const content = checkPatchFile(root, patch, manifest.files, problems)
      if (content !== undefined) checkPatchContent(content, name, patch, problems)
    }
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} bundle problem(s):\n`)
  for (const problem of problems) console.error(`  ✖ ${problem}`)
  console.error(
    '\nA user installing this package through Settings → Plugins or `dsh plugin add` would hit these.\n' +
      'See docs/EXECUTION-DUAL-EDITION.md §3.3 and scripts/verify-bundle.sh for the real loading proof.',
  )
  process.exit(1)
}

console.log('\nbundle surface OK')
