/**
 * The bundle gate has to be able to fail.
 *
 * `check:bundle` exists because `npm pack` will happily ship a package the DSH
 * plugin manager refuses as `not-a-bundle`; the user finds out when the Install
 * button does nothing. A gate that has never rejected anything is only known to
 * be quiet, so each failure mode below is exercised against a real temporary
 * package with exactly that defect.
 *
 * The fixtures are written at run time rather than committed: a permanent
 * "broken bundle" fixture in `test/` would be a package.json that no other tool
 * should ever pick up.
 *
 * @module figma-mcp-dsh/test/adapter/bundle
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const run = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = 'scripts/check-bundle.mjs'

/**
 * Run the gate against one directory.
 *
 * @param {string} root - Directory to check.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} Exit code and output.
 */
async function check(root) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, '--root', root], { cwd: REPO_ROOT })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = /** @type {{code?: number, stdout?: string, stderr?: string}} */ (error)
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

/**
 * Create a temporary package and run a callback against it.
 *
 * @param {Record<string, string>} files - Relative path → content.
 * @param {(directory: string) => Promise<void>} body - Callback receiving the package root.
 * @returns {Promise<void>} Resolves when the callback and cleanup finish.
 */
async function withPackage(files, body) {
  const directory = await mkdtemp(join(tmpdir(), 'figma-bundle-'))
  try {
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(directory, path), content, 'utf8')
    }
    await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** A minimal bundle-shaped manifest, as JSON text. */
function manifest(overrides = {}) {
  return JSON.stringify(
    {
      name: 'figma-mcp-dsh',
      version: '0.2.0',
      files: ['index.js', 'cordis.patch.yml'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      ...overrides,
    },
    null,
    2,
  )
}

test('the real repository passes', async () => {
  const { code, stdout } = await check(REPO_ROOT)
  assert.equal(code, 0, stdout)
  assert.match(stdout, /bundle surface OK/)
  assert.match(stdout, /inserts id=figma name=figma-mcp-dsh/)
})

test('a package without dsh.bundle is rejected', async () => {
  await withPackage(
    {
      'package.json': manifest({ dsh: undefined }),
      'index.js': 'export const x = 1\n',
      'cordis.patch.yml': '- insert:\n    - id: figma\n      name: figma-mcp-dsh\n',
    },
    async (directory) => {
      const { code, stderr } = await check(directory)
      assert.equal(code, 1)
      assert.match(stderr, /dsh\.bundle/)
      assert.match(stderr, /not-a-bundle/)
    },
  )
})

test('a patch that "files" does not publish is rejected', async () => {
  // The package looks complete in the working tree — and ships without the
  // patch, so every install would fail on the user's machine instead of here.
  await withPackage(
    {
      'package.json': manifest({ files: ['index.js'] }),
      'index.js': 'export const x = 1\n',
      'cordis.patch.yml': '- insert:\n    - id: figma\n      name: figma-mcp-dsh\n',
    },
    async (directory) => {
      const { code, stderr } = await check(directory)
      assert.equal(code, 1)
      assert.match(stderr, /not covered by "files"/)
      assert.match(stderr, /cordis\.patch\.yml/)
    },
  )
})

test('a patch with no insert row is rejected', async () => {
  await withPackage(
    {
      'package.json': manifest(),
      'index.js': 'export const x = 1\n',
      'cordis.patch.yml': '- insert: []\n',
    },
    async (directory) => {
      const { code, stderr } = await check(directory)
      assert.equal(code, 1)
      assert.match(stderr, /no "  - id: …"/)
      assert.match(stderr, /figma-mcp-dsh/)
    },
  )
})
