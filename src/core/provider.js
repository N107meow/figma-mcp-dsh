/**
 * The provider: one protocol-independent implementation of "call a Figma
 * capability".
 *
 * It knows nothing about the host it runs under. Credentials arrive through a
 * token source, oversized payloads leave through a spool sink, images leave
 * through the same sink, and time and transport are injectable — which is what
 * lets the whole pipeline be tested deterministically with no network.
 *
 * The order of operations below is the design:
 *
 * ```
 *   op lookup        → bad_op for anything not declared (a whitelist, not a template)
 *   read-only assert → refuse anything that is not GET
 *   target parsing   → a pasted link becomes fileKey/nodeId, arguments still win
 *   argument checks  → bad_args before any URL is built
 *   depth guard      → ids without depth gets depth=2, never the whole subtree
 *   credential       → re-resolved every call; no cross-call cache
 *   in-process memo  → a credential already known bad fails immediately
 *   cache + single-flight
 *   token bucket     → queue, and report how long the wait was
 *   HTTP             → no redirects, caller signal, retries only on 429/5xx
 *   projection       → whitelist, with color normalization
 *   budget           → tighten once, then skeleton + spill to disk
 * ```
 *
 * @module figma-mcp-dsh/core/provider
 */

import { hashSecret, Redactor } from './auth.js'
import { applyBudget, DEFAULT_BUDGET_TOKENS } from './budget.js'
import { TtlCache, spoolNameFor } from './cache.js'
import {
  assertReadOnly,
  buildPath,
  buildQuery,
  cacheKeyFor,
  describeCapability,
  findSpec,
  validateArgs,
} from './capability.js'
import {
  badArgs,
  badOp,
  classifyResponse,
  credentialError,
  messageFromBody,
  ReadOnlyViolationError,
  tokenInvalid,
  tooLarge,
  unconfigured,
  upstream,
} from './errors.js'
import { DEFAULT_TIMEOUT_MS, figmaFetch, figmaFetchBytes, HttpError } from './http.js'
import {
  DEFAULT_MAX_TEXT_CHARS,
  buildSkeleton,
  projectComponents,
  projectComponentSets,
  projectFileMeta,
  projectImageUrls,
  projectNodeTree,
  projectStyles,
} from './projection.js'
import { DEFAULT_RETRY_POLICY, withRetry } from './retry.js'
import { DEFAULT_RATE_LIMITS, SingleFlight, TokenBucket } from './scheduler.js'
import { createNullSpool } from './spool-sink.js'
import { ALL_GROUPS, ALL_SPECS } from './specs/index.js'
import { estimateBytes, serialize } from './tokens.js'
import { describeUnparsableTarget, parseFigmaUrl } from './url.js'

/**
 * Why the directory has no variables capability.
 *
 * Figma's own scope reference marks `file_variables:read` as Enterprise-only,
 * and the write scope is too. The capability is absent rather than present and
 * failing, so the model learns the reason from the directory instead of from a
 * failed call — and a personal account never sees an operation it can never
 * perform.
 */
export const VARIABLES_UNSUPPORTED_NOTE =
  'Variables are not supported: Figma exposes them only on Enterprise plans, ' +
  'so the capability is deliberately absent rather than failing at call time.'

/** Default soft ceiling on one tool result, in bytes. */
export const DEFAULT_MAX_RESULT_BYTES = 262_144

/** Default cache lifetime. */
export const DEFAULT_CACHE_TTL_MS = 60_000

/** Default number of cached payloads. */
export const DEFAULT_CACHE_ENTRIES = 64

/** Default Figma REST origin. */
export const DEFAULT_ENDPOINT_BASE = 'https://api.figma.com'

/** Media types the durable attachment path accepts. */
const RASTER_MEDIA_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' })

/**
 * A Figma response that this plugin classified as a failure. Carries the
 * structured error plus the status the retry policy needs.
 */
class FigmaResponseError extends Error {
  /**
   * @param {import('./errors.js').FigmaError} error - Classified error.
   * @param {number} status - HTTP status.
   */
  constructor(error, status) {
    super(`figma ${status}: ${error.kind}`)
    this.name = 'FigmaResponseError'
    this.figmaError = error
    this.status = status
  }
}

/**
 * Build a provider from its dependencies.
 *
 * @param {object} deps - Dependencies.
 * @param {import('./types.js').TokenSource} deps.tokenSource - Credential seam, re-resolved per call.
 * @param {import('./types.js').SpoolSink} [deps.spool] - Oversize and image persistence.
 * @param {object} [deps.config] - Provider configuration.
 * @param {number} [deps.config.cacheTtlMs] - Cache lifetime for capabilities without their own.
 * @param {number} [deps.config.maxResultBytes] - Soft ceiling on one result.
 * @param {number} [deps.config.budgetTokens] - Approximate projection budget.
 * @param {number} [deps.config.spoolDir] - Unused here; the sink owns the directory.
 * @param {Record<string, import('./scheduler.js').RateLimitConfig>} [deps.config.rateLimits] - Per-tier budgets.
 * @param {number} [deps.config.requestTimeoutMs] - Per-request deadline.
 * @param {number} [deps.config.maxTextChars] - Per-text-node character cap.
 * @param {string} [deps.config.endpointBase] - REST origin override.
 * @param {'token'|'bearer'} [deps.config.authScheme] - Which header carries the credential.
 * @param {typeof fetch} [deps.fetchImpl] - Injected transport.
 * @param {() => number} [deps.now] - Injected clock.
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [deps.sleepImpl] - Injected sleeper.
 * @param {() => number} [deps.random] - Injected jitter source.
 * @param {readonly import('./types.js').CapabilitySpec[]} [deps.specs] - Capability table override, for tests.
 * @returns {{listCapabilities: (filter?: object) => object, call: (input: object) => Promise<object>, stats: () => object, defaults: object}} The provider.
 */
export function createProvider(deps) {
  const tokenSource = deps.tokenSource
  if (tokenSource === undefined || typeof tokenSource.resolve !== 'function') {
    throw new TypeError('createProvider requires a tokenSource with a resolve() function')
  }

  const settings = {
    cacheTtlMs: deps.config?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    cacheMaxEntries: deps.config?.cacheMaxEntries ?? DEFAULT_CACHE_ENTRIES,
    maxResultBytes: deps.config?.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
    budgetTokens: deps.config?.budgetTokens ?? DEFAULT_BUDGET_TOKENS,
    requestTimeoutMs: deps.config?.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxTextChars: deps.config?.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS,
    endpointBase: deps.config?.endpointBase ?? DEFAULT_ENDPOINT_BASE,
    authScheme: deps.config?.authScheme ?? 'token',
    rateLimits: deps.config?.rateLimits ?? DEFAULT_RATE_LIMITS,
    retry: deps.config?.retry ?? DEFAULT_RETRY_POLICY,
  }

  const specs = deps.specs ?? ALL_SPECS
  const spool = deps.spool ?? createNullSpool()
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const sleepImpl = deps.sleepImpl

  const redactor = new Redactor()
  const cache = new TtlCache({ maxEntries: settings.cacheMaxEntries, now })
  const singleFlight = new SingleFlight()
  /** @type {Map<number, TokenBucket>} */
  const buckets = new Map()
  /** @type {Set<string>} Credential fingerprints already rejected in this process. */
  const rejectedCredentials = new Set()
  /** @type {Map<string, string>} Last `version` seen per file key. */
  const fileVersions = new Map()
  const counters = { calls: 0, requests: 0, retries: 0, cacheHits: 0, queuedMs: 0, images: 0 }

  /**
   * The bucket for one rate-limit tier.
   *
   * @param {1|2|3} tier - Capability tier.
   * @returns {TokenBucket} Bucket for that tier.
   */
  function bucketFor(tier) {
    const existing = buckets.get(tier)
    if (existing !== undefined) return existing
    const configured = settings.rateLimits[`tier${tier}`] ?? DEFAULT_RATE_LIMITS[`tier${tier}`]
    const bucket = new TokenBucket(configured, now, sleepImpl)
    buckets.set(tier, bucket)
    return bucket
  }

  /**
   * The credential header for one request.
   *
   * `X-Figma-Token` is the header both Figma token types document. The
   * bearer form exists only for a deployment that has standardized on it; the
   * credential is never sent twice.
   *
   * @param {string} token - Resolved credential value.
   * @returns {Record<string, string>} Request headers.
   */
  function authHeaders(token) {
    return settings.authScheme === 'bearer'
      ? { Authorization: `Bearer ${token}` }
      : { 'X-Figma-Token': token }
  }

  /**
   * Assemble a request URL.
   *
   * @param {string} path - Capability path with placeholders already filled.
   * @param {Record<string, string>} query - Query values.
   * @returns {string} Absolute URL.
   */
  function buildUrl(path, query) {
    const url = new URL(`${settings.endpointBase}${path}`)
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
    return url.toString()
  }

  /**
   * Decide whether a thrown failure may be retried.
   *
   * Only 429 and 5xx, because those are the only answers that can differ on a
   * second try. A 401, 403, or 404 will say the same thing forever, and
   * retrying it wastes a rate-limit token while suggesting to the model that
   * the problem was transient.
   *
   * A transport-level `NETWORK` failure is also retried — it is the one case
   * where no answer arrived at all. Timeouts and cancellations are not: the
   * caller asked for a deadline and it passed.
   *
   * @param {unknown} error - Thrown value.
   * @returns {import('./retry.js').RetryVerdict} Retry verdict.
   */
  function classifyThrown(error) {
    if (error instanceof FigmaResponseError) {
      if (error.status === 429) {
        const retryAfterSec = error.figmaError.kind === 'rate_limited' ? error.figmaError.retryAfterSec : 60
        return { retryable: true, retryAfterMs: retryAfterSec * 1000 }
      }
      return { retryable: error.status >= 500 }
    }
    if (error instanceof HttpError) return { retryable: error.code === 'NETWORK' }
    return { retryable: false }
  }

  /**
   * Issue one capability request and return the parsed payload.
   *
   * @param {object} request - Request facts.
   * @param {import('./types.js').CapabilitySpec} request.spec - Capability.
   * @param {Record<string, unknown>} request.params - Validated parameters.
   * @param {string} request.token - Resolved credential.
   * @param {TokenBucket} request.bucket - Tier bucket, so a 429 can calibrate it.
   * @param {AbortSignal} [request.signal] - Cancellation.
   * @returns {Promise<{raw: unknown} | {error: import('./errors.js').FigmaError}>} Parsed payload or a classified error.
   */
  async function requestJson(request) {
    const { spec, params, token, bucket, signal } = request
    const url = buildUrl(buildPath(spec, params), buildQuery(spec, params))
    const operation = `figma ${spec.name}`

    let response
    try {
      response = await withRetry(
        async () => {
          const result = await figmaFetch({
            url,
            headers: authHeaders(token),
            signal,
            fetchImpl,
            timeoutMs: settings.requestTimeoutMs,
            operation,
            redact: (text) => redactor.redact(text),
          })
          counters.requests += 1
          const classified = classifyResponse({
            status: result.status,
            body: result.body,
            headers: result.headers,
            ref: tokenSource.ref,
            missingScopes: spec.scopes,
            target: url,
            redact: (text) => redactor.redact(text),
          })
          if (classified !== undefined) {
            // A 429 is the only moment Figma tells us the real budget.
            if (classified.kind === 'rate_limited') bucket.calibrate(classified.limitType)
            throw new FigmaResponseError(classified, result.status)
          }
          return result
        },
        classifyThrown,
        settings.retry,
        signal,
        {
          sleepImpl,
          random,
          onRetry: () => {
            counters.retries += 1
          },
        },
      )
    } catch (error) {
      if (error instanceof FigmaResponseError) return { error: error.figmaError }
      if (error instanceof HttpError) {
        return {
          error: upstream(0, redactor.redact(error.message)),
        }
      }
      throw error
    }

    const parsed = parseJson(response.body)
    if (parsed.ok === false) {
      return { error: upstream(response.status, redactor.redact(response.body.slice(0, 500))) }
    }
    // A 200 carrying a non-empty `err` is still a failure — Figma uses that
    // shape for per-node problems.
    const payload = parsed.value
    if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      const err = /** @type {Record<string, unknown>} */ (payload).err
      if (typeof err === 'string' && err.length > 0) {
        return { error: upstream(response.status, redactor.redact(messageFromBody(JSON.stringify({ message: err })))) }
      }
    }
    return { raw: payload }
  }

  /**
   * Read one payload through the cache, single-flight, and rate limiter.
   *
   * @param {object} request - Request facts.
   * @param {import('./types.js').CapabilitySpec} request.spec - Capability.
   * @param {Record<string, unknown>} request.params - Validated parameters.
   * @param {string} request.token - Resolved credential.
   * @param {AbortSignal} [request.signal] - Cancellation.
   * @returns {Promise<{ok: true, raw: unknown, cached: boolean, waitedMs: number}|{ok: false, error: import('./errors.js').FigmaError}>} Payload or error.
   */
  async function load(request) {
    const key = cacheKeyFor(request.spec, request.params)
    const hit = cache.get(key)
    if (hit !== undefined) {
      counters.cacheHits += 1
      return { ok: true, raw: hit, cached: true, waitedMs: 0 }
    }

    return singleFlight.run(key, async () => {
      const raced = cache.get(key)
      if (raced !== undefined) {
        counters.cacheHits += 1
        return { ok: true, raw: raced, cached: true, waitedMs: 0 }
      }

      const bucket = bucketFor(request.spec.tier)
      const { waitedMs } = await bucket.acquire(request.signal)
      counters.queuedMs += waitedMs

      const outcome = await requestJson({
        spec: request.spec,
        params: request.params,
        token: request.token,
        bucket,
        signal: request.signal,
      })
      if ('error' in outcome) return { ok: false, error: outcome.error }

      if (request.spec.project === 'fileMeta') noteFileVersion(request.params.fileKey, outcome.raw)
      cache.set(key, outcome.raw, request.spec.cache?.ttlMs ?? settings.cacheTtlMs)
      return { ok: true, raw: outcome.raw, cached: false, waitedMs }
    })
  }

  /**
   * Record a file's version and drop everything cached for it when it changed.
   *
   * This is the *only* invalidation mechanism available: conditional requests
   * do not work against Figma, so a cheap `version` comparison is what stands in
   * for them.
   *
   * @param {unknown} fileKey - File key the metadata belongs to.
   * @param {unknown} raw - Raw `/meta` payload.
   */
  function noteFileVersion(fileKey, raw) {
    if (typeof fileKey !== 'string') return
    const meta = projectFileMeta(raw)
    const version = meta.version
    if (typeof version !== 'string') return
    const previous = fileVersions.get(fileKey)
    if (previous !== undefined && previous !== version) {
      cache.invalidateWhere((key) => keyFileOf(key) === fileKey)
    }
    fileVersions.set(fileKey, version)
  }

  /**
   * Extract the file key from a cache key.
   *
   * @param {string} key - Cache key produced by `cacheKeyFor`.
   * @returns {string|undefined} File key, when the key has one.
   */
  function keyFileOf(key) {
    try {
      const parsed = JSON.parse(key)
      return Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Project one raw payload for one capability.
   *
   * @param {import('./types.js').CapabilitySpec} spec - Capability.
   * @param {unknown} raw - Raw payload.
   * @param {{maxTextChars?: number, includeGeometry?: boolean}} options - Projection options.
   * @returns {unknown} Projected value.
   */
  function projectFor(spec, raw, options) {
    switch (spec.project) {
      case 'nodeTree':
        return projectNodeTree(raw, options)
      case 'fileMeta':
        return projectFileMeta(raw)
      case 'imageUrls':
        return projectImageUrls(raw)
      case 'components':
        return projectComponents(raw)
      case 'componentSets':
        return projectComponentSets(raw)
      case 'styles':
        return projectStyles(raw)
      default:
        return raw
    }
  }

  /**
   * Download one rendered image.
   *
   * The URL is a short-lived signed link on a third-party host, so the Figma
   * credential is deliberately **not** attached — sending it there would leak a
   * token to a host Figma never named, which is the same class of mistake as
   * following a redirect.
   *
   * @param {string} url - Signed image URL.
   * @param {AbortSignal} [signal] - Cancellation.
   * @returns {Promise<{ok: true, bytes: Uint8Array}|{ok: false, message: string}>} Bytes or a failure note.
   */
  async function downloadImage(url, signal) {
    try {
      const response = await figmaFetchBytes({
        url,
        headers: {},
        signal,
        fetchImpl,
        timeoutMs: settings.requestTimeoutMs,
        operation: 'image download',
        redact: (text) => redactor.redact(text),
      })
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, message: `the image host answered HTTP ${response.status}` }
      }
      return { ok: true, bytes: response.bytes }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message: redactor.redact(message) }
    }
  }

  /**
   * Persist and attach every rendered image.
   *
   * Three deliverables per image, because each covers a different failure:
   * the bytes on disk (so a later read costs nothing), a durable attachment
   * reference (so the model sees the design this turn), and a text entry (so
   * the result still works when the route cannot accept images).
   *
   * @param {object} input - Render facts.
   * @param {Record<string, unknown>} input.params - Validated parameters.
   * @param {{images: Record<string, string>, missing: string[]}} input.projected - Projected image URLs.
   * @param {AbortSignal} [input.signal] - Cancellation.
   * @param {string} [input.cwd] - Session workspace root.
   * @returns {Promise<{value: Record<string, unknown>, blocks: Array<Record<string, unknown>>, notes: string[]}>} Render outcome.
   */
  async function collectImages(input) {
    const format = typeof input.params.format === 'string' ? input.params.format : 'png'
    const scale = typeof input.params.scale === 'number' ? input.params.scale : 2
    const mediaType = RASTER_MEDIA_TYPES[format]
    /** @type {Record<string, unknown>} */
    const files = {}
    /** @type {Array<Record<string, unknown>>} */
    const blocks = []
    /** @type {string[]} */
    const notes = []

    for (const [nodeId, url] of Object.entries(input.projected.images)) {
      const downloaded = await downloadImage(url, input.signal)
      if (downloaded.ok === false) {
        files[nodeId] = { error: downloaded.message, url }
        notes.push(`image for node ${nodeId} could not be downloaded: ${downloaded.message}`)
        continue
      }

      const fileName = `${nodeId.replace(':', '-')}@${scale}x.${format}`
      /** @type {Record<string, unknown>} */
      const entry = { bytes: downloaded.bytes.byteLength, format, scale }

      if (typeof spool.writeImage === 'function') {
        const path = await spool.writeImage(`images/${fileName}`, downloaded.bytes, { cwd: input.cwd, signal: input.signal })
        if (typeof path === 'string' && path.length > 0) entry.path = path
      }

      if (mediaType !== undefined && typeof spool.saveImage === 'function') {
        const ref = await spool.saveImage({ name: fileName, bytes: downloaded.bytes, mediaType })
        if (ref !== undefined) {
          entry.attached = true
          blocks.push({ type: 'image', attachment: { ...ref } })
          counters.images += 1
        }
      }

      if (entry.attached !== true && mediaType === undefined) {
        notes.push(`${format} output is not attached as a viewable image; read the saved file instead.`)
      }
      files[nodeId] = entry
    }

    const value = {
      images: files,
      ...(input.projected.missing.length === 0 ? {} : { missing: input.projected.missing }),
    }
    return { value, blocks, notes }
  }

  /**
   * Bound a result that is still too large after projection.
   *
   * Oversize is not failure: the model keeps a usable summary and an honest
   * pointer to where the rest went.
   *
   * @param {object} input - Result facts.
   * @param {string} input.op - Capability name.
   * @param {unknown} input.value - Projected value.
   * @param {Record<string, unknown>} input.meta - Cost metadata.
   * @param {number} input.limit - Byte ceiling for this call.
   * @param {string} input.key - Cache key, used to name the spool file.
   * @param {AbortSignal} [input.signal] - Cancellation.
   * @param {string} [input.cwd] - Session workspace root.
   * @returns {Promise<{value: unknown, meta: Record<string, unknown>, error?: import('./errors.js').FigmaError}>} Bounded value.
   */
  async function boundResult(input) {
    const envelope = { op: input.op, ok: true, value: input.value, meta: input.meta }
    const text = serialize(envelope)
    const bytes = estimateBytes(text)
    if (bytes <= input.limit) return { value: input.value, meta: input.meta }

    const path =
      typeof spool.write === 'function'
        ? await spool.write(spoolNameFor(`${input.key}:result`, 'json'), text, { cwd: input.cwd, signal: input.signal })
        : undefined

    if (typeof path !== 'string' || path.length === 0) {
      return {
        value: input.value,
        meta: input.meta,
        error: tooLarge({
          bytes,
          suggestion:
            `This result is ${bytes} bytes and no filesystem was available to save it. Ask again with a narrower ` +
            'ids/depth, or for one node at a time.',
        }),
      }
    }

    const meta = { ...input.meta, truncated: true, fullBytes: bytes, spooled: { path, bytes } }
    // Never skeletonize a skeleton: a value that already carries the marker is
    // as small as this stage can make it, and re-deriving it would only add a
    // second spill file for the same bytes.
    const summarized =
      isSkeleton(input.value) || !looksLikeNodeTree(input.value)
        ? input.value
        : buildSkeleton(/** @type {Record<string, unknown>} */ (input.value))
    if (typeof summarized === 'object' && summarized !== null) {
      /** @type {Record<string, unknown>} */ (summarized).spooled = { path, bytes }
    }
    return { value: summarized, meta }
  }

  /**
   * Whether a value is already a structure skeleton.
   *
   * @param {unknown} value - Candidate.
   * @returns {boolean} Whether it is a skeleton.
   */
  function isSkeleton(value) {
    return value !== null && typeof value === 'object' && /** @type {Record<string, unknown>} */ (value).skeleton === true
  }

  /**
   * Whether a value carries the node-tree projection shape.
   *
   * @param {unknown} value - Candidate.
   * @returns {boolean} Whether it can be skeletonized.
   */
  function looksLikeNodeTree(value) {
    return value !== null && typeof value === 'object' && Array.isArray(/** @type {Record<string, unknown>} */ (value).roots)
  }

  /**
   * Assemble the successful tool value.
   *
   * @param {object} input - Result facts.
   * @param {string} input.op - Capability name.
   * @param {unknown} input.value - Model-facing value.
   * @param {Record<string, unknown>} input.meta - Cost metadata.
   * @param {Array<Record<string, unknown>>} [input.blocks] - Extra content blocks (images).
   * @returns {{structuredContent: Record<string, unknown>, content: Array<Record<string, unknown>>, meta: Record<string, unknown>}} Tool value.
   */
  function success(input) {
    const meta = input.meta
    const structuredContent = { op: input.op, ok: true, value: input.value, meta }
    const content = [{ type: 'text', text: serialize(structuredContent) }, ...(input.blocks ?? [])]
    return { structuredContent, content, meta }
  }

  /**
   * Assemble the structured-error tool value.
   *
   * The error travels as a **successful** result on purpose: a thrown error
   * reaches the model as `Error: …` and reads as a transient fault, while this
   * shape carries the remedy steps the model is meant to act on.
   *
   * @param {import('./errors.js').FigmaError} error - Classified error.
   * @param {{op?: string, notes?: string[]}} [context] - Extra facts.
   * @returns {{structuredContent: Record<string, unknown>, content: Array<Record<string, unknown>>, meta: Record<string, unknown>}} Tool value.
   */
  function failure(error, context = {}) {
    const structuredContent = {
      op: context.op,
      ok: false,
      error,
      ...(context.notes === undefined || context.notes.length === 0 ? {} : { notes: context.notes }),
    }
    const meta = { ok: false, errorKind: error.kind }
    return {
      structuredContent,
      meta,
      content: [{ type: 'text', text: serialize(structuredContent) }],
    }
  }

  /**
   * Render the capability directory.
   *
   * Progressive disclosure: `names` is a name and one line per capability, and
   * `full` — asked for explicitly, usually with a query — adds the parameter
   * schemas. The model pays for a capability's full description only when it
   * has decided it needs that capability.
   *
   * @param {{query?: string, group?: string, detail?: 'names'|'full'}} [filter] - Listing filter.
   * @returns {{text: string, ops: Array<Record<string, unknown>>, total: number, groups: readonly string[], detail: 'names'|'full'}} Directory.
   */
  function listCapabilities(filter = {}) {
    const detail = filter.detail === 'full' ? 'full' : 'names'
    const group = typeof filter.group === 'string' ? filter.group.trim().toLowerCase() : ''
    const query = typeof filter.query === 'string' ? filter.query.trim().toLowerCase() : ''

    let matches = specs
    if (group.length > 0) matches = matches.filter((spec) => spec.group === group)
    if (query.length > 0) matches = matches.filter((spec) => matchesQuery(spec, query))

    const lines = [
      `Figma capabilities — ${matches.length} of ${specs.length} shown, detail=${detail}.`,
      `Groups: ${ALL_GROUPS.join(', ')}.`,
      '',
    ]
    if (matches.length === 0) {
      lines.push('Nothing matched. Call again without a query, or with another group, to see every capability.')
    }
    for (const spec of matches) {
      if (detail === 'full') {
        lines.push(`${spec.name} [${spec.group}, ${spec.weight}, tier ${spec.tier}]`)
        lines.push(`  ${spec.description}`)
        for (const [name, param] of Object.entries(spec.params)) {
          const bits = [param.type]
          if (param.required === true) bits.push('required')
          if (param.default !== undefined) bits.push(`default ${JSON.stringify(param.default)}`)
          if (param.min !== undefined || param.max !== undefined) bits.push(`range ${param.min ?? '-∞'}..${param.max ?? '∞'}`)
          if (param.enum !== undefined) bits.push(`one of ${param.enum.join('|')}`)
          lines.push(`  - ${name}: ${bits.join(', ')} — ${param.description}`)
        }
      } else {
        lines.push(`${spec.name} — ${spec.description}`)
      }
    }
    if (detail === 'names' && matches.length > 0) {
      lines.push('')
      lines.push('Call again with detail="full" (optionally with query= or group=) to see the parameters of one capability.')
    }
    lines.push('')
    lines.push(VARIABLES_UNSUPPORTED_NOTE)

    return {
      text: lines.join('\n'),
      ops: matches.map((spec) => describeCapability(spec, detail)),
      total: specs.length,
      groups: ALL_GROUPS,
      detail,
      unsupported: { variables: VARIABLES_UNSUPPORTED_NOTE },
    }
  }

  /**
   * Whether a capability matches a free-text query.
   *
   * @param {import('./types.js').CapabilitySpec} spec - Capability.
   * @param {string} query - Lower-cased query.
   * @returns {boolean} Whether it matches.
   */
  function matchesQuery(spec, query) {
    const haystack = [spec.name, spec.group, spec.description, ...Object.keys(spec.params)].join(' ').toLowerCase()
    return query.split(/\s+/).every((term) => haystack.includes(term))
  }

  /**
   * Run one capability.
   *
   * @param {object} input - Call description.
   * @param {string} input.op - Capability name.
   * @param {Record<string, unknown>} [input.args] - Capability arguments.
   * @param {string} [input.target] - A Figma link, file key, or node id.
   * @param {number} [input.max_bytes] - Per-call override of the result ceiling.
   * @param {'summary'|'full'} [input.format] - `full` disables depth tightening and text truncation.
   * @param {AbortSignal} [input.signal] - Tool-call cancellation.
   * @param {string} [input.cwd] - Session workspace root, for spooled files.
   * @returns {Promise<{structuredContent: Record<string, unknown>, content: Array<Record<string, unknown>>, meta: Record<string, unknown>}>} Tool value.
   */
  async function call(input) {
    counters.calls += 1
    const op = typeof input.op === 'string' ? input.op : ''
    const spec = findSpec(specs, op)
    if (spec === undefined) return failure(badOp(op, specs.map((entry) => entry.name)))

    // Read-only is an assertion, not a convention: a capability that is not a
    // GET must not be dispatched even if someone adds one by mistake.
    assertReadOnly(spec)

    /** @type {string[]} */
    const notes = []
    /** @type {Record<string, unknown>} */
    const rawArgs = input.args !== undefined && input.args !== null && typeof input.args === 'object' ? { ...input.args } : {}

    if (typeof input.target === 'string' && input.target.trim().length > 0) {
      const parsed = parseFigmaUrl(input.target)
      if (parsed === undefined) return failure(badArgs('target', describeUnparsableTarget(input.target)), { op })
      if (parsed.fileKey !== undefined) {
        if (rawArgs.fileKey === undefined) rawArgs.fileKey = parsed.fileKey
        else if (rawArgs.fileKey !== parsed.fileKey) {
          notes.push(`The link names file ${parsed.fileKey}, but args.fileKey was used because explicit arguments win.`)
        }
      }
      if (parsed.nodeId !== undefined) {
        const idsSpec = /** @type {import('./types.js').ParamSpec|undefined} */ (spec.params.ids)
        if (idsSpec !== undefined && idsSpec.required === true) {
          if (rawArgs.ids === undefined) rawArgs.ids = [parsed.nodeId]
          else notes.push(`The link names node ${parsed.nodeId}, but args.ids was used because explicit arguments win.`)
        } else if (idsSpec !== undefined) {
          // The link's node id is NOT copied into an optional `ids`.
          //
          // On the whole-file capability, `ids` prunes the response to that
          // node's ancestry and can cut the requested node off entirely at the
          // default depth — a three-node answer that looks like a file with one
          // frame. A capability that can answer without ids must not be
          // silently narrowed by a fragment of a pasted link; the drill-down
          // capability is what the caller wants, so the note names it.
          const drill = specs.find((entry) => entry.params.ids?.required === true)
          notes.push(
            `The link names node ${parsed.nodeId}, but "${spec.name}" reads the whole document, so the node id was ignored. ` +
              (drill === undefined ? 'Pass ids explicitly to narrow it.' : `Use "${drill.name}" to read that node.`),
          )
        } else if ('nodeId' in spec.params && rawArgs.nodeId === undefined) {
          rawArgs.nodeId = parsed.nodeId
        }
      }
    }

    const validated = validateArgs(spec, rawArgs)
    if (validated.ok === false) return failure(validated.error, { op })
    const params = validated.value

    // Trap: ids says where to start, depth says how much to take. Without a
    // depth, `ids=<one frame>` returns that frame's entire descendant tree, and
    // `ids=<root>` returns the whole file. Fill the default rather than
    // trusting the caller to know this.
    if (Array.isArray(params.ids) && params.ids.length > 0 && params.depth === undefined) {
      const depthSpec = /** @type {Record<string, import('./types.js').ParamSpec>} */ (spec.params).depth
      params.depth = depthSpec?.default ?? 2
    }

    // The credential seam is the one place a *host* failure can reach this
    // layer: a corrupt credentials file, an unmounted service, a watcher error.
    // Without this catch the exception escapes `execute` and reaches the model
    // as a thrown error — bypassing the structured-failure channel on exactly
    // the path where a next step is most useful.
    let token
    try {
      token = await tokenSource.resolve()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return failure(credentialError(tokenSource.ref, redactor.redact(detail)), { op })
    }
    if (typeof token !== 'string' || token.length === 0) return failure(unconfigured(tokenSource.ref), { op })
    redactor.remember(token)

    const fingerprint = hashSecret(token)
    if (rejectedCredentials.has(fingerprint)) {
      // Remembered, so the same bad credential fails immediately with the same
      // instructions instead of spending another request on a known 401. The
      // key is the credential's fingerprint, not a timestamp, so writing a new
      // token recovers on the very next call.
      return failure(
        tokenInvalid(tokenSource.ref, {
          status: 401,
          detail: 'This exact token was already rejected in this process, so no request was sent.',
        }),
        { op },
      )
    }

    const format = input.format === 'full' ? 'full' : 'summary'
    const limit = typeof input.max_bytes === 'number' && input.max_bytes > 0 ? input.max_bytes : settings.maxResultBytes
    const key = cacheKeyFor(spec, params)
    const startedAt = now()

    const loaded = await load({ spec, params, token, signal: input.signal })
    if (loaded.ok === false) {
      if (loaded.error.kind === 'token_invalid') rejectedCredentials.add(fingerprint)
      return failure(loaded.error, { op, notes })
    }

    if (spec.project === 'imageUrls') {
      const projected = /** @type {{images: Record<string, string>, missing: string[]}} */ (projectFor(spec, loaded.raw, {}))
      const collected = await collectImages({ params, projected, signal: input.signal, cwd: input.cwd })
      const meta = {
        cached: loaded.cached,
        waitedMs: loaded.waitedMs,
        ms: Math.max(0, now() - startedAt),
        requested: Object.keys(projected.images).length + projected.missing.length,
        rendered: Object.keys(collected.value.images).length,
        attached: collected.blocks.length,
      }
      const bounded = await boundResult({
        op,
        value: collected.value,
        meta,
        limit,
        key,
        signal: input.signal,
        cwd: input.cwd,
      })
      if (bounded.error !== undefined) return failure(bounded.error, { op, notes })
      return success({ op, value: bounded.value, meta: bounded.meta, blocks: collected.blocks })
    }

    const budgetTokens = format === 'full' ? Number.POSITIVE_INFINITY : settings.budgetTokens
    const maxTextChars = format === 'full' ? Number.MAX_SAFE_INTEGER : settings.maxTextChars
    const minDepth = spec.minDepth ?? 1

    const bounded = await applyBudget(
      async (depth) => {
        if (params.depth === depth && loaded.raw !== undefined) return loaded.raw
        const again = await load({ spec, params: { ...params, depth }, token, signal: input.signal })
        if (again.ok === false) throw new FiguredRequestError(again.error)
        return again.raw
      },
      (raw) => /** @type {Record<string, unknown>} */ (projectFor(spec, raw, { maxTextChars })),
      {
        depth: typeof params.depth === 'number' ? params.depth : undefined,
        budgetTokens,
        minDepth,
        key,
        spool,
        signal: input.signal,
        cwd: input.cwd,
      },
    ).catch((error) => {
      if (error instanceof FiguredRequestError) return { error: error.figmaError }
      throw error
    })

    if ('error' in bounded && bounded.error !== undefined) return failure(bounded.error, { op, notes })

    const stats = looksLikeNodeTree(bounded.value) ? /** @type {Record<string, unknown>} */ (bounded.value).stats : undefined
    const meta = {
      nodeCount: stats !== undefined && typeof stats === 'object' ? /** @type {Record<string, unknown>} */ (stats).nodeCount : undefined,
      projectedChars: serialize(bounded.value).length,
      depthUsed: bounded.depthUsed,
      tightened: bounded.tightened === true,
      skeletonOnly: bounded.skeletonOnly === true,
      cached: loaded.cached,
      waitedMs: loaded.waitedMs,
      ms: Math.max(0, now() - startedAt),
      ...(bounded.spooled === undefined ? {} : { spooled: bounded.spooled }),
    }
    for (const field of Object.keys(meta)) if (meta[field] === undefined) delete meta[field]

    if (notes.length > 0) meta.notes = notes
    const finalValue = await boundResult({ op, value: bounded.value, meta, limit, key, signal: input.signal, cwd: input.cwd })
    if (finalValue.error !== undefined) return failure(finalValue.error, { op, notes })
    return success({ op, value: finalValue.value, meta: finalValue.meta })
  }

  return {
    listCapabilities,
    call,
    defaults: settings,
    stats: () => ({
      ...counters,
      cacheSize: cache.size,
      inflight: singleFlight.size,
      rejectedCredentials: rejectedCredentials.size,
      limits: Object.fromEntries(
        [...buckets.entries()].map(([tier, bucket]) => [
          `tier${tier}`,
          { limit: bucket.limit, capacity: bucket.capacity, calibrations: [...bucket.calibrations] },
        ]),
      ),
    }),
  }
}

/**
 * Internal carrier for a classified error raised from inside the budget stage.
 */
class FiguredRequestError extends Error {
  /**
   * @param {import('./errors.js').FigmaError} figmaError - Classified error.
   */
  constructor(figmaError) {
    super(`figma request failed: ${figmaError.kind}`)
    this.name = 'FiguredRequestError'
    this.figmaError = figmaError
  }
}

/**
 * Parse a response body as JSON.
 *
 * @param {string} body - Raw body text.
 * @returns {{ok: true, value: unknown}|{ok: false}} Outcome.
 */
function parseJson(body) {
  if (typeof body !== 'string' || body.length === 0) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(body) }
  } catch {
    return { ok: false }
  }
}

export { ReadOnlyViolationError }
