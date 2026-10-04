/**
 * Unload-path checks.
 *
 * `apply()` registers two tools and then **throws the disposers away**. That is
 * deliberate: `ctx.tools.register` is itself a context-owned effect, so the host
 * unregisters both tools when the plugin unloads. Nothing in this repository
 * proved that, though — the registry fake in `adapter.test.js` returns an empty
 * disposer and has no `ctx.effect` at all, so a host that stopped tying
 * registrations to the caller's fiber would leave every test green and leak two
 * tools on every reload.
 *
 * The mock below mirrors the real mechanism, read out of the installed host
 * source rather than guessed:
 *
 * - `ToolRuntime.register` (`dsh-tools/lib/index.js:2878-2887`) is
 *   `this.layers.effect(this.ctx, layer => layer.tools.insert(name, def))`.
 * - `ScopedLayers.effect` (`dsh-scope/lib/index.js:189-218`) hands a generator to
 *   `ctx.effect`, and cordis attaches that effect to the **calling** context's
 *   fiber (`cordis/lib/index.js:128, 140-142, 1248`) — the service tracker makes
 *   `this.ctx` the caller's ctx.
 * - Unloading runs `Fiber._unload` (`cordis/lib/index.js:1372-1383`) over that
 *   fiber's disposables, which executes the generator's yielded undo and deletes
 *   the entry.
 *
 * A mock that did not mirror this would pin a contract that does not exist,
 * which is worse than pinning nothing.
 *
 * @module figma-mcp-dsh/test/adapter/unload
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Config, apply } from '../../src/adapter/index.js'
import { registerFigmaTools } from '../../src/adapter/tools.js'

/**
 * A plugin context whose effect semantics match the host's.
 *
 * `tools.register` records the tool and returns an undo; `effect` collects the
 * undo on the context's own stack; `unload` drains that stack in reverse, the
 * way a fiber does.
 *
 * @returns {{ctx: any, tools: Map<string, any>, effectLabels: string[], unload: () => void}} Fake context.
 */
function createFakeContext() {
  /** @type {Map<string, any>} */
  const tools = new Map()
  /** @type {string[]} */
  const effectLabels = []
  /** @type {Array<() => void>} */
  const disposers = []

  /** @type {any} */
  const ctx = {
    tools: {
      get: (name) => tools.get(name),
      register(definition) {
        // The registration IS the effect, exactly as in dsh-tools: the undo is
        // owned by this ctx, not by whichever caller kept the return value.
        return ctx.effect(() => {
          tools.set(definition.name, definition)
          return () => {
            tools.delete(definition.name)
          }
        }, 'tools.register()')
      },
    },
    effect(fn, label) {
      effectLabels.push(label ?? '(unlabeled)')
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    credentials: { resolve: async () => ({ value: undefined }) },
    get: () => undefined,
  }

  return {
    ctx,
    tools,
    effectLabels,
    unload() {
      for (const dispose of [...disposers].reverse()) dispose()
      disposers.length = 0
    },
  }
}

test('apply registers exactly two tools, each as a context-owned effect', () => {
  const fake = createFakeContext()
  apply(fake.ctx, Config({}))

  assert.deepEqual([...fake.tools.keys()].sort(), ['figma_call', 'figma_capabilities'])
  // Two registrations plus the activation marker. Asserting the count is what
  // makes "everything apply() touches is owned by ctx" testable: a registration
  // that stopped going through `ctx.effect` would change it.
  assert.deepEqual(
    fake.effectLabels.filter((label) => label === 'tools.register()'),
    ['tools.register()', 'tools.register()'],
  )
  assert.equal(fake.effectLabels.length, 3)
})

test('unloading the plugin leaves no registered tools behind', () => {
  const fake = createFakeContext()
  const before = [...fake.tools.keys()]

  apply(fake.ctx, Config({}))
  assert.equal(fake.tools.size, 2, 'the load itself must register both tools')

  fake.unload()

  assert.deepEqual([...fake.tools.keys()], before)
  assert.equal(fake.tools.get('figma_call'), undefined)
  assert.equal(fake.tools.get('figma_capabilities'), undefined)
})

test('both tools execute against the same provider instance', async () => {
  // One provider per plugin instance, not one per tool: the cache, the rate
  // limit buckets, and the rejected-credential memory all live in it, and each
  // of those is a correctness device rather than an optimisation. A second
  // provider would silently duplicate all three.
  const fake = createFakeContext()
  /** @type {string[]} */
  const seen = []
  const provider = {
    async listCapabilities() {
      seen.push('listCapabilities')
      return { text: 'Figma capabilities — 0 of 0 shown.', ops: [], total: 0, groups: [], detail: 'names' }
    },
    async call(input) {
      seen.push(`call:${input.op}`)
      return {
        structuredContent: { op: input.op, ok: true, value: {}, meta: {} },
        content: [{ type: 'text', text: 'ok' }],
        meta: {},
      }
    },
  }

  registerFigmaTools(fake.ctx, { provider })
  const signal = new AbortController().signal

  await fake.tools.get('figma_capabilities').execute({ detail: 'names' }, { signal })
  await fake.tools.get('figma_call').execute({ op: 'file_meta', args: { fileKey: 'SyntheticFileKey000001' } }, { signal })

  // Both calls landed on the one object that was handed in.
  assert.deepEqual(seen, ['listCapabilities', 'call:file_meta'])
})
