/**
 * Projection: raw Figma node trees to something a design engineer can read.
 *
 * This module is where the single most dangerous silent bug in the project
 * lives, so it is stated plainly:
 *
 * > A paint's `color.a` is the **color's alpha channel**, not the layer's
 * > transparency. Layer transparency is a **different field**, `fill.opacity`.
 *
 * Mixing them up does not fail. It produces a plausible-looking hex that is
 * simply wrong, and it is invisible on any file whose fills all happen to be
 * opaque — which is most of them. So: the hex is computed from `r`/`g`/`b`
 * only, and transparency is read from `fill.opacity` and emitted only when it
 * is not 1.
 *
 * Everything else here is a whitelist. A Figma node object carries close to a
 * hundred fields and almost none of them help the model; the discarded ones are
 * listed in `DISCARDED_NODE_FIELDS` so the next reader does not have to guess
 * whether an omission was deliberate.
 *
 * @module figma-mcp-dsh/core/projection
 */

/** Node fields kept verbatim. Everything not listed here or handled explicitly is dropped. */
export const KEPT_NODE_FIELDS = Object.freeze([
  'id',
  'name',
  'type',
  'layoutMode',
  'itemSpacing',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'primaryAxisSizingMode',
  'counterAxisSizingMode',
  // Alignment was the missing half of "how is this laid out": sizing and padding
  // were kept, but not which edge the content hugs. These only exist on
  // auto-layout nodes, so they cost nothing anywhere else.
  'primaryAxisAlignItems',
  'counterAxisAlignItems',
  'layoutWrap',
  'counterAxisSpacing',
  'cornerRadius',
  'strokeWeight',
  'componentId',
  // Booleans and vector operations change what a shape *is* (a union, a
  // subtraction); without this the model sees an unexplained outline.
  'booleanOperation',
])

/**
 * Node fields deliberately dropped, recorded so their absence reads as a
 * decision rather than an oversight. Kept as documentation, not as a runtime
 * filter — the projector is a whitelist, so it never consults this list.
 *
 * **This is not an exhaustive inventory of the Figma node type, and it does not
 * pretend to be.** It names the fields a reader is most likely to go looking
 * for, so that their absence is visibly a choice. Everything else is dropped by
 * the whitelist above without being listed here; if you need to know whether a
 * field survives, the answer is in `KEPT_NODE_FIELDS`, and the answer for
 * anything not there is no.
 */
export const DISCARDED_NODE_FIELDS = Object.freeze([
  'constraints',
  'relativeTransform',
  'absoluteRenderBounds',
  'blendMode',
  'background',
  'backgroundColor',
  'clipsContent',
  'complexStrokeProperties',
  'exportSettings',
  // Figma renamed this to `reactions`; the old spelling is kept as well so a
  // reader searching for either name finds the decision.
  'reactions',
  'interactions',
  'layoutAlign',
  'layoutGrow',
  'layoutSizingHorizontal',
  'layoutSizingVertical',
  'scrollBehavior',
  'strokeAlign',
  'strokeJoin',
  'strokesIncludedInLayout',
  'layoutGrids',
  // Vector geometry: an exact path is the renderer's business, not the
  // designer's, and it is the largest field on any vector node.
  'fillGeometry',
  'strokeGeometry',
  // A font file name, not a design choice — fontFamily and fontWeight already
  // carry what a designer would say out loud.
  'fontPostScriptName',
])

/** Text style fields kept; the rest are rendering implementation details. */
export const KEPT_TEXT_STYLE_FIELDS = Object.freeze([
  'fontFamily',
  'fontWeight',
  'fontSize',
  'textAlignHorizontal',
  // Where the text sits vertically matters as soon as the box is taller than
  // one line, which is the normal case for a design-system component.
  'textAlignVertical',
  'lineHeightPx',
  'letterSpacing',
  // Both are visible design decisions: `textCase` is how a label reads as
  // uppercase without the characters being typed that way, and `textDecoration`
  // is a deliberate underline or strikethrough.
  'textCase',
  'textDecoration',
])

/** Default cap on retained `characters` per text node. */
export const DEFAULT_MAX_TEXT_CHARS = 500

/** Default cap on palette entries returned. */
export const DEFAULT_PALETTE_LIMIT = 32

/**
 * Convert a Figma color to an uppercase hex string.
 *
 * **Only `r`, `g`, and `b` are read.** The alpha channel is not part of a hex
 * color, and treating it as opacity is the trap this function exists to close.
 *
 * @param {{r?: number, g?: number, b?: number}} color - Figma 0–1 float color.
 * @returns {string} Uppercase `#RRGGBB`.
 */
export function toHex(color) {
  const channel = (key) => {
    const value = typeof color?.[key] === 'number' ? color[key] : 0
    return Math.min(255, Math.max(0, Math.round(255 * value)))
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel('r')}${channel('g')}${channel('b')}`.toUpperCase()
}

/**
 * Project a gradient's color stops.
 *
 * A gradient carries its colors in `gradientStops`, **not** in `color`, so a
 * projector that only reads `color` emits a paint with its `type` and nothing
 * else — every gradient color silently lost, and the palette contribution with
 * it. That is the defect this function closes.
 *
 * Each stop keeps its `position`, so the ramp survives rather than collapsing
 * into an unordered set of colors. A stop whose color is not fully opaque also
 * keeps `alpha`:
 *
 * **`alpha` here is not the trap that `color.a` is for a paint.** On a paint,
 * `color.a` is the color's alpha channel and layer transparency lives in
 * `paint.opacity` — reading one as the other is the bug `toHex` exists to
 * prevent. On a *stop*, `color.a` is the stop's own alpha and there is no other
 * field for it: a gradient fading to transparent would otherwise project as a
 * solid color. The field is named `alpha` rather than `opacity` so the two
 * cannot be confused.
 *
 * @param {unknown} stops - Raw `gradientStops`.
 * @returns {Array<{position: number, hex: string, alpha?: number}>|undefined} Projected stops.
 */
function projectGradientStops(stops) {
  if (!Array.isArray(stops)) return undefined
  /** @type {Array<{position: number, hex: string, alpha?: number}>} */
  const out = []
  for (const stop of stops) {
    if (stop === null || typeof stop !== 'object') continue
    const source = /** @type {{position?: unknown, color?: unknown}} */ (stop)
    const color = source.color
    if (color === null || typeof color !== 'object') continue
    /** @type {{position: number, hex: string, alpha?: number}} */
    const entry = {
      position: typeof source.position === 'number' ? source.position : 0,
      hex: toHex(/** @type {{r?: number, g?: number, b?: number}} */ (color)),
    }
    const alpha = /** @type {{a?: unknown}} */ (color).a
    if (typeof alpha === 'number' && alpha !== 1) entry.alpha = alpha
    out.push(entry)
  }
  return out.length === 0 ? undefined : out
}

/**
 * Project one paint (an entry of `fills` or `strokes`).
 *
 * Paint-level `blendMode` is dropped on purpose, and unlike the node-level field
 * of the same name it is not listed in `DISCARDED_NODE_FIELDS` (which is about
 * nodes). A blend mode describes how a layer composites with what is under it —
 * a rendering instruction whose effect is exactly what the rendered image
 * already shows. When a question turns on it, `image_render` is the honest
 * answer, not a string the model has to interpret.
 *
 * @param {unknown} paint - Raw Figma paint.
 * @returns {Record<string, unknown>|undefined} Projected paint, or `undefined` when unusable.
 */
export function projectPaint(paint) {
  if (paint === null || typeof paint !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (paint)
  const type = typeof source.type === 'string' ? source.type : undefined
  if (type === undefined) return undefined

  /** @type {Record<string, unknown>} */
  const out = { type }

  const color = source.color
  if (color !== null && typeof color === 'object') {
    out.hex = toHex(/** @type {{r?: number, g?: number, b?: number}} */ (color))
  }
  // Gradient paints have no `color` at all: their colours live in the stops.
  const stops = projectGradientStops(source.gradientStops)
  if (stops !== undefined) out.stops = stops
  // Transparency, read from the paint's own opacity field — never from color.a.
  if (typeof source.opacity === 'number' && source.opacity !== 1) out.opacity = source.opacity
  if (source.visible === false) out.hidden = true
  if (type === 'IMAGE' && typeof source.imageRef === 'string') out.imageRef = source.imageRef
  if (typeof source.scaleMode === 'string') out.scaleMode = source.scaleMode
  return out
}

/**
 * Project one effect.
 *
 * @param {unknown} effect - Raw Figma effect.
 * @returns {Record<string, unknown>|undefined} Projected effect, or `undefined` when unusable.
 */
export function projectEffect(effect) {
  if (effect === null || typeof effect !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (effect)
  if (typeof source.type !== 'string') return undefined

  /** @type {Record<string, unknown>} */
  const out = { type: source.type }
  const color = source.color
  if (color !== null && typeof color === 'object') {
    out.hex = toHex(/** @type {{r?: number, g?: number, b?: number}} */ (color))
  }
  const offset = source.offset
  if (offset !== null && typeof offset === 'object') {
    const raw = /** @type {{x?: number, y?: number}} */ (offset)
    out.offset = { x: Math.round(raw.x ?? 0), y: Math.round(raw.y ?? 0) }
  }
  if (typeof source.radius === 'number') out.radius = source.radius
  if (typeof source.spread === 'number' && source.spread !== 0) out.spread = source.spread
  if (source.visible === false) out.hidden = true
  return out
}

/**
 * Project `absoluteBoundingBox` into a rounded `box`, dropping the original.
 *
 * @param {unknown} box - Raw `absoluteBoundingBox`.
 * @returns {{x: number, y: number, w: number, h: number}|undefined} Rounded box.
 */
export function projectBox(box) {
  if (box === null || typeof box !== 'object') return undefined
  const source = /** @type {{x?: number, y?: number, width?: number, height?: number}} */ (box)
  if (typeof source.width !== 'number' || typeof source.height !== 'number') return undefined
  return {
    x: Math.round(source.x ?? 0),
    y: Math.round(source.y ?? 0),
    w: Math.round(source.width),
    h: Math.round(source.height),
  }
}

/**
 * Project a text style, keeping only what a designer would name.
 *
 * @param {unknown} style - Raw `style` object.
 * @returns {Record<string, unknown>|undefined} Projected style.
 */
export function projectTextStyle(style) {
  if (style === null || typeof style !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (style)
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const field of KEPT_TEXT_STYLE_FIELDS) {
    const value = source[field]
    if (value !== undefined && value !== null) out[field] = value
  }

  // Line height is one value and three fields. `lineHeightPx` is the useful one
  // when it exists; when the unit is PERCENT or AUTO, Figma frequently omits it
  // and the percent is the only measurement there is. The unit is kept so the
  // model knows which number it is reading, and the percent is kept only when
  // it is the one that answers the question.
  if (typeof source.lineHeightUnit === 'string') out.lineHeightUnit = source.lineHeightUnit
  if (out.lineHeightPx === undefined && typeof source.lineHeightPercent === 'number') {
    out.lineHeightPercent = source.lineHeightPercent
  }

  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Project component property values, keeping scalars only.
 *
 * @param {unknown} properties - Raw `componentProperties`.
 * @returns {Record<string, unknown>|undefined} Projected properties.
 */
export function projectComponentProperties(properties) {
  if (properties === null || typeof properties !== 'object') return undefined
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [name, raw] of Object.entries(/** @type {Record<string, unknown>} */ (properties))) {
    const entry = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : undefined
    const value = entry !== undefined && 'value' in entry ? entry.value : raw
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[name] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Resolve a node's `styles` references into readable names.
 *
 * The map looks like `{ fill: "1:2", text: "3:4" }` — a style *kind* to
 * style *id*. Each reference becomes `{id}` plus the style's name and type when
 * the response carried the style table. An unresolved reference keeps its id:
 * a dangling id is still evidence the layer is styled, and guessing a name (or
 * spending another request to find one) would be worse than saying nothing.
 *
 * @param {unknown} styles - Raw `styles` map from the node.
 * @param {Map<string, unknown>|undefined} styleIndex - Style table from the same response.
 * @returns {Record<string, unknown>|undefined} Resolved references, or `undefined` when the node has none.
 */
export function projectStyleRefs(styles, styleIndex) {
  if (styles === null || typeof styles !== 'object' || Array.isArray(styles)) return undefined
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [kind, ref] of Object.entries(/** @type {Record<string, unknown>} */ (styles))) {
    if (typeof ref !== 'string' || ref.length === 0) continue
    const known = styleIndex?.get(ref)
    if (known === null || typeof known !== 'object') {
      out[kind] = { id: ref }
      continue
    }
    const record = /** @type {Record<string, unknown>} */ (known)
    out[kind] = {
      id: ref,
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.styleType === 'string' ? { styleType: record.styleType } : {}),
    }
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Parse variant properties out of a component name.
 *
 * The REST API carries no structured variant data: measured on a real file,
 * `componentPropertyDefinitions` and `componentSetId` are absent from variant
 * `COMPONENT` nodes, and `componentProperties` is absent from their `INSTANCE`
 * nodes. The only place a variant exists is the name string, so it is parsed
 * from there.
 *
 * Never throws: a name without variant syntax is simply a name, and callers
 * keep the original string unchanged.
 *
 * @param {unknown} name - Component name, such as `Card/Ratio=2:3`.
 * @returns {{base: string, variants: Record<string, string>}|undefined} Parsed form, or `undefined` when the name carries no variant syntax.
 */
export function parseVariantName(name) {
  if (typeof name !== 'string' || name.length === 0) return undefined
  const segments = name.split('/')
  if (segments.length < 2) return undefined

  /** @type {Array<[string, string]>} */
  const properties = []
  let index = segments.length
  while (index > 0) {
    const segment = segments[index - 1]
    const separator = segment.indexOf('=')
    // A trailing segment only counts as a variant when it is exactly `Key=Value`.
    if (separator <= 0 || separator === segment.length - 1) break
    const key = segment.slice(0, separator).trim()
    const value = segment.slice(separator + 1).trim()
    if (key.length === 0 || value.length === 0) break
    properties.unshift([key, value])
    index -= 1
  }
  if (properties.length === 0) return undefined

  const base = segments.slice(0, index).join('/').trim()
  if (base.length === 0) return undefined

  /** @type {Record<string, string>} */
  const variants = {}
  for (const [key, value] of properties) variants[key] = value
  return { base, variants }
}

/**
 * Read one resource map out of a `/v1/files/:key` payload.
 *
 * Deliberately reads the payload's own map rather than the matching dedicated
 * endpoint. Measured on one file and one version, back to back:
 * `/files/:key/components` answered `{"meta":{"components":[]}}` while the same
 * file's `/files?depth=2` carried `components=2` — because the dedicated
 * endpoints list only what a team **published**, and the file's own resources
 * need not be published. Reporting "this file has no components" for a file
 * that plainly has them is the worst available failure mode, so the map wins.
 *
 * @param {unknown} raw - Raw response payload.
 * @param {string} key - Which map to read.
 * @returns {Array<{id: string, entry: Record<string, unknown>}>} Entries in payload order.
 */
function readResourceMap(raw, key) {
  const source = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const map = source[key]
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return []
  /** @type {Array<{id: string, entry: Record<string, unknown>}>} */
  const entries = []
  for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (map))) {
    if (value === null || typeof value !== 'object') continue
    entries.push({ id, entry: /** @type {Record<string, unknown>} */ (value) })
  }
  return entries
}

/**
 * Project a file's local components.
 *
 * @param {unknown} raw - Raw `/v1/files/:key` payload.
 * @returns {{components: Array<Record<string, unknown>>, total: number}} Projected components.
 */
export function projectComponents(raw) {
  const entries = readResourceMap(raw, 'components')
  const components = entries.map(({ id, entry }) => {
    const name = typeof entry.name === 'string' ? entry.name : ''
    const parsed = parseVariantName(name)
    return {
      id,
      name,
      ...(typeof entry.key === 'string' ? { key: entry.key } : {}),
      ...(typeof entry.description === 'string' && entry.description.length > 0 ? { description: entry.description } : {}),
      ...(typeof entry.componentSetId === 'string' ? { componentSetId: entry.componentSetId } : {}),
      ...(typeof entry.remote === 'boolean' ? { remote: entry.remote } : {}),
      ...(parsed === undefined ? {} : { base: parsed.base, variants: parsed.variants }),
    }
  })
  return { components, total: components.length }
}

/**
 * Project a file's local component sets (variant groups).
 *
 * @param {unknown} raw - Raw `/v1/files/:key` payload.
 * @returns {{componentSets: Array<Record<string, unknown>>, total: number}} Projected component sets.
 */
export function projectComponentSets(raw) {
  const entries = readResourceMap(raw, 'componentSets')
  const componentSets = entries.map(({ id, entry }) => ({
    id,
    name: typeof entry.name === 'string' ? entry.name : '',
    ...(typeof entry.key === 'string' ? { key: entry.key } : {}),
    ...(typeof entry.description === 'string' && entry.description.length > 0 ? { description: entry.description } : {}),
    ...(typeof entry.remote === 'boolean' ? { remote: entry.remote } : {}),
  }))
  return { componentSets, total: componentSets.length }
}

/**
 * Project a file's local styles.
 *
 * The discriminant is `styleType` (`FILL` / `TEXT` / `EFFECT` / `GRID`), **not**
 * `type` — the two names differ and only one of them is populated.
 *
 * @param {unknown} raw - Raw `/v1/files/:key` payload.
 * @returns {{styles: Array<Record<string, unknown>>, total: number}} Projected styles.
 */
export function projectStyles(raw) {
  const entries = readResourceMap(raw, 'styles')
  const styles = entries.map(({ id, entry }) => ({
    id,
    name: typeof entry.name === 'string' ? entry.name : '',
    ...(typeof entry.styleType === 'string' ? { styleType: entry.styleType } : {}),
    ...(typeof entry.key === 'string' ? { key: entry.key } : {}),
    ...(typeof entry.description === 'string' && entry.description.length > 0 ? { description: entry.description } : {}),
    ...(typeof entry.remote === 'boolean' ? { remote: entry.remote } : {}),
  }))
  return { styles, total: styles.length }
}

/**
 * Strip a node subtree down to the whitelist.
 *
 * @param {unknown} node - Raw Figma node.
 * @param {{maxTextChars?: number, includeGeometry?: boolean, styleIndex?: Map<string, unknown>}} [options] - Projection options.
 *   `styleIndex` is optional: without it a style reference still survives, it
 *   simply carries only its id.
 * @returns {Record<string, unknown>|undefined} Projected node, or `undefined` for a non-object.
 */
export function projectNode(node, options = {}) {
  if (node === null || typeof node !== 'object') return undefined
  const source = /** @type {Record<string, unknown>} */ (node)
  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS

  /** @type {Record<string, unknown>} */
  const out = {}
  for (const field of KEPT_NODE_FIELDS) {
    const value = source[field]
    if (value !== undefined && value !== null) out[field] = value
  }

  // Geometry is the answer to "are these two things aligned?", so the absolute
  // box is kept by default and the original raw field is dropped.
  const box = projectBox(source.absoluteBoundingBox ?? (options.includeGeometry === true ? source.boundingBox : undefined))
  if (box !== undefined) out.box = box

  const fills = projectPaintList(source.fills)
  if (fills !== undefined) out.fills = fills
  const strokes = projectPaintList(source.strokes)
  if (strokes !== undefined) out.strokes = strokes
  const effects = projectEffectList(source.effects)
  if (effects !== undefined) out.effects = effects

  if (typeof source.opacity === 'number' && source.opacity !== 1) out.opacity = source.opacity
  if (source.visible === false) out.visible = false

  // Rotation is the one dropped field whose absence produces a *wrong*
  // conclusion rather than a missing detail: `absoluteBoundingBox` is
  // axis-aligned, so a tilted layer reads as a straight one and the model will
  // say so with confidence. Emitted only when non-zero, which keeps it free for
  // the overwhelming majority of nodes.
  if (typeof source.rotation === 'number' && source.rotation !== 0) out.rotation = source.rotation

  // `isMask` is false on almost every node, so it is emitted like `visible`:
  // only when it is the interesting value.
  if (source.isMask === true) {
    out.isMask = true
    if (typeof source.maskType === 'string') out.maskType = source.maskType
  }

  if (typeof source.characters === 'string') {
    if (source.characters.length > maxTextChars) {
      out.characters = source.characters.slice(0, maxTextChars)
      // Never truncate silently: the model has to know the text continues.
      out.textTruncatedAt = source.characters.length
    } else {
      out.characters = source.characters
    }
    const style = projectTextStyle(source.style)
    if (style !== undefined) out.style = style
  } else if (source.style !== undefined) {
    const style = projectTextStyle(source.style)
    if (style !== undefined) out.style = style
  }

  const componentProperties = projectComponentProperties(source.componentProperties)
  if (componentProperties !== undefined) out.componentProperties = componentProperties

  // A node's `styles` map is how a design system is actually applied — it is
  // the only link from a layer to a published style — so dropping it, as P0
  // did, makes "which style does this use?" unanswerable.
  const styles = projectStyleRefs(source.styles, options.styleIndex)
  if (styles !== undefined) out.styles = styles

  if (Array.isArray(source.children) && source.children.length > 0) {
    const children = []
    for (const child of source.children) {
      const projected = projectNode(child, options)
      if (projected !== undefined) children.push(projected)
    }
    if (children.length > 0) out.children = children
  }

  return out
}

/**
 * Project a paint list, dropping entries that carry nothing usable.
 *
 * @param {unknown} list - Raw `fills` or `strokes`.
 * @returns {Array<Record<string, unknown>>|undefined} Projected list.
 */
function projectPaintList(list) {
  if (!Array.isArray(list) || list.length === 0) return undefined
  const out = []
  for (const paint of list) {
    const projected = projectPaint(paint)
    if (projected !== undefined) out.push(projected)
  }
  return out.length === 0 ? undefined : out
}

/**
 * Project an effect list.
 *
 * @param {unknown} list - Raw `effects`.
 * @returns {Array<Record<string, unknown>>|undefined} Projected list.
 */
function projectEffectList(list) {
  if (!Array.isArray(list) || list.length === 0) return undefined
  const out = []
  for (const effect of list) {
    const projected = projectEffect(effect)
    if (projected !== undefined) out.push(projected)
  }
  return out.length === 0 ? undefined : out
}

/**
 * Project a `/v1/files/:key/meta` payload.
 *
 * ## Two shapes, and why this reads both
 *
 * The documented examples show a flat object, but the endpoint actually
 * returns everything **nested under `file`**, and it uses snake_case for the
 * timestamp fields (`last_touched_at`) while `name`, `version`, `role`, and
 * `editorType` stay camel-free. A whitelist written from the documentation
 * therefore matches nothing and answers `{}` — a silent wrong answer, which is
 * the worst possible outcome, so both spellings and both nestings are read.
 *
 * `version` is the field that makes explicit cache invalidation possible: when
 * it changes, everything cached for that file is stale.
 *
 * `thumbnailUrl` is deliberately dropped. It is a signed URL roughly four
 * hundred characters long, it is not needed by anything this plugin does, and
 * `image_render` is the supported way to look at a design.
 *
 * @param {unknown} raw - Raw meta payload.
 * @returns {Record<string, unknown>} Projected metadata.
 */
export function projectFileMeta(raw) {
  if (raw === null || typeof raw !== 'object') return {}
  const outer = /** @type {Record<string, unknown>} */ (raw)
  // Real responses nest under `file`; flat payloads are accepted too.
  const inner = outer.file
  const source = inner !== null && typeof inner === 'object' ? /** @type {Record<string, unknown>} */ (inner) : outer

  /**
   * First present value among alternative spellings.
   *
   * @param {string[]} names - Candidate field names.
   * @returns {unknown} The value, or `undefined`.
   */
  const pick = (...names) => {
    for (const name of names) {
      const value = source[name]
      if (value !== undefined && value !== null) return value
    }
    return undefined
  }

  /** @type {Record<string, unknown>} */
  const out = {}
  const fields = {
    name: pick('name'),
    folder: pick('folder', 'folder_name'),
    lastModified: pick('lastModified', 'last_modified'),
    lastTouchedAt: pick('lastTouchedAt', 'last_touched_at'),
    version: pick('version'),
    role: pick('role'),
    editorType: pick('editorType'),
    linkAccess: pick('linkAccess', 'link_access'),
  }
  for (const [key, value] of Object.entries(fields)) {
    // An empty string here is an absent value, not information.
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }

  const creator = source.creator
  if (creator !== null && typeof creator === 'object') {
    const handle = /** @type {Record<string, unknown>} */ (creator).handle
    if (typeof handle === 'string' && handle.length > 0) out.creator = handle
  }
  return out
}

/**
 * Project a `/v1/images/:key` payload.
 *
 * The values are short-lived signed URLs, never bytes.
 *
 * @param {unknown} raw - Raw image payload.
 * @returns {{images: Record<string, string>, missing: string[], err?: string}} Signed URLs by node id.
 */
export function projectImageUrls(raw) {
  if (raw === null || typeof raw !== 'object') return { images: {}, missing: [] }
  const source = /** @type {Record<string, unknown>} */ (raw)
  /** @type {Record<string, string>} */
  const images = {}
  /** @type {string[]} */
  const missing = []
  const rawImages = source.images
  if (rawImages !== null && typeof rawImages === 'object') {
    for (const [nodeId, url] of Object.entries(/** @type {Record<string, unknown>} */ (rawImages))) {
      if (typeof url === 'string' && url.length > 0) images[nodeId] = url
      else missing.push(nodeId)
    }
  }
  const err = typeof source.err === 'string' && source.err.length > 0 ? source.err : undefined
  return { images, missing, ...(err === undefined ? {} : { err }) }
}

/**
 * Build the id → style lookup used to resolve a node's `styles` references.
 *
 * Both node endpoints ship a style map inside the same response: `/v1/files/:key`
 * has it at the top level, while `/v1/files/:key/nodes` carries one per
 * requested node. Merging them here means a reference is always resolved from
 * data already in hand — no extra request.
 *
 * @param {Record<string, unknown>} source - Raw response payload.
 * @param {Record<string, unknown>|undefined} nodes - The raw `nodes` map, when present.
 * @returns {Map<string, {name?: string, styleType?: string, key?: string}>} Style index.
 */
function buildStyleIndex(source, nodes) {
  /** @type {Map<string, {name?: string, styleType?: string, key?: string}>} */
  const index = new Map()
  const absorb = (map) => {
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return
    for (const [id, entry] of Object.entries(/** @type {Record<string, unknown>} */ (map))) {
      if (entry === null || typeof entry !== 'object') continue
      const record = /** @type {Record<string, unknown>} */ (entry)
      index.set(id, {
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        ...(typeof record.styleType === 'string' ? { styleType: record.styleType } : {}),
        ...(typeof record.key === 'string' ? { key: record.key } : {}),
      })
    }
  }
  absorb(source.styles)
  if (nodes !== null && typeof nodes === 'object') {
    for (const entry of Object.values(/** @type {Record<string, unknown>} */ (nodes))) {
      if (entry === null || typeof entry !== 'object') continue
      absorb(/** @type {Record<string, unknown>} */ (entry).styles)
    }
  }
  return index
}

/**
 * Project a whole document-tree payload.
 *
 * Handles both shapes the two node endpoints return: `/v1/files/:key` puts the
 * tree under `document`, while `/v1/files/:key/nodes` returns a map of
 * requested node id to `{document}`.
 *
 * @param {unknown} raw - Raw response payload.
 * @param {{maxTextChars?: number, includeGeometry?: boolean, styleIndex?: Map<string, unknown>}} [options] - Projection options.
 * @returns {Record<string, unknown>} Projected tree with palette, effect colors, fonts, and statistics.
 */
export function projectNodeTree(raw, options = {}) {
  const source = raw !== null && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}

  /** @type {Array<Record<string, unknown>>} */
  const roots = []
  /** @type {Array<{id: string, error: string}>} */
  const missing = []
  /** @type {Record<string, unknown>|undefined} */
  let file

  const nodes = source.nodes
  // A node's `styles` references can only be resolved against the map that
  // arrived in the same response, so the index is derived here rather than
  // being the caller's problem.
  const styleIndex = options.styleIndex ?? buildStyleIndex(source, nodes !== null && typeof nodes === 'object' ? /** @type {Record<string, unknown>} */ (nodes) : undefined)
  const nodeOptions = { ...options, styleIndex }

  if (nodes !== null && typeof nodes === 'object') {
    for (const [id, entry] of Object.entries(/** @type {Record<string, unknown>} */ (nodes))) {
      const record = entry !== null && typeof entry === 'object' ? /** @type {Record<string, unknown>} */ (entry) : {}
      const document = record.document
      if (document === undefined) {
        const error = typeof record.err === 'string' ? record.err : 'node not returned'
        missing.push({ id, error })
        continue
      }
      const projected = projectNode(document, nodeOptions)
      if (projected !== undefined) roots.push(projected)
    }
  } else if (source.document !== undefined) {
    const projected = projectNode(source.document, nodeOptions)
    if (projected !== undefined) roots.push(projected)
    file = {}
    for (const field of ['name', 'lastModified', 'version', 'editorType']) {
      const value = source[field]
      if (value !== undefined && value !== null) /** @type {Record<string, unknown>} */ (file)[field] = value
    }
  }

  const palette = collectPaletteMany(roots)
  const effectColors = collectEffectColorsMany(roots)
  const fonts = collectFontsMany(roots)
  const stats = collectStats(roots)

  return {
    source: nodes !== null && typeof nodes === 'object' ? 'nodes' : 'file',
    ...(file === undefined ? {} : { file }),
    roots,
    ...(missing.length === 0 ? {} : { missing }),
    palette,
    ...(effectColors.length === 0 ? {} : { effectColors }),
    fonts,
    stats,
  }
}

/**
 * Rank a color counter into a bounded, most-used-first list.
 *
 * @param {Map<string, number>} counts - Hex to occurrence count.
 * @param {number} limit - Maximum entries to return.
 * @returns {import('./types.js').PaletteEntry[]} Ranked entries.
 */
function rankedPalette(counts, limit) {
  return [...counts.entries()]
    .map(([hex, count]) => ({ hex, count }))
    .sort((a, b) => b.count - a.count || a.hex.localeCompare(b.hex))
    .slice(0, limit)
}

/**
 * Count paint colors across a projected forest.
 *
 * Split into fills and strokes, and **effects are not included**. A drop
 * shadow's color is a real design decision, but it is not a fill: mixing the
 * two let a plain shadow with no fill anywhere still read as "this design uses
 * black". Effect colors are reported separately by
 * {@link collectEffectColorsMany}.
 *
 * A gradient contributes **its stops**, not one color: the stops are the colors
 * the design actually uses, and a paint-level average would be a color that
 * appears nowhere in the file.
 *
 * @param {readonly unknown[]} roots - Projected roots.
 * @param {{limit?: number}} [options] - Collection options.
 * @returns {{fills: import('./types.js').PaletteEntry[], strokes: import('./types.js').PaletteEntry[]}} Palette.
 */
export function collectPaletteMany(roots, options = {}) {
  const limit = options.limit ?? DEFAULT_PALETTE_LIMIT
  /** @type {Map<string, number>} */
  const fillCounts = new Map()
  /** @type {Map<string, number>} */
  const strokeCounts = new Map()
  for (const root of roots) collectPaintInto(root, fillCounts, strokeCounts)
  return { fills: rankedPalette(fillCounts, limit), strokes: rankedPalette(strokeCounts, limit) }
}

/**
 * Count paint colors in one projected node tree.
 *
 * @param {unknown} node - Projected node.
 * @param {{limit?: number}} [options] - Collection options.
 * @returns {{fills: import('./types.js').PaletteEntry[], strokes: import('./types.js').PaletteEntry[]}} Palette.
 */
export function collectPalette(node, options = {}) {
  return collectPaletteMany([node], options)
}

/**
 * Count effect colors (shadows, glows) across a projected forest.
 *
 * @param {readonly unknown[]} roots - Projected roots.
 * @param {{limit?: number}} [options] - Collection options.
 * @returns {import('./types.js').PaletteEntry[]} Effect colors, most-used first.
 */
export function collectEffectColorsMany(roots, options = {}) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const root of roots) collectEffectInto(root, counts)
  return rankedPalette(counts, options.limit ?? DEFAULT_PALETTE_LIMIT)
}

/**
 * Count effect colors in one projected node tree.
 *
 * @param {unknown} node - Projected node.
 * @param {{limit?: number}} [options] - Collection options.
 * @returns {import('./types.js').PaletteEntry[]} Effect colors, most-used first.
 */
export function collectEffectColors(node, options = {}) {
  return collectEffectColorsMany([node], options)
}

/**
 * Accumulate fill and stroke colors from one projected node.
 *
 * @param {unknown} node - Projected node.
 * @param {Map<string, number>} fillCounts - Fill counter to update.
 * @param {Map<string, number>} strokeCounts - Stroke counter to update.
 */
function collectPaintInto(node, fillCounts, strokeCounts) {
  if (node === null || typeof node !== 'object') return
  const record = /** @type {Record<string, unknown>} */ (node)
  for (const [field, counts] of [['fills', fillCounts], ['strokes', strokeCounts]]) {
    const list = record[field]
    if (!Array.isArray(list)) continue
    for (const paint of list) {
      if (paint === null || typeof paint !== 'object') continue
      const entry = /** @type {Record<string, unknown>} */ (paint)
      const hex = entry.hex
      if (typeof hex === 'string') counts.set(hex, (counts.get(hex) ?? 0) + 1)
      // A gradient has no `hex` of its own — its colors are the stops. Counting
      // only `hex` left a gradient-only design with an empty palette, which
      // reads as "this design has no colour" rather than "the colours are in a
      // gradient". Each stop counts once, like a solid paint would.
      const stops = entry.stops
      if (!Array.isArray(stops)) continue
      for (const stop of stops) {
        if (stop === null || typeof stop !== 'object') continue
        const stopHex = /** @type {Record<string, unknown>} */ (stop).hex
        if (typeof stopHex === 'string') counts.set(stopHex, (counts.get(stopHex) ?? 0) + 1)
      }
    }
  }
  const children = record.children
  if (Array.isArray(children)) for (const child of children) collectPaintInto(child, fillCounts, strokeCounts)
}

/**
 * Accumulate effect colors from one projected node.
 *
 * @param {unknown} node - Projected node.
 * @param {Map<string, number>} counts - Counter to update.
 */
function collectEffectInto(node, counts) {
  if (node === null || typeof node !== 'object') return
  const record = /** @type {Record<string, unknown>} */ (node)
  const effects = record.effects
  if (Array.isArray(effects)) {
    for (const effect of effects) {
      if (effect === null || typeof effect !== 'object') continue
      const hex = /** @type {Record<string, unknown>} */ (effect).hex
      if (typeof hex === 'string') counts.set(hex, (counts.get(hex) ?? 0) + 1)
    }
  }
  const children = record.children
  if (Array.isArray(children)) for (const child of children) collectEffectInto(child, counts)
}

/**
 * Collect the typographic scale across a projected forest.
 *
 * @param {readonly unknown[]} roots - Projected roots.
 * @returns {string[]} Entries such as `Inter 600 13px`, sorted.
 */
export function collectFontsMany(roots) {
  /** @type {Set<string>} */
  const fonts = new Set()
  for (const root of roots) collectFontsInto(root, fonts)
  return [...fonts].sort()
}

/**
 * Collect the typographic scale in one projected node tree.
 *
 * @param {unknown} node - Projected node.
 * @returns {string[]} Entries such as `Inter 600 13px`, sorted.
 */
export function collectFonts(node) {
  return collectFontsMany([node])
}

/**
 * Accumulate one node's text style into a set.
 *
 * @param {unknown} node - Projected node.
 * @param {Set<string>} fonts - Set to update.
 */
function collectFontsInto(node, fonts) {
  if (node === null || typeof node !== 'object') return
  const record = /** @type {Record<string, unknown>} */ (node)
  const style = record.style
  if (style !== null && typeof style === 'object') {
    const { fontFamily, fontWeight, fontSize } = /** @type {Record<string, unknown>} */ (style)
    if (typeof fontFamily === 'string' && typeof fontSize === 'number') {
      fonts.add(`${fontFamily} ${fontWeight ?? 400} ${fontSize}px`)
    }
  }
  const children = record.children
  if (Array.isArray(children)) for (const child of children) collectFontsInto(child, fonts)
}

/**
 * Count nodes, types, and depth across a projected forest.
 *
 * @param {readonly unknown[]} roots - Projected roots.
 * @returns {{nodeCount: number, maxDepth: number, byType: Record<string, number>}} Statistics.
 */
export function collectStats(roots) {
  let nodeCount = 0
  let maxDepth = 0
  /** @type {Record<string, number>} */
  const byType = {}
  const walk = (node, depth) => {
    if (node === null || typeof node !== 'object') return
    const record = /** @type {Record<string, unknown>} */ (node)
    nodeCount += 1
    if (depth > maxDepth) maxDepth = depth
    if (typeof record.type === 'string') byType[record.type] = (byType[record.type] ?? 0) + 1
    const children = record.children
    if (Array.isArray(children)) for (const child of children) walk(child, depth + 1)
  }
  for (const root of roots) walk(root, 1)
  return { nodeCount, maxDepth, byType }
}

/** Default number of children a skeleton keeps per node. */
export const DEFAULT_SKELETON_CHILDREN = 40

/**
 * Build the structure skeleton used when a projection still does not fit.
 *
 * The skeleton keeps the shape a model needs to navigate — container nodes,
 * their sizes, and how many children each one has — plus the palette and font
 * summary. The full projection goes to disk instead of into the context.
 *
 * It is bounded in **both** directions. Capping depth alone is not enough: one
 * frame with three thousand children would still produce a skeleton larger than
 * the budget it was supposed to relieve, so each level keeps only the first
 * {@link DEFAULT_SKELETON_CHILDREN} children and reports the rest as a count.
 *
 * @param {Record<string, unknown>} projected - A value produced by {@link projectNodeTree}.
 * @param {{maxDepth?: number, maxChildren?: number}} [options] - Skeleton options.
 * @returns {Record<string, unknown>} Skeleton value.
 */
export function buildSkeleton(projected, options = {}) {
  const maxDepth = options.maxDepth ?? 2
  const maxChildren = options.maxChildren ?? DEFAULT_SKELETON_CHILDREN
  const roots = Array.isArray(projected.roots) ? projected.roots : []
  const skeletonNode = (node, depth) => {
    if (node === null || typeof node !== 'object') return undefined
    const record = /** @type {Record<string, unknown>} */ (node)
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const field of ['id', 'name', 'type', 'layoutMode', 'box']) {
      if (record[field] !== undefined) out[field] = record[field]
    }
    const children = Array.isArray(record.children) ? record.children : []
    out.childCount = children.length
    if (depth < maxDepth && children.length > 0) {
      const kept = []
      for (const child of children.slice(0, maxChildren)) {
        const projected = skeletonNode(child, depth + 1)
        if (projected !== undefined) kept.push(projected)
      }
      if (kept.length > 0) out.children = kept
      if (children.length > maxChildren) out.omittedChildren = children.length - maxChildren
    }
    return out
  }

  return {
    skeleton: true,
    note:
      'This is a structure skeleton: container nodes with child counts, not the full detail. ' +
      'The complete projection was written to the path in "spooled". Read that file, or call again with a narrower ' +
      'ids/depth to get detail inline.',
    source: projected.source,
    ...(projected.file === undefined ? {} : { file: projected.file }),
    ...(projected.missing === undefined ? {} : { missing: projected.missing }),
    roots: roots.map((root) => skeletonNode(root, 1)).filter((node) => node !== undefined),
    palette: projected.palette,
    ...(projected.effectColors === undefined ? {} : { effectColors: projected.effectColors }),
    fonts: projected.fonts,
    stats: projected.stats,
  }
}
