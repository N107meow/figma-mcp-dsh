/**
 * Adapter-layer checks.
 *
 * These do not need a running host: `defineTool` and the config schema are pure
 * functions, and the tools' `execute` bodies are plain JavaScript. What they
 * check is the wiring — that the public entry matches the adapter, that the
 * declared tools are the two the design promises, and that the config schema
 * accepts an empty row and fills in the weakest-seat defaults.
 *
 * @module figma-mcp-dsh/test/adapter
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import * as adapter from '../../src/adapter/index.js'
import * as entry from '../../lib/index.js'
import { Config } from '../../src/adapter/config.js'
import { createHarness } from '../support/harness.js'
import { registerFigmaTools } from '../../src/adapter/tools.js'
import { DEFAULT_RATE_LIMITS } from '../../src/core/scheduler.js'

test('the public entry re-exports the adapter exactly', () => {
  assert.equal(entry.name, adapter.name)
  assert.equal(entry.apply, adapter.apply)
  assert.equal(entry.inject, adapter.inject)
  assert.equal(entry.Config, adapter.Config)

  // The four checks above are name-by-name identity checks, and identity is not
  // the same claim as "exactly". Two silent degradations slip past them: delete
  // a field from both sides and the remaining assertions still pass, and add a
  // new adapter export that `lib/` never forwards and nothing notices — the
  // forwarding layer is then stale while the suite stays green.
  //
  // The pair below is what makes the test's "exactly" true. The first line
  // freezes the expected set, so a coordinated deletion fails; the second
  // compares against the adapter's real keys, so a missed or extra re-export
  // fails. `lib/index.js` and this test are the only things keeping the
  // committed entry point honest, so both directions are pinned.
  assert.deepEqual(Object.keys(entry).sort(), ['Config', 'apply', 'inject', 'name'])
  assert.deepEqual(Object.keys(entry).sort(), Object.keys(adapter).sort())
})

test('the plugin declares the name and hard dependencies the wiring expects', () => {
  assert.equal(entry.name, 'figma')
  assert.deepEqual([...entry.inject], ['tools', 'credentials'])
})

test('the config schema accepts an empty row and fills in conservative defaults', () => {
  const resolved = Config({})
  assert.equal(resolved.credentialRef, 'FIGMA_TOKEN')
  assert.equal(resolved.cacheTtlMs, 60_000)
  assert.equal(resolved.maxResultBytes, 262_144)
  assert.equal(resolved.budgetTokens, 8_000)
  assert.equal(resolved.spoolDir, '.figma')
  assert.deepEqual(resolved.rateLimits.tier1, { perMinute: 5, burst: 1 })
  assert.deepEqual(resolved.rateLimits.tier2, DEFAULT_RATE_LIMITS.tier2)
  assert.deepEqual(resolved.rateLimits.tier3, DEFAULT_RATE_LIMITS.tier3)
})

test('the config schema only replaces what the row actually sets', () => {
  const resolved = Config({ credentialRef: 'MY_FIGMA_TOKEN', rateLimits: { tier1: { perMinute: 30 } } })
  assert.equal(resolved.credentialRef, 'MY_FIGMA_TOKEN')
  assert.equal(resolved.rateLimits.tier1.perMinute, 30)
  assert.equal(resolved.rateLimits.tier1.burst, 1)
  assert.equal(resolved.rateLimits.tier2.perMinute, 10)
})

/**
 * Build a minimal tool registry that records registrations.
 *
 * @returns {{ctx: any, registered: Array<any>}} Fake context and its registrations.
 */
function fakeContext() {
  const registered = []
  return {
    registered,
    ctx: {
      tools: {
        register(definition) {
          registered.push(definition)
          return () => {}
        },
      },
    },
  }
}

test('exactly the two documented tools are registered, and they are wired to the provider', async () => {
  const { ctx, registered } = fakeContext()
  const { provider } = createHarness({})
  registerFigmaTools(ctx, { provider })

  assert.deepEqual(
    registered.map((definition) => definition.name),
    ['figma_capabilities', 'figma_call'],
  )
  for (const definition of registered) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 80, 'the description is what the model chooses on')
    assert.equal(typeof definition.execute, 'function')
    assert.ok(definition.output !== undefined)
  }
})

test('figma_capabilities renders the directory as text', async () => {
  const { ctx, registered } = fakeContext()
  const { provider } = createHarness({})
  registerFigmaTools(ctx, { provider })
  const tool = registered.find((definition) => definition.name === 'figma_capabilities')

  const value = await tool.execute({ detail: 'names' }, { signal: new AbortController().signal })
  assert.equal(typeof value, 'string')
  assert.match(value, /Figma capabilities/)
  assert.match(value, /file_nodes/)
})

test('figma_call forwards only declared fields, keeping execution context out of the arguments', async () => {
  const seen = []
  const { ctx, registered } = fakeContext()
  registerFigmaTools(ctx, {
    provider: {
      async call(input) {
        seen.push(input)
        return { structuredContent: { op: input.op, ok: true, value: {}, meta: {} }, content: [{ type: 'text', text: 'ok' }], meta: {} }
      },
    },
  })
  const tool = registered.find((definition) => definition.name === 'figma_call')
  const signal = new AbortController().signal

  await tool.execute({ op: 'file_meta', args: { fileKey: 'k' }, target: 'k', max_bytes: 10, format: 'summary' }, { signal })

  assert.equal(seen.length, 1)
  assert.deepEqual(Object.keys(seen[0]).sort(), ['args', 'cwd', 'format', 'max_bytes', 'op', 'signal', 'target'])
  assert.equal(seen[0].signal, signal)
})

test('figma_call renders the provider content blocks, including images, unchanged', async () => {
  const { ctx, registered } = fakeContext()
  const attachment = { attachmentId: 'a', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
  registerFigmaTools(ctx, {
    provider: {
      async call() {
        return {
          structuredContent: { op: 'image_render', ok: true, value: {}, meta: { attached: 1 } },
          content: [{ type: 'text', text: 'rendered' }, { type: 'image', attachment }],
          meta: { attached: 1 },
        }
      },
    },
  })
  const tool = registered.find((definition) => definition.name === 'figma_call')
  const value = await tool.execute({ op: 'image_render' }, { signal: new AbortController().signal })
  const blocks = tool.output.render({}, value)

  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[1], { type: 'image', attachment })
  assert.deepEqual(tool.output.presentationMeta({}, value), { attached: 1 })
})

test('the renderer is total, so a replayed payload cannot crash a card', () => {
  const { ctx, registered } = fakeContext()
  registerFigmaTools(ctx, { provider: createHarness({}).provider })
  const tool = registered.find((definition) => definition.name === 'figma_call')

  for (const value of [undefined, null, 'text', {}, { content: [] }]) {
    const blocks = tool.output.render({}, value)
    assert.ok(Array.isArray(blocks) && blocks.length > 0)
    assert.equal(blocks[0].type, 'text')
  }
})
