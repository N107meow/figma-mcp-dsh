/**
 * The provider, end to end, with an injected transport and clock.
 *
 * These are the cases where a mistake is silent: a missing depth guard returns
 * a megabyte instead of an error, a wrong credential classification sends the
 * model into a retry loop, and an unredacted token ends up in a transcript.
 *
 * @module figma-mcp-dsh/test/core/provider
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ReadOnlyViolationError } from '../../src/core/errors.js'
import { createTokenSource } from '../../src/core/auth.js'
import { createProvider } from '../../src/core/provider.js'
import { DEFAULT_RATE_LIMITS } from '../../src/core/scheduler.js'
import { createMemorySpool } from '../../src/core/spool-sink.js'
import { fileMeta, fileNodes } from '../../src/core/specs/files.js'
import { syntheticFile, syntheticNodes } from '../fixtures/synthetic.js'
import { TEST_TOKEN, createFetchStub, createHarness, jsonResponse, textOf } from '../support/harness.js'

/** A file key that appears nowhere real. */
const KEY = 'SyntheticFileKey000001'

/**
 * A transport that answers each endpoint with its synthetic payload.
 *
 * @param {{meta?: () => unknown, nodes?: () => unknown}} [overrides] - Per-endpoint payload overrides.
 * @returns {ReturnType<typeof createFetchStub>} Stub.
 */
function routeAll(overrides = {}) {
  return createFetchStub(({ path }) => {
    if (path.endsWith('/nodes')) return jsonResponse(overrides.nodes?.() ?? syntheticNodes())
    if (path.endsWith('/meta')) return jsonResponse(overrides.meta?.() ?? { name: 'Synthetic file', version: '1', role: 'owner' })
    if (path.includes('/v1/images/')) return jsonResponse({ err: null, images: { '10:20': 'https://signed.example.test/a.png' } })
    if (path.startsWith('/v1/files/')) return jsonResponse(syntheticFile())
    return jsonResponse({ err: 'unexpected path' }, { status: 404 })
  })
}

test('a pasted link resolves to a file key and a node id, and ids without depth gains depth=2', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })

  const result = await provider.call({
    op: 'file_nodes',
    target: `https://www.figma.com/design/${KEY}/Synthetic?node-id=10-20&t=tracking`,
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, `/v1/files/${KEY}/nodes`)
  assert.equal(calls[0].search.get('ids'), '10:20')
  assert.equal(calls[0].search.get('depth'), '2')
  assert.equal(result.structuredContent.ok, true)
})

test('an explicit depth is honored', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  await provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['10:20'], depth: 4 } })
  assert.equal(calls[0].search.get('depth'), '4')
})

test('a shallow read of the whole file is bounded by the same default', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  await provider.call({ op: 'file', args: { fileKey: KEY } })
  assert.equal(calls[0].search.get('depth'), '2')
})

test('a link node id never narrows the whole-file capability', async () => {
  // Regression, found by a live call: copying the link's node id into the
  // optional `ids` pruned the response to that node's ancestry, and at the
  // default depth the requested node itself was cut off — three nodes that look
  // like a file containing one frame.
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  const result = await provider.call({ op: 'file', target: `https://www.figma.com/design/${KEY}/Doc?node-id=10-3` })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].search.get('ids'), null)
  assert.equal(calls[0].search.get('depth'), '2')
  assert.equal(result.structuredContent.ok, true)
  assert.match(/** @type {string[]} */ (result.meta.notes)[0], /node 10:3/)
  assert.match(/** @type {string[]} */ (result.meta.notes)[0], /Use "file_nodes" to read that node/)
})

test('a link node id fills the drill-down capability, which requires it', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  await provider.call({ op: 'file_nodes', target: `https://www.figma.com/design/${KEY}/Doc?node-id=10-3` })
  assert.equal(calls[0].search.get('ids'), '10:3')
})

test('an explicit args.ids still wins over the link, and the note says so', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  const result = await provider.call({
    op: 'file_nodes',
    target: `https://www.figma.com/design/${KEY}/Doc?node-id=99-99`,
    args: { fileKey: KEY, ids: ['1:2'] },
  })
  assert.equal(calls[0].search.get('ids'), '1:2')
  assert.match(/** @type {string[]} */ (result.meta.notes)[0], /explicit arguments win/)
})

test('an undeclared op is refused with the available list', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  const result = await provider.call({ op: 'delete_everything' })
  assert.equal(calls.length, 0)
  assert.equal(result.structuredContent.ok, false)
  const error = /** @type {Record<string, any>} */ (result.structuredContent.error)
  assert.equal(error.kind, 'bad_op')
  assert.deepEqual(error.available, ['file', 'file_nodes', 'file_meta', 'image_render', 'components', 'component_sets', 'styles'])
})

test('an unparsable target is refused before any request', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  const result = await provider.call({ op: 'file_meta', target: 'https://example.com/design/abc/def' })
  assert.equal(calls.length, 0)
  assert.equal(/** @type {Record<string, any>} */ (result.structuredContent.error).field, 'target')
})

test('a capability that is not a GET is refused at dispatch even if it is in the table', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({
    fetchImpl,
    specs: [{ ...fileNodes, name: 'file_write', method: /** @type {any} */ ('POST') }],
  })
  await assert.rejects(provider.call({ op: 'file_write', args: { fileKey: KEY, ids: ['1:2'] } }), ReadOnlyViolationError)
  assert.equal(calls.length, 0)
})

test('401 becomes token_invalid with executable steps, and is not retried', async () => {
  const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ status: 401, err: 'Invalid token' }, { status: 401 }))
  const { provider } = createHarness({ fetchImpl })
  const result = await provider.call({ op: 'file_meta', args: { fileKey: KEY } })

  assert.equal(calls.length, 1, 'a credential failure must not be retried')
  const error = /** @type {Record<string, any>} */ (result.structuredContent.error)
  assert.equal(error.kind, 'token_invalid')
  assert.match(error.remedy, /https:\/\/www\.figma\.com\/settings/)
  assert.match(error.remedy, /file_content:read, file_metadata:read/)
  assert.match(error.remedy, /refs\.FIGMA_TOKEN/)
  assert.match(error.remedy, /retry the operation/)
  // Channel A: the model must receive a successful result, not a thrown error.
  assert.equal(result.content[0].type, 'text')
})

test('a credential already rejected in this process fails immediately without another request', async () => {
  const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ status: 401, err: 'Invalid token' }, { status: 401 }))
  const { provider } = createHarness({ fetchImpl })

  await provider.call({ op: 'file_meta', args: { fileKey: KEY } })
  const second = await provider.call({ op: 'file_meta', args: { fileKey: KEY } })

  assert.equal(calls.length, 1, 'the memoized rejection must not spend a request')
  assert.equal(/** @type {Record<string, any>} */ (second.structuredContent.error).kind, 'token_invalid')
  assert.match(/** @type {Record<string, any>} */ (second.structuredContent.error).remedy, /already rejected/)
})

test('a new credential recovers on the very next call', async () => {
  let reject = true
  const { fetchImpl, calls } = createFetchStub(() =>
    reject ? jsonResponse({ status: 401, err: 'Invalid token' }, { status: 401 }) : jsonResponse({ version: '1' }),
  )
  const harness = createHarness({ fetchImpl })

  await harness.provider.call({ op: 'file_meta', args: { fileKey: KEY } })
  reject = false
  harness.setToken('figd_REPLACEMENTTOKEN0987654321')
  const result = await harness.provider.call({ op: 'file_meta', args: { fileKey: KEY } })

  assert.equal(calls.length, 2)
  assert.equal(result.structuredContent.ok, true)
})

test('403 with a scope complaint becomes forbidden_scope with the granted scopes parsed out', async () => {
  const body = { error: true, status: 403, message: 'Invalid scope(s): file_content:read, file_comments:read' }
  const { fetchImpl, calls } = createFetchStub(() => jsonResponse(body, { status: 403 }))
  const { provider } = createHarness({ fetchImpl })
  const result = await provider.call({ op: 'file_meta', args: { fileKey: KEY } })

  assert.equal(calls.length, 1, 'a scope failure must not be retried')
  const error = /** @type {Record<string, any>} */ (result.structuredContent.error)
  assert.equal(error.kind, 'forbidden_scope')
  assert.deepEqual(error.granted, ['file_content:read', 'file_comments:read'])
  assert.deepEqual(error.missing, ['file_metadata:read'])
  assert.match(error.remedy, /Retrying will not help/)
})

test('the other scope wording Figma uses is parsed the same way', async () => {
  const body = { status: 403, message: 'Invalid scope: [file_content:read]' }
  const { fetchImpl } = createFetchStub(() => jsonResponse(body, { status: 403 }))
  const { provider } = createHarness({ fetchImpl })
  const result = await provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['1:2'] } })
  const error = /** @type {Record<string, any>} */ (result.structuredContent.error)
  assert.equal(error.kind, 'forbidden_scope')
  assert.deepEqual(error.granted, ['file_content:read'])
})

test('403 without a scope complaint is treated as a credential failure', async () => {
  const { fetchImpl } = createFetchStub(() => jsonResponse({ status: 403, message: 'Token expired' }, { status: 403 }))
  const { provider } = createHarness({ fetchImpl })
  const result = await provider.call({ op: 'file_meta', args: { fileKey: KEY } })
  assert.equal(/** @type {Record<string, any>} */ (result.structuredContent.error).kind, 'token_invalid')
})

test('429 waits for Retry-After, stays inside maxAttempts, and recalibrates the bucket', async () => {
  const { fetchImpl, calls } = createFetchStub(({ index }) =>
    index < 2
      ? jsonResponse({ status: 429 }, { status: 429, headers: { 'retry-after': '2', 'x-figma-rate-limit-type': 'high' } })
      : jsonResponse({ version: '1' }),
  )
  const harness = createHarness({ fetchImpl })
  const result = await harness.provider.call({ op: 'file_meta', args: { fileKey: KEY } })

  assert.equal(result.structuredContent.ok, true)
  assert.equal(calls.length, 3)
  assert.equal(harness.provider.stats().retries, 2)
  // The fake clock advanced by exactly the two server-specified delays.
  assert.equal(harness.clock.now() - 1_700_000_000_000, 4_000)
  const tier3 = /** @type {Record<string, any>} */ (harness.provider.stats().limits.tier3)
  assert.deepEqual(tier3.calibrations, ['high', 'high'])
  assert.equal(tier3.limit, 60)
})

test('a persistent 429 gives up at maxAttempts and reports the wait', async () => {
  const { fetchImpl, calls } = createFetchStub(() =>
    jsonResponse({ status: 429 }, { status: 429, headers: { 'retry-after': '1', 'x-figma-rate-limit-type': 'low' } }),
  )
  const harness = createHarness({ fetchImpl })
  const result = await harness.provider.call({ op: 'file_meta', args: { fileKey: KEY } })

  assert.equal(calls.length, 3, 'maxAttempts is 3')
  const error = /** @type {Record<string, any>} */ (result.structuredContent.error)
  assert.equal(error.kind, 'rate_limited')
  assert.equal(error.retryAfterSec, 1)
  assert.equal(error.limitType, 'low')
  assert.match(error.remedy, /view\/collaborator seat/)
})

test('a 500 is retried and a 404 is not', async () => {
  let attempts = 0
  const server = createFetchStub(() => {
    attempts += 1
    return attempts < 2 ? jsonResponse({ err: 'boom' }, { status: 503 }) : jsonResponse({ version: '1' })
  })
  const ok = createHarness({ fetchImpl: server.fetchImpl })
  assert.equal((await ok.provider.call({ op: 'file_meta', args: { fileKey: KEY } })).structuredContent.ok, true)

  const missing = createFetchStub(() => jsonResponse({ err: 'Not found' }, { status: 404 }))
  const notFound = createHarness({ fetchImpl: missing.fetchImpl })
  const result = await notFound.provider.call({ op: 'file_meta', args: { fileKey: KEY } })
  assert.equal(missing.calls.length, 1)
  assert.equal(/** @type {Record<string, any>} */ (result.structuredContent.error).kind, 'not_found')
})

test('an unconfigured credential produces instructions, not a request', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl, token: undefined })
  const result = await provider.call({ op: 'file_meta', args: { fileKey: KEY } })
  assert.equal(calls.length, 0)
  const error = /** @type {Record<string, any>} */ (result.structuredContent.error)
  assert.equal(error.kind, 'unconfigured')
  assert.match(error.remedy, /refs\.FIGMA_TOKEN/)
})

test('a credential service that throws is reported, not thrown', async () => {
  // Channel A has to cover this path too. `await tokenSource.resolve()` used to
  // be unguarded, so a corrupt credentials file escaped `execute` as a thrown
  // error — the model saw `Error: …` instead of the one thing this path most
  // needs to carry, namely what the user should fix.
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({
    fetchImpl,
    tokenSource: createTokenSource({
      ref: 'FIGMA_TOKEN',
      resolve: async () => {
        throw new Error('credentials file is not valid YAML')
      },
    }),
  })

  const result = await provider.call({ op: 'file_meta', args: { fileKey: KEY } })

  assert.equal(calls.length, 0, 'nothing may be sent to Figma when the credential cannot be resolved')
  assert.equal(result.structuredContent.ok, false)
  const error = /** @type {Record<string, any>} */ (result.structuredContent.error)
  assert.equal(error.kind, 'credential_error')
  assert.equal(typeof error.remedy, 'string')
  assert.ok(error.remedy.length > 0, 'a structured failure without a remedy is just a quieter crash')
  assert.match(error.remedy, /credentials\.yaml/)
  assert.match(error.remedy, /FIGMA_TOKEN/)
})

test('a thrown credential failure is redacted once the token is known', async () => {
  // A host error message is not under this plugin's control, and a credential
  // can end up inside one (in a path, or in an echo of the file's contents).
  //
  // The limit is worth stating: the redactor scrubs what it has *seen*, and a
  // resolve that throws on the very first call has never returned a value — so
  // there is nothing to match against. What this test pins is the case that can
  // actually be defended: a token the plugin has already used, appearing in the
  // message of a later failure.
  const { fetchImpl } = routeAll()
  let mode = 'ok'
  const { provider } = createHarness({
    fetchImpl,
    tokenSource: createTokenSource({
      ref: 'FIGMA_TOKEN',
      resolve: async () => {
        if (mode === 'throw') throw new Error(`cannot parse credentials near ${TEST_TOKEN}`)
        return TEST_TOKEN
      },
    }),
  })

  await provider.call({ op: 'file_meta', args: { fileKey: KEY } }) // the redactor learns the token
  mode = 'throw'
  const result = await provider.call({ op: 'file_meta', args: { fileKey: KEY } })

  const error = /** @type {Record<string, any>} */ (result.structuredContent.error)
  assert.equal(error.kind, 'credential_error')
  assert.equal(JSON.stringify(result).includes(TEST_TOKEN), false)
  assert.equal(textOf(result).includes(TEST_TOKEN), false)
})

test('the credential never appears in a result or an error, on any path', async () => {
  const leaky = createFetchStub(() =>
    jsonResponse({ status: 500, message: `upstream echoed ${TEST_TOKEN}` }, { status: 500 }),
  )
  const harness = createHarness({ fetchImpl: leaky.fetchImpl })
  const result = await harness.provider.call({ op: 'file_meta', args: { fileKey: KEY } })
  assert.equal(textOf(result).includes(TEST_TOKEN), false)
  assert.equal(JSON.stringify(result).includes(TEST_TOKEN), false)

  const ok = createHarness({ fetchImpl: routeAll().fetchImpl })
  assert.equal(JSON.stringify(await ok.provider.call({ op: 'file_meta', args: { fileKey: KEY } })).includes(TEST_TOKEN), false)
})

test('the credential travels in X-Figma-Token and in no other header', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  await provider.call({ op: 'file_meta', args: { fileKey: KEY } })
  const headers = /** @type {Record<string, string>} */ (calls[0].init.headers)
  assert.equal(headers['X-Figma-Token'], TEST_TOKEN)
  assert.equal('Authorization' in headers, false)
})

test('a repeated identical read is served from cache', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  await provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['10:20'], depth: 2 } })
  await provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['10:20'], depth: 2 } })
  assert.equal(calls.length, 1)
})

test('a different depth is a different request, so a different cache entry', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  await provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['10:20'], depth: 2 } })
  await provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['10:20'], depth: 3 } })
  assert.equal(calls.length, 2)
})

test('same ids in a different order still hit the cache, matching Figma\'s semantics', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  await provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['10:20', '10:21'], depth: 2 } })
  await provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['10:21', '10:20'], depth: 2 } })
  assert.equal(calls.length, 1)
})

test('five concurrent identical reads reach the network once', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  await Promise.all(
    Array.from({ length: 5 }, () => provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['10:20'], depth: 2 } })),
  )
  assert.equal(calls.length, 1)
})

test('a version change invalidates everything cached for that file', async () => {
  let version = '1'
  const { fetchImpl, calls } = routeAll({ meta: () => ({ name: 'Synthetic file', version, role: 'owner' }) })
  const harness = createHarness({ fetchImpl, config: { cacheTtlMs: 1_000 } })
  const nodes = { op: 'file_nodes', args: { fileKey: KEY, ids: ['10:20'], depth: 2 } }

  await harness.provider.call(nodes)
  await harness.provider.call({ op: 'file_meta', args: { fileKey: KEY } })
  assert.equal(calls.length, 2)

  // Both entries expire; the node read refills its own entry, then the metadata
  // read reports a new version and must drop it.
  harness.clock.advance(60_001)
  await harness.provider.call(nodes)
  version = '2'
  await harness.provider.call({ op: 'file_meta', args: { fileKey: KEY } })
  await harness.provider.call(nodes)

  assert.equal(calls.length, 5, 'the post-change node read must not be served from cache')
})

test('an oversized projection spills to disk and returns a skeleton plus the path', async () => {
  const huge = {
    nodes: {
      '10:20': {
        document: {
          id: '10:20',
          name: 'Huge',
          type: 'FRAME',
          children: Array.from({ length: 3_000 }, (_, index) => ({
            id: `20:${index}`,
            name: `Layer number ${index} with a fairly long name`,
            type: 'FRAME',
            absoluteBoundingBox: { x: index, y: index, width: 100, height: 100 },
            fills: [{ type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } }],
          })),
        },
      },
    },
  }
  const { fetchImpl } = createFetchStub(() => jsonResponse(huge))
  const spool = createMemorySpool()
  const { provider } = createHarness({ fetchImpl, spool })

  const result = await provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['10:20'], depth: 4 } })

  assert.equal(result.structuredContent.ok, true)
  const value = /** @type {Record<string, any>} */ (result.structuredContent.value)
  assert.equal(value.skeleton, true)
  assert.equal(spool.files.size, 1)
  assert.equal(typeof value.spooled.path, 'string')
  assert.equal(value.stats.nodeCount > 3_000, true)
  assert.equal(result.meta.skeletonOnly, true)
  assert.equal(result.meta.tightened, true)
})

test('format=full disables tightening but still refuses to blow the context', async () => {
  const huge = {
    document: {
      id: '0:1',
      name: 'Page',
      type: 'CANVAS',
      children: Array.from({ length: 3_000 }, (_, index) => ({ id: `1:${index}`, name: `Layer ${index}`, type: 'FRAME' })),
    },
  }
  const { fetchImpl, calls } = createFetchStub(() => jsonResponse(huge))
  const spool = createMemorySpool()
  const { provider } = createHarness({ fetchImpl, spool })

  // deep: 2 is the default, so ask for a depth that would tighten under summary.
  const result = await provider.call({ op: 'file', args: { fileKey: KEY, depth: 4 }, format: 'full' })
  assert.equal(calls.length, 1, 'full must not refetch at a shallower depth')
  assert.equal(result.meta.tightened, false)
  assert.equal(result.meta.skeletonOnly, false)
  assert.equal(/** @type {Record<string, any>} */ (result.structuredContent.value).skeleton, undefined)
})

test('max_bytes forces the spill even when the projection is inside the token budget', async () => {
  const { fetchImpl } = routeAll()
  const spool = createMemorySpool()
  const { provider } = createHarness({ fetchImpl, spool })
  const result = await provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['10:20'], depth: 2 }, max_bytes: 200 })

  assert.equal(result.structuredContent.ok, true)
  assert.equal(spool.files.size, 1)
  assert.equal(result.meta.truncated, true)
  assert.match(textOf(result), /spooled/)
})

test('metadata reports what the call cost', async () => {
  const { fetchImpl } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  const result = await provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['10:20'], depth: 2 } })
  assert.equal(typeof result.meta.nodeCount, 'number')
  assert.equal(typeof result.meta.projectedChars, 'number')
  assert.equal(result.meta.depthUsed, 2)
  assert.equal(result.meta.cached, false)
  assert.equal(result.meta.waitedMs, 0)
})

test('an image render downloads, persists, and attaches the image', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const { fetchImpl, calls } = createFetchStub(({ url }) => {
    if (url.startsWith('https://signed.example.test/')) return new Response(png, { status: 200 })
    return jsonResponse({ err: null, images: { '10:20': 'https://signed.example.test/a.png' } })
  })
  const spool = createMemorySpool()
  const { provider } = createHarness({ fetchImpl, spool })

  const result = await provider.call({ op: 'image_render', args: { fileKey: KEY, ids: ['10:20'] } })

  assert.equal(result.structuredContent.ok, true)
  const imageCall = calls.find((call) => call.url.startsWith('https://signed.example.test/'))
  assert.ok(imageCall !== undefined, 'the signed URL must be downloaded')
  assert.equal('X-Figma-Token' in /** @type {Record<string, string>} */ (imageCall.init.headers), false)
  assert.equal(spool.images.size, 1)
  assert.equal(spool.attachments.length, 1)
  assert.equal(spool.attachments[0].mediaType, 'image/png')
  const block = result.content.find((entry) => entry.type === 'image')
  assert.ok(block !== undefined, 'the result must carry an image block')
  assert.equal(/** @type {Record<string, any>} */ (block.attachment).mediaType, 'image/png')
  assert.equal(/** @type {Record<string, any>} */ (result.structuredContent.value).images['10:20'].path.length > 0, true)
})

test('an svg export is saved as a file but not attached as a raster image', async () => {
  const svg = new TextEncoder().encode('<svg/>')
  const { fetchImpl } = createFetchStub(({ url }) =>
    url.startsWith('https://signed.example.test/')
      ? new Response(svg, { status: 200 })
      : jsonResponse({ err: null, images: { '10:20': 'https://signed.example.test/a.svg' } }),
  )
  const spool = createMemorySpool()
  const { provider } = createHarness({ fetchImpl, spool })
  const result = await provider.call({ op: 'image_render', args: { fileKey: KEY, ids: ['10:20'], format: 'svg' } })

  assert.equal(spool.images.size, 1)
  assert.equal(spool.attachments.length, 0)
  assert.equal(result.content.some((entry) => entry.type === 'image'), false)
})

test('a failed image download is reported per node instead of failing the call', async () => {
  const { fetchImpl } = createFetchStub(({ url }) =>
    url.startsWith('https://signed.example.test/')
      ? new Response('gone', { status: 403 })
      : jsonResponse({ err: null, images: { '10:20': 'https://signed.example.test/a.png' } }),
  )
  const { provider } = createHarness({ fetchImpl })
  const result = await provider.call({ op: 'image_render', args: { fileKey: KEY, ids: ['10:20'] } })

  assert.equal(result.structuredContent.ok, true)
  const entry = /** @type {Record<string, any>} */ (result.structuredContent.value).images['10:20']
  assert.match(entry.error, /HTTP 403/)
})

test('the capability directory is progressive: names first, parameters on request', () => {
  const { provider } = createHarness({})
  const names = provider.listCapabilities()
  assert.equal(names.detail, 'names')
  assert.equal(names.ops.length, 7)
  assert.match(names.text, /file_nodes — /)
  assert.equal(names.text.includes('default 2'), false)

  const full = provider.listCapabilities({ query: 'node', detail: 'full' })
  assert.equal(full.detail, 'full')
  assert.ok(full.ops.length >= 1)
  assert.match(full.text, /default 2/)
  const nodesOp = full.ops.find((op) => op.op === 'file_nodes')
  assert.ok(nodesOp !== undefined)
  assert.equal(nodesOp.parameters.ids.required, true)
})

test('a group filter narrows the directory', () => {
  const { provider } = createHarness({})
  const images = provider.listCapabilities({ group: 'image', detail: 'names' })
  assert.deepEqual(
    images.ops.map((op) => op.op),
    ['image_render'],
  )
})

test('the reported defaults are the weakest-seat numbers', () => {
  const { provider } = createHarness({})
  assert.deepEqual(provider.defaults.rateLimits.tier1, DEFAULT_RATE_LIMITS.tier1)
  assert.equal(provider.defaults.budgetTokens, 8_000)
})

test('specs stay a whitelist: a capability table with one entry refuses everything else', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl, specs: [fileMeta] })
  const result = await provider.call({ op: 'file_nodes', args: { fileKey: KEY, ids: ['1:2'] } })
  assert.equal(calls.length, 0)
  assert.equal(/** @type {Record<string, any>} */ (result.structuredContent.error).kind, 'bad_op')
})

test('the provider refuses to be built without a token source', () => {
  assert.throws(() => createProvider({}), /requires a tokenSource/)
})

test('conflicting target and args are resolved in favor of args, and said out loud', async () => {
  const { fetchImpl, calls } = routeAll()
  const { provider } = createHarness({ fetchImpl })
  const result = await provider.call({
    op: 'file_nodes',
    target: `https://www.figma.com/design/${KEY}/Synthetic?node-id=99-99`,
    args: { fileKey: KEY, ids: ['10:20'] },
  })
  assert.equal(calls[0].search.get('ids'), '10:20')
  assert.match(/** @type {string[]} */ (result.meta.notes)[0], /explicit arguments win/)
})
