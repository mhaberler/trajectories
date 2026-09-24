/**
 * Colormap names from:
 * - d3-scale-chromatic (matplotlib continuous + ColorBrewer)
 * - dicopal (cmocean + Fabio Crameri Scientific colour maps)
 */
import * as d3 from 'd3-scale-chromatic'
import { getPalettes } from 'dicopal'
import chroma from 'chroma-js'

/** Display name → interpolate* / scheme* suffix when they differ. */
const ALIASES = {
  Cubehelix: 'CubehelixDefault',
}

/** Largest discrete palette per name for a dicopal provider (case-insensitive key). */
function loadDicopalProvider(provider) {
  const by = new Map()
  for (const p of getPalettes({ provider })) {
    const key = p.name.toLowerCase()
    const cur = by.get(key)
    if (!cur || p.number > cur.number) by.set(key, p)
  }
  return by
}

const CMOCEAN = loadDicopalProvider('cmocean')
const CRAMERI = loadDicopalProvider('scientific')

function namesFrom(map, type) {
  return [...map.values()]
    .filter((p) => p.type === type)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => p.name)
}

export const GROUPS = {
  Sequential: [
    'viridis', 'plasma', 'inferno', 'magma', 'cividis', 'turbo',
    'YlOrRd', 'YlOrBr', 'YlGnBu', 'YlGn',
    'Reds', 'OrRd', 'Oranges', 'PuRd', 'Purples', 'PuBuGn', 'PuBu',
    'Greens', 'GnBu', 'BuGn', 'BuPu', 'Blues', 'Greys',
  ],
  Diverging: [
    'RdBu', 'RdYlBu', 'RdYlGn', 'Spectral', 'RdGy',
    'PiYG', 'PRGn', 'BrBG', 'PuOr',
  ],
  Qualitative: [
    'Set1', 'Set2', 'Set3', 'Paired', 'Accent',
    'Dark2', 'Pastel1', 'Pastel2',
    'Category10', 'Tableau10', 'Observable10',
  ],
  // https://matplotlib.org/cmocean/
  cmocean: [
    ...namesFrom(CMOCEAN, 'sequential'),
    ...namesFrom(CMOCEAN, 'diverging'),
  ],
  // https://www.fabiocrameri.ch/colourmaps/
  Scientific: [
    ...namesFrom(CRAMERI, 'sequential'),
    ...namesFrom(CRAMERI, 'diverging'),
  ],
  Extra: ['cool', 'warm', 'Cubehelix', 'Rainbow', 'Sinebow'],
  Wind: ['windy'],
}

/**
 * Windy wind-speed legend: color pinned to km/h, blended to the next stop.
 * Sampled from the standard Windy speed scale (not stretched to a data max).
 */
export const WINDY_STOPS = [
  [0, '#6571b2'],
  [4, '#42609b'],
  [11, '#5d92a7'],
  [18, '#5d8c7c'],
  [25, '#68a35c'],
  [32, '#559d44'],
  [40, '#a69e5c'],
  [47, '#9a8045'],
  [54, '#9a6f5f'],
  [61, '#783e4e'],
  [68, '#a35686'],
  [76, '#6f4c8f'],
  [86, '#6b629f'],
  [97, '#4c688a'],
  [104, '#688f97'],
  [130, '#7647a0'],
  [166, '#e4d8d7'],
  [184, '#dad491'],
  [277, '#cdca7c'],
  [374, '#808080'],
]

export function isWindy(name) {
  return String(name).toLowerCase() === 'windy'
}

export function windyKmh() {
  return WINDY_STOPS.map(([kmh]) => kmh)
}

export function windyColors() {
  return WINDY_STOPS.map(([, hex]) => hex)
}

function d3Suffix(name) {
  return ALIASES[name] || name
}

function capitalize(name) {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function interpolateFn(name) {
  const key = capitalize(d3Suffix(name))
  return d3[`interpolate${key}`]
}

function schemeFn(name) {
  const key = capitalize(d3Suffix(name))
  return d3[`scheme${key}`]
}

function lutStops(name) {
  const key = String(name).toLowerCase()
  return CMOCEAN.get(key)?.colors || CRAMERI.get(key)?.colors || null
}

/** Largest discrete ColorBrewer palette from a nested scheme array. */
function largestScheme(scheme) {
  let best = null
  for (let i = scheme.length - 1; i >= 0; i--) {
    if (Array.isArray(scheme[i]) && scheme[i].length) {
      best = scheme[i]
      break
    }
  }
  return best
}

/**
 * Sample `n` hex stops for a named scale (continuous or discrete).
 * @param {string} name
 * @param {number} [n=256]
 * @returns {string[]}
 */
export function colorStops(name, n = 256) {
  if (isWindy(name)) return windyColors()

  const lut = lutStops(name)
  if (lut) {
    if (n <= lut.length) {
      // even subsample
      if (n === lut.length) return lut.slice()
      return Array.from({ length: n }, (_, i) =>
        lut[Math.round((i / (n - 1)) * (lut.length - 1))]
      )
    }
    return chroma.scale(lut).mode('lab').colors(n)
  }

  const interp = interpolateFn(name)
  if (typeof interp === 'function') {
    if (n < 2) return [chroma(interp(0)).hex()]
    return Array.from({ length: n }, (_, i) =>
      chroma(interp(i / (n - 1))).hex()
    )
  }

  const scheme = schemeFn(name)
  if (!scheme) {
    throw new Error(`${name} not a supported colorscale`)
  }

  // Nested ColorBrewer sequential/diverging: schemeBlues[3]…[9]
  if (scheme.length && Array.isArray(scheme[0]) === false && scheme.some(Array.isArray)) {
    const base = largestScheme(scheme)
    if (!base) throw new Error(`${name} not a supported colorscale`)
    return chroma.scale(base).mode('lab').colors(n)
  }

  // Flat qualitative (or single-size) scheme
  const colors = scheme.filter((c) => typeof c === 'string')
  if (!colors.length) throw new Error(`${name} not a supported colorscale`)
  if (n <= colors.length) return colors.slice(0, n)
  return chroma.scale(colors).mode('lab').colors(n)
}

/** Ready-to-use chroma scale over `domain`. */
export function buildScale(name, domain = [0, 1]) {
  if (isWindy(name)) {
    return chroma.scale(windyColors()).mode('lab').domain(windyKmh())
  }

  const scheme = schemeFn(name)
  const isQualitative =
    Array.isArray(scheme) &&
    scheme.length &&
    typeof scheme[0] === 'string'

  const stops = isQualitative
    ? scheme.filter((c) => typeof c === 'string')
    : colorStops(name, 256)

  return chroma.scale(stops).mode('lab').domain(domain)
}

export function isSupported(name) {
  return (
    isWindy(name) ||
    !!lutStops(name) ||
    typeof interpolateFn(name) === 'function' ||
    !!schemeFn(name)
  )
}
