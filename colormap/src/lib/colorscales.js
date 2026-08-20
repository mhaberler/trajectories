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
    !!lutStops(name) ||
    typeof interpolateFn(name) === 'function' ||
    !!schemeFn(name)
  )
}
