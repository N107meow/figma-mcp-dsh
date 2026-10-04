/**
 * Error normalization.
 *
 * Every failure this plugin can produce becomes one of a small closed set of
 * structured values. Two properties matter more than the shapes themselves:
 *
 * 1. **`remedy` is a next action, not a restatement.** "The token expired" is
 *    useless; "open this page, enable these scopes, write the file here, then
 *    tell me and I will retry" is the whole point.
 * 2. **Nothing is thrown at the model.** Errors travel as successful tool
 *    values (docs/PLAN.md section 5.4.1 channel A), because a thrown error
 *    reaches the model as `Error: …` and invites a pointless retry.
 *
 * @module figma-mcp-dsh/core/errors
 */

import { READ_ONLY_SCOPES, credentialDeliverySteps } from './auth.js'

/**
 * @typedef {(
 *   {kind: 'unconfigured', remedy: string} |
 *   {kind: 'credential_error', remedy: string} |
 *   {kind: 'token_invalid', remedy: string} |
 *   {kind: 'forbidden_scope', granted: string[], missing: string[], remedy: string} |
 *   {kind: 'not_found', remedy: string} |
 *   {kind: 'rate_limited', retryAfterSec: number, upgradeUrl?: string, limitType?: 'high'|'low'} |
 *   {kind: 'too_large', bytes: number, spoolPath?: string, suggestion: string} |
 *   {kind: 'bad_args', field: string, reason: string} |
 *   {kind: 'bad_op', requested: string, available: string[]} |
 *   {kind: 'upstream', status: number, body: string}
 * )} FigmaError
 */

/** Error thrown when a non-read-only capability is dispatched. Never reachable through the declared specs. */
export class ReadOnlyViolationError extends Error {
  /**
   * @param {string} name - Capability name.
   * @param {string} method - The offending method.
   */
  constructor(name, method) {
    super(
      `capability "${name}" declares method "${method}" but this plugin is read-only; ` +
        'only GET capabilities may be dispatched.',
    )
    this.name = 'ReadOnlyViolationError'
    this.code = 'FIGMA_READ_ONLY_VIOLATION'
    this.capability = name
    this.method = method
  }
}

/**
 * The credential is not configured at all.
 *
 * @param {string} ref - Credential reference name.
 * @returns {FigmaError} Structured error.
 */
export function unconfigured(ref) {
  return {
    kind: 'unconfigured',
    remedy:
      `No Figma token is configured for "${ref}". Nothing was requested from Figma.\n` +
      'Ask the user to do one of these, then retry:\n' +
      credentialDeliverySteps(ref) +
      '  4. Tell me once it is in place and I will retry the operation.',
  }
}

/**
 * Asking the credential service failed: there was no answer at all.
 *
 * Distinct from {@link unconfigured}, which means the service answered "no
 * token". Here the resolve call itself threw — an unreadable or corrupt
 * credentials file, a service that is not mounted, a watcher error. Reusing
 * `unconfigured` for this would tell the user to add a token that may already
 * be sitting in the file, which is a remedy that sends them the wrong way.
 *
 * @param {string} ref - Credential reference name.
 * @param {string} detail - Failure description, already redacted.
 * @returns {FigmaError} Structured error.
 */
export function credentialError(ref, detail) {
  return {
    kind: 'credential_error',
    remedy:
      `The credential service failed while resolving "${ref}", so no request was sent to Figma.\n` +
      `Reported failure: ${detail}\n` +
      'Ask the user to do one of these, then retry:\n' +
      '  1. Check that ~/.dsh/.credentials.yaml is readable and is still valid YAML —\n' +
      '     a file that no longer parses makes every credential unreadable, not just this one.\n' +
      `  2. Confirm the file has an entry named "${ref}" under "refs:".\n` +
      '  3. If the file looks correct, restart DSH: the credential service may not be\n' +
      '     mounted in this process.\n' +
      '  4. Tell me once it is sorted out and I will retry the operation.',
  }
}

/**
 * Figma rejected the credential itself (401, or a 403 that is not a scope
 * complaint).
 *
 * The last line is the important one: the model is explicitly authorized to ask
 * the user for a new token and then retry, which is what closes the loop.
 *
 * @param {string} ref - Credential reference name.
 * @param {{status?: number, detail?: string}} [context] - Response facts.
 * @returns {FigmaError} Structured error.
 */
export function tokenInvalid(ref, context = {}) {
  const status = context.status ?? 401
  const detail = context.detail === undefined ? '' : ` Figma said: ${context.detail}`
  return {
    kind: 'token_invalid',
    remedy:
      `The Figma token is no longer accepted (HTTP ${status} from Figma).${detail}\n` +
      'Personal access tokens last at most 90 days and cannot be refreshed, so this normally means it expired or was revoked.\n' +
      'Ask the user to do this, then retry:\n' +
      credentialDeliverySteps(ref) +
      '  4. Tell me once it is in place and I will retry the operation.',
  }
}

/**
 * Figma accepted the credential but it lacks a scope this capability needs.
 *
 * Figma lists every scope the token *does* hold in the 403 message, which is
 * exactly what the user needs in order to see what they granted.
 *
 * @param {{granted: string[], missing: string[], ref: string, detail?: string}} input - Parsed scope facts.
 * @returns {FigmaError} Structured error.
 */
export function forbiddenScope(input) {
  const granted = input.granted.length > 0 ? input.granted.join(', ') : '(Figma did not list any)'
  const missingLine =
    input.missing.length > 0
      ? `This capability needs: ${input.missing.join(', ')}.`
      : 'This capability needs a scope the token does not hold.'
  const widen =
    input.missing.length > 0
      ? `  2. Add these read-only scopes: ${input.missing.join(', ')}\n`
      : `  2. Keep the read-only scopes: ${READ_ONLY_SCOPES.join(', ')}\n`
  return {
    kind: 'forbidden_scope',
    granted: input.granted,
    missing: input.missing,
    remedy:
      `The Figma token is valid but lacks a required scope (HTTP 403).\n` +
      `${missingLine}\n` +
      `Scopes this token currently holds: ${granted}\n` +
      'Retrying will not help — a token cannot gain scopes.\n' +
      'Ask the user to do this, then retry:\n' +
      `  1. Open https://www.figma.com/settings → Security → Personal access tokens and edit or regenerate the token used for refs.${input.ref}\n` +
      widen +
      `  3. Save it (applied immediately — no restart needed), then tell me and I will retry.`,
  }
}

/**
 * Figma has no such file, node, or image.
 *
 * @param {{target?: string, nodeId?: string}} [context] - What was requested.
 * @returns {FigmaError} Structured error.
 */
export function notFound(context = {}) {
  const what = context.target === undefined ? 'that resource' : `"${context.target}"`
  const nodeHint =
    context.nodeId === undefined
      ? 'If a node id was given, re-read it from the link (`?node-id=12-345` becomes `12:345`).'
      : `Node "${context.nodeId}" was not found in the file — confirm it with \`file\` (a shallow read) or copy the link again.`
  return {
    kind: 'not_found',
    remedy:
      `Figma returned 404 for ${what}.\n` +
      `${nodeHint}\n` +
      'The file key may also belong to a file this token cannot see, or the link may point at a different Figma workspace.',
  }
}

/**
 * Figma rate-limited the request (429).
 *
 * `Retry-After`, `X-Figma-Rate-Limit-Type`, and `X-Figma-Upgrade-Link` appear
 * **only** on a 429 — a successful response never carries them, so the local
 * token bucket is the only budget signal during normal operation and these
 * headers are an after-the-fact correction.
 *
 * @param {{retryAfterSec: number, upgradeUrl?: string, limitType?: 'high'|'low'}} input - Parsed headers.
 * @returns {FigmaError} Structured error.
 */
export function rateLimited(input) {
  const upgrade =
    input.upgradeUrl === undefined ? '' : ` Figma suggests a higher plan for a larger budget: ${input.upgradeUrl}`
  const tier =
    input.limitType === undefined
      ? ''
      : input.limitType === 'low'
        ? ' The seat behind this token is a view/collaborator seat, which has a much smaller budget.'
        : ' The seat behind this token is a full/dev seat.'
  return {
    kind: 'rate_limited',
    retryAfterSec: input.retryAfterSec,
    ...(input.upgradeUrl === undefined ? {} : { upgradeUrl: input.upgradeUrl }),
    ...(input.limitType === undefined ? {} : { limitType: input.limitType }),
    remedy:
      `Figma rate-limited the request (HTTP 429). Wait ${input.retryAfterSec}s before retrying, ` +
      'or narrow the request first (a single node id with a small depth costs one request either way but returns far less).' +
      tier +
      upgrade,
  }
}

/**
 * The result did not fit the budget even after tightening.
 *
 * @param {{bytes: number, spoolPath?: string, suggestion: string}} input - Oversize facts.
 * @returns {FigmaError} Structured error.
 */
export function tooLarge(input) {
  return {
    kind: 'too_large',
    bytes: input.bytes,
    ...(input.spoolPath === undefined ? {} : { spoolPath: input.spoolPath }),
    suggestion: input.suggestion,
  }
}

/**
 * A declared parameter failed validation.
 *
 * @param {string} field - Offending parameter.
 * @param {string} reason - What was wrong.
 * @returns {FigmaError} Structured error.
 */
export function badArgs(field, reason) {
  return { kind: 'bad_args', field, reason }
}

/**
 * The requested `op` is not a declared capability.
 *
 * @param {string} requested - What was asked for.
 * @param {string[]} available - Every declared capability name.
 * @returns {FigmaError} Structured error.
 */
export function badOp(requested, available) {
  return { kind: 'bad_op', requested, available }
}

/**
 * Anything Figma returned that is not one of the classified cases.
 *
 * @param {number} status - HTTP status.
 * @param {string} body - Response body, already redacted and truncated.
 * @returns {FigmaError} Structured error.
 */
export function upstream(status, body) {
  const retryable = status >= 500
  return {
    kind: 'upstream',
    status,
    body,
    remedy: retryable
      ? `Figma returned HTTP ${status}. This is a server-side failure and is usually transient — retry the same call once before changing anything.`
      : `Figma returned HTTP ${status}, which this plugin does not classify. Response body: ${body}`,
  }
}

/**
 * Pull the scope list out of a Figma 403 message.
 *
 * Figma has used both `Invalid scope: […]` and `Invalid scope(s): …`, so the
 * match is on the `Invalid scope` prefix rather than on one exact wording.
 *
 * @param {string} message - Raw 403 message.
 * @returns {string[]} Scopes the token actually holds, in the order Figma listed them.
 */
export function parseGrantedScopes(message) {
  if (typeof message !== 'string') return []
  const marker = /Invalid scope(?:\(s\))?\s*:/i.exec(message)
  if (marker === null) return []
  const rest = message.slice(marker.index + marker[0].length)
  return rest
    .split(/[\s,[\]]+/)
    .map((token) => token.trim())
    .filter((token) => /^[A-Za-z][A-Za-z0-9_]*(?::[A-Za-z][A-Za-z0-9_]*)?$/.test(token))
}

/**
 * Whether a 403 body is a scope complaint rather than a credential problem.
 *
 * @param {string} message - Raw 403 message.
 * @returns {boolean} Whether the message complains about scopes.
 */
export function isScopeComplaint(message) {
  return typeof message === 'string' && /Invalid scope/i.test(message)
}

/**
 * Extract a human-readable message from a Figma error body.
 *
 * The scope list Figma appends to a 403 can be long, so the limit is a
 * parameter: display wants a short string, and scope parsing wants the whole
 * list.
 *
 * @param {string} body - Raw response body, which is not always JSON.
 * @param {number} [limit] - Maximum characters to return.
 * @returns {string} Best-effort message.
 */
export function messageFromBody(body, limit = 500) {
  if (typeof body !== 'string' || body.trim().length === 0) return ''
  try {
    const parsed = JSON.parse(body)
    if (parsed !== null && typeof parsed === 'object') {
      for (const key of ['message', 'err', 'error']) {
        const value = /** @type {Record<string, unknown>} */ (parsed)[key]
        if (typeof value === 'string' && value.length > 0) return value.slice(0, limit)
      }
    }
  } catch {
    // not JSON; fall through to the raw body
  }
  return body.slice(0, limit)
}

/**
 * Turn one HTTP response into a {@link FigmaError}, or `undefined` when the
 * status is a success.
 *
 * Order matters: status first, then body text. A 403 is a credential failure of
 * some kind in both readings, and the body says which.
 *
 * @param {object} input - Response facts.
 * @param {number} input.status - HTTP status.
 * @param {string} input.body - Raw body.
 * @param {Record<string, string>} input.headers - Lower-cased response headers.
 * @param {string} input.ref - Credential reference name.
 * @param {readonly string[]} [input.missingScopes] - Scopes the capability declares.
 * @param {(text: string) => string} [input.redact] - Scrubber applied to echoed body text.
 * @returns {FigmaError|undefined} Structured error, or `undefined` for 2xx.
 */
export function classifyResponse(input) {
  const { status, ref } = input
  if (status >= 200 && status < 300) return undefined

  const scrub = input.redact ?? ((text) => text)
  const detail = scrub(messageFromBody(input.body))

  if (status === 401) return tokenInvalid(ref, { status, detail })

  if (status === 403) {
    // Match and parse against the extracted message rather than the raw body,
    // so JSON quoting around the scope list cannot truncate it.
    const fullMessage = messageFromBody(input.body, 8_000)
    if (isScopeComplaint(fullMessage)) {
      const granted = parseGrantedScopes(fullMessage)
      const declared = input.missingScopes ?? []
      const missing = declared.filter((scope) => !granted.includes(scope))
      return forbiddenScope({ granted, missing: missing.length > 0 ? missing : declared, ref, detail })
    }
    // A 403 that is not a scope complaint is still an authentication failure;
    // both readings are handled, and the body decides which one it was.
    return tokenInvalid(ref, { status, detail })
  }

  if (status === 404) return notFound({ target: input.target })

  if (status === 429) {
    return rateLimited({
      retryAfterSec: parseRetryAfter(input.headers['retry-after']),
      upgradeUrl: nonEmpty(input.headers['x-figma-upgrade-link']),
      limitType: parseLimitType(input.headers['x-figma-rate-limit-type']),
    })
  }

  return upstream(status, detail)
}

/**
 * Parse `Retry-After`, which Figma sends as whole seconds.
 *
 * @param {string|undefined} value - Raw header value.
 * @returns {number} Seconds to wait; defaults to 60 when the header is missing or unparseable.
 */
export function parseRetryAfter(value) {
  if (typeof value === 'string') {
    const seconds = Number.parseInt(value.trim(), 10)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds
  }
  return 60
}

/**
 * Parse `X-Figma-Rate-Limit-Type`.
 *
 * @param {string|undefined} value - Raw header value.
 * @returns {'high'|'low'|undefined} Seat class, when Figma named one.
 */
export function parseLimitType(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'high') return 'high'
  if (normalized === 'low') return 'low'
  return undefined
}

/**
 * Treat an empty header value as absent.
 *
 * @param {unknown} value - Raw header value.
 * @returns {string|undefined} The value, or `undefined` when empty.
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}
