/**
 * Projection, and the color bug this suite exists to prevent.
 *
 * The three color cases are the important ones. A wrong hex here does not
 * throw, does not look wrong, and is invisible on any file whose fills happen
 * to be opaque — so it is asserted explicitly rather than trusted.
 *
 * @module figma-mcp-dsh/test/core/projection
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSkeleton,
  collectEffectColors,
  collectFonts,
  collectPalette,
  collectStats,
  projectFileMeta,
  projectImageUrls,
  projectNode,
  projectNodeTree,
  projectPaint,
  toHex,
} from '../../src/core/projection.js'
import { DEFAULT_MAX_TEXT_CHARS } from '../../src/core/projection.js'
import { semiTransparentPaint, syntheticFile, syntheticFileMeta, syntheticNodes } from '../fixtures/synthetic.js'

test('a semi-transparent color yields the hex of its RGB channels, not a darkened one', () => {
  // {r:0.5,g:0.5,b:0.5,a:0.3}: reading `a` as opacity would produce #4D4D4D.
  const node = projectNode({ id: '1:1', name: 'n', type: 'RECTANGLE', fills: [semiTransparentPaint()] })
  assert.deepEqual(node.fills, [{ type: 'SOLID', hex: '#808080' }])
})

test('color.a never becomes an opacity field', () => {
  const projected = projectNode({ id: '1:1', name: 'n', type: 'RECTANGLE', fills: [semiTransparentPaint()] })
  assert.equal('opacity' in projected.fills[0], false)
  assert.equal(projected.fills[0].opacity, undefined)
})

test('an opaque color yields its hex and no opacity field', () => {
  const node = projectNode({
    id: '1:1',
    name: 'n',
    type: 'RECTANGLE',
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
  })
  assert.deepEqual(node.fills, [{ type: 'SOLID', hex: '#FFFFFF' }])
  assert.equal('opacity' in node.fills[0], false)
})

test('paint-level opacity is reported, and the hex still comes from the RGB channels', () => {
  const node = projectNode({
    id: '1:1',
    name: 'n',
    type: 'RECTANGLE',
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 0.5 }],
  })
  assert.deepEqual(node.fills, [{ type: 'SOLID', hex: '#FFFFFF', opacity: 0.5 }])
})

test('paint-level opacity of exactly 1 is not reported', () => {
  const node = projectNode({
    id: '1:1',
    name: 'n',
    type: 'RECTANGLE',
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 }],
  })
  assert.equal('opacity' in node.fills[0], false)
})

test('hex conversion clamps and rounds per channel', () => {
  assert.equal(toHex({ r: 1, g: 1, b: 1 }), '#FFFFFF')
  assert.equal(toHex({ r: 0, g: 0, b: 0 }), '#000000')
  assert.equal(toHex({ r: 0.0667, g: 0.0941, b: 0.1529 }), '#111827')
  assert.equal(toHex({ r: 2, g: -1, b: 0.5 }), '#FF0080')
  assert.equal(toHex({}), '#000000')
})

test('a hidden node keeps visible:false and a node at full opacity keeps no opacity', () => {
  const hidden = projectNode({ id: '1:1', name: 'n', type: 'RECTANGLE', visible: false })
  assert.equal(hidden.visible, false)
  const shown = projectNode({ id: '1:2', name: 'n', type: 'RECTANGLE', visible: true, opacity: 1 })
  assert.equal('visible' in shown, false)
  assert.equal('opacity' in shown, false)
})

test('a fractional bounding box is rounded into box and the original field is dropped', () => {
  const node = projectNode({ id: '1:1', name: 'n', type: 'FRAME', absoluteBoundingBox: { x: 10.4, y: 20.6, width: 320.5, height: 180.4 } })
  assert.deepEqual(node.box, { x: 10, y: 21, w: 321, h: 180 })
  assert.equal('absoluteBoundingBox' in node, false)
})

test('long copy is truncated and marked with its original length, never silently', () => {
  const node = projectNode({ id: '1:1', name: 'n', type: 'TEXT', characters: 'x'.repeat(900) })
  assert.equal(node.characters.length, DEFAULT_MAX_TEXT_CHARS)
  assert.equal(node.textTruncatedAt, 900)

  const short = projectNode({ id: '1:2', name: 'n', type: 'TEXT', characters: 'short' })
  assert.equal(short.characters, 'short')
  assert.equal('textTruncatedAt' in short, false)
})

test('text style keeps the designer-facing fields and drops the implementation ones', () => {
  const node = projectNode({
    id: '1:1',
    name: 'n',
    type: 'TEXT',
    characters: 'hi',
    style: {
      fontFamily: 'Inter',
      fontWeight: 700,
      fontSize: 18,
      textAlignHorizontal: 'LEFT',
      lineHeightPx: 24,
      letterSpacing: -0.2,
      fontPostScriptName: 'Inter-Bold',
      textAutoResize: 'HEIGHT',
      lineHeightPercent: 133,
      lineHeightUnit: 'PIXELS',
    },
  })
  assert.deepEqual(node.style, {
    fontFamily: 'Inter',
    fontWeight: 700,
    fontSize: 18,
    textAlignHorizontal: 'LEFT',
    lineHeightPx: 24,
    letterSpacing: -0.2,
  })
})

test('the whitelist drops cold fields and keeps nested children', () => {
  const raw = syntheticFile().document
  const projected = projectNode(raw)
  const frame = projected.children[0]
  for (const dropped of ['constraints', 'relativeTransform', 'clipsContent', 'layoutAlign', 'blendMode']) {
    assert.equal(dropped in frame, false, `${dropped} should be dropped`)
  }
  assert.equal(frame.children.length, 5)
  assert.equal(frame.children[1].children[0].name, 'Nested note')
})

test('palette counts fill and stroke colors across the tree, separately', () => {
  const projected = projectNode(syntheticFile().document)
  const palette = collectPalette(projected)

  const fillHexes = Object.fromEntries(palette.fills.map((entry) => [entry.hex, entry.count]))
  assert.equal(fillHexes['#FFFFFF'], 1)
  assert.equal(fillHexes['#808080'], 1)
  assert.equal(fillHexes['#29CB97'], 1)
  assert.ok(palette.fills.every((entry) => /^#[0-9A-F]{6}$/.test(entry.hex)))
  // Most-used first.
  assert.ok(palette.fills[0].count >= palette.fills[palette.fills.length - 1].count)

  // The card's border is a stroke, so it must be counted as one — not as a fill.
  const strokeHexes = Object.fromEntries(palette.strokes.map((entry) => [entry.hex, entry.count]))
  assert.equal(strokeHexes['#C4CCC8'], 1)
  assert.equal('stroke' in Object.fromEntries(palette.fills.map((e) => [e.hex, e])), false)
})

test('a shadow color is not a fill: effect colors are reported separately', () => {
  // P1-0. A drop shadow with no fill anywhere used to make the palette report
  // black, which reads as "this design uses black" rather than "this has a shadow".
  const node = projectNode({
    id: '1:1',
    name: 'Shadowed',
    type: 'FRAME',
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
    effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.1 }, offset: { x: 0, y: 2 }, radius: 4 }],
  })
  const palette = collectPalette(node)
  const effectColors = collectEffectColors(node)

  assert.deepEqual(palette.fills, [{ hex: '#FFFFFF', count: 1 }])
  assert.deepEqual(palette.strokes, [])
  assert.deepEqual(effectColors, [{ hex: '#000000', count: 1 }])
})

test('effects alone leave the paint palette empty and still report their colors', () => {
  const node = projectNode({
    id: '1:1',
    name: 'Glow',
    type: 'RECTANGLE',
    effects: [{ type: 'DROP_SHADOW', color: { r: 0.2, g: 0.8, b: 0.6, a: 0.4 }, offset: { x: 0, y: 0 }, radius: 8 }],
  })
  const palette = collectPalette(node)
  assert.deepEqual(palette.fills, [])
  assert.deepEqual(palette.strokes, [])
  assert.equal(collectEffectColors(node).length, 1)
})

test('a gradient keeps its stops, so its colors are not lost', () => {
  // The defect this pins: reading only `paint.color` projected every gradient
  // to `{type}` alone. No color appeared anywhere in the result, and the
  // palette counted nothing — so a gradient-only design reported an empty
  // palette, which reads as "this design uses no color".
  const node = projectNode({
    id: '1:1',
    name: 'Hero',
    type: 'RECTANGLE',
    fills: [
      {
        type: 'GRADIENT_LINEAR',
        gradientStops: [
          { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
          { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
        ],
      },
    ],
  })

  assert.deepEqual(node.fills, [
    {
      type: 'GRADIENT_LINEAR',
      stops: [
        { position: 0, hex: '#FF0000' },
        { position: 1, hex: '#0000FF' },
      ],
    },
  ])
  // Positions survive, so the ramp stays a ramp rather than a bag of colors.
  assert.deepEqual(
    node.fills[0].stops.map((stop) => stop.position),
    [0, 1],
  )
  assert.deepEqual(collectPalette(node).fills, [
    { hex: '#0000FF', count: 1 },
    { hex: '#FF0000', count: 1 },
  ])
  // Strokes are counted by the same walk, so a gradient border counts too.
  const stroke = projectNode({
    id: '1:2',
    name: 'Border',
    type: 'RECTANGLE',
    strokes: [{ type: 'GRADIENT_LINEAR', gradientStops: [{ position: 0, color: { r: 0, g: 1, b: 0, a: 1 } }] }],
  })
  assert.deepEqual(collectPalette(stroke).strokes, [{ hex: '#00FF00', count: 1 }])
  assert.deepEqual(collectPalette(stroke).fills, [])
})

test('a gradient stop that fades out keeps its alpha, so it is not read as solid', () => {
  // On a *stop*, `color.a` is the stop's own alpha — there is no other field
  // for it (on a paint it would be the trap `toHex` exists to close, where
  // layer transparency is `paint.opacity`). Dropping it would turn "fade to
  // transparent" into "solid black".
  const node = projectNode({
    id: '1:1',
    name: 'Fade',
    type: 'RECTANGLE',
    fills: [
      {
        type: 'GRADIENT_LINEAR',
        gradientStops: [
          { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
          { position: 0.5, color: { r: 0, g: 0, b: 0, a: 0.4 } },
          { position: 1, color: { r: 0, g: 0, b: 0, a: 0 } },
        ],
      },
    ],
  })
  assert.deepEqual(
    node.fills[0].stops.map((stop) => ({ ...stop })),
    [
      { position: 0, hex: '#000000' },
      { position: 0.5, hex: '#000000', alpha: 0.4 },
      { position: 1, hex: '#000000', alpha: 0 },
    ],
  )
  // The field is `alpha`, never `opacity`: on a paint `opacity` means layer
  // transparency, and the two must not be readable as the same thing.
  assert.equal('opacity' in node.fills[0].stops[2], false)
})

test('a paint that is not a gradient gains no stops field', () => {
  const solid = projectNode({ id: '1:1', name: 'n', type: 'RECTANGLE', fills: [semiTransparentPaint()] })
  assert.equal('stops' in solid.fills[0], false)

  // A gradient whose stops carry no usable color degrades to `{type}` alone,
  // rather than to an empty `stops` array that would read as "no colors here".
  const unusable = projectPaint({ type: 'GRADIENT_RADIAL', gradientStops: [{ position: 0 }] })
  assert.deepEqual(unusable, { type: 'GRADIENT_RADIAL' })
  assert.deepEqual(projectPaint({ type: 'GRADIENT_RADIAL', gradientStops: [] }), { type: 'GRADIENT_RADIAL' })
  assert.deepEqual(projectPaint({ type: 'GRADIENT_RADIAL', gradientStops: 'nope' }), { type: 'GRADIENT_RADIAL' })
})

test('an effect sharing a fill color counts in both places without interfering', () => {
  const node = projectNode({
    id: '1:1',
    name: 'Same',
    type: 'FRAME',
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
    effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 1 }, radius: 2 }],
  })
  assert.deepEqual(collectPalette(node).fills, [{ hex: '#000000', count: 1 }])
  assert.deepEqual(collectEffectColors(node), [{ hex: '#000000', count: 1 }])
})

test('a tree with no effects reports none, so the field is simply absent from the projection', () => {
  const projected = projectNodeTree({ document: { id: '0:0', name: 'Page', type: 'CANVAS' } })
  assert.equal('effectColors' in projected, false)
  assert.deepEqual(projected.palette, { fills: [], strokes: [] })
})

test('fonts are collected as a deduplicated typed scale', () => {
  const fonts = collectFonts(projectNode(syntheticFile().document))
  assert.deepEqual(fonts, ['Inter 400 10.5px', 'Inter 400 13px', 'Inter 700 18px', 'Roboto 400 14px'])
})

test('statistics count nodes, types, and depth', () => {
  const stats = collectStats([projectNode(syntheticFile().document)])
  assert.equal(stats.nodeCount, 8)
  assert.deepEqual(stats.byType.TEXT, 4)
  assert.ok(stats.maxDepth >= 3)
})

test('a whole file payload projects with file facts and a tree', () => {
  const projected = projectNodeTree(syntheticFile())
  assert.equal(projected.source, 'file')
  assert.deepEqual(projected.file, { name: 'Synthetic file', lastModified: '2026-01-01T00:00:00Z', version: '1', editorType: 'figma' })
  assert.equal(projected.roots.length, 1)
  assert.equal(projected.roots[0].type, 'CANVAS')
})

test('a nodes payload projects one root per requested node and reports absent ones', () => {
  const projected = projectNodeTree({
    nodes: {
      '10:20': { document: { id: '10:20', name: 'Card', type: 'FRAME' } },
      '99:99': { err: 'Node not found' },
    },
  })
  assert.equal(projected.source, 'nodes')
  assert.equal(projected.roots.length, 1)
  assert.deepEqual(projected.missing, [{ id: '99:99', error: 'Node not found' }])
})

test('file metadata reads the nested shape the endpoint actually returns', () => {
  // Regression: the documented shape is flat, the real one is nested under
  // `file` with snake_case timestamps. Reading only the documented shape
  // answered {}, which is a silent wrong answer rather than an error.
  const meta = projectFileMeta(syntheticFileMeta())
  assert.equal(meta.name, 'Synthetic file')
  assert.equal(meta.version, '2401639081863745236')
  assert.equal(meta.role, 'owner')
  assert.equal(meta.editorType, 'figma')
  assert.equal(meta.linkAccess, 'view')
  assert.equal(meta.lastTouchedAt, '2026-01-02T03:04:05.678Z')
  assert.equal(meta.creator, 'some-designer')
  // An empty folder name is an absent value, not information.
  assert.equal('folder' in meta, false)
  // A signed 400-character thumbnail URL is not worth the context it costs.
  assert.equal('thumbnailUrl' in meta, false)
})

test('file metadata still reads a flat payload, which older examples show', () => {
  const meta = projectFileMeta({
    name: 'File',
    version: '42',
    lastModified: '2026-01-01T00:00:00Z',
    last_touched_at: '2026-01-02T00:00:00Z',
    role: 'owner',
    creator: { handle: 'someone', id: '1' },
    schemaVersion: 0,
  })
  assert.equal(meta.version, '42')
  assert.equal(meta.lastModified, '2026-01-01T00:00:00Z')
  assert.equal(meta.lastTouchedAt, '2026-01-02T00:00:00Z')
  assert.equal(meta.creator, 'someone')
  assert.equal('schemaVersion' in meta, false)
})

test('file metadata never comes back empty for a real payload', () => {
  for (const payload of [syntheticFileMeta(), syntheticFileMeta().file]) {
    assert.ok(Object.keys(projectFileMeta(payload)).length >= 5)
  }
  assert.deepEqual(projectFileMeta(undefined), {})
  assert.deepEqual(projectFileMeta(null), {})
})

test('image payloads project to signed URLs and separate the missing ones', () => {
  const projected = projectImageUrls({ err: null, images: { '1:2': 'https://img.test/a.png', '3:4': null } })
  assert.deepEqual(projected.images, { '1:2': 'https://img.test/a.png' })
  assert.deepEqual(projected.missing, ['3:4'])
})

test('the skeleton keeps container shape, child counts, and the summaries', () => {
  const projected = projectNodeTree(syntheticFile())
  const skeleton = buildSkeleton(projected)
  assert.equal(skeleton.skeleton, true)
  assert.equal(skeleton.roots[0].type, 'CANVAS')
  assert.equal(skeleton.roots[0].childCount, 1)
  assert.equal(skeleton.roots[0].children[0].childCount, 5)
  assert.equal(typeof skeleton.stats.nodeCount, 'number')
  assert.ok(Array.isArray(skeleton.palette.fills))
  assert.ok(Array.isArray(skeleton.palette.strokes))
  assert.ok(skeleton.note.length > 0)
})

test('the synthetic nodes fixture wraps the same frame', () => {
  const projected = projectNodeTree(syntheticNodes())
  assert.equal(projected.roots[0].name, 'Card')
})
