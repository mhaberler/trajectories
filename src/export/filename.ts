/**
 * Export-Dateinamen aus Muster + Tokens.
 * Trenner `_`; Komponenten ASCII-sicher.
 */

export const DEFAULT_FILENAME_PATTERN = "{ymd}_{hm}Z_{place}_{duration}_{model}";

export const FILENAME_TOKENS = ["ymd", "hm", "place", "duration", "model"] as const;

export interface FilenameCtx {
  t0Ms: number;
  /** Kurzname Ort (vor Sanitize); leer → Koordinaten-Fallback. */
  place?: string | null;
  lat?: number;
  lon?: number;
  /** Stunden (1–72). */
  durationH: number;
  /** +1 vorwärts, −1 rückwärts. */
  direction: number;
  /** Anzeigename Modell, z. B. „ICON-D2“. */
  modelLabel: string;
}

/** ASCII-Dateinamenstück; Umlaute grob ersetzen, Rest → `_`. */
export function sanitizeFilenamePart(s: string, maxLen = 80): string {
  let t = String(s || "")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (maxLen > 0) t = t.slice(0, maxLen).replace(/_+$/g, "");
  return t || "x";
}

/** Modell-Label ohne Klammerzusatz: „ICON-D2 (~2,2 km)“ → „ICON-D2“. */
export function shortModelLabel(label: string, fallback = "model"): string {
  const s = String(label || "").replace(/\s*\(.*\)\s*$/, "").trim();
  return s || fallback;
}

function placeToken(ctx: FilenameCtx): string {
  const raw = String(ctx.place || "").trim();
  if (raw) return sanitizeFilenamePart(raw, 30);
  if (Number.isFinite(ctx.lat) && Number.isFinite(ctx.lon)) {
    const ns = (ctx.lat as number) >= 0 ? "N" : "S";
    const ew = (ctx.lon as number) >= 0 ? "E" : "W";
    return sanitizeFilenamePart(
      `${Math.abs(ctx.lat as number).toFixed(2)}${ns}_${Math.abs(ctx.lon as number).toFixed(2)}${ew}`,
      24,
    );
  }
  return "place";
}

function durationToken(ctx: FilenameCtx): string {
  const h = Math.min(72, Math.max(1, Math.round(Number(ctx.durationH) || 12)));
  const dir = Number(ctx.direction) < 0 ? "back" : "fwd";
  return `${h}h-${dir}`;
}

function timeParts(t0Ms: number): { ymd: string; hm: string } {
  const iso = new Date(t0Ms).toISOString(); // UTC
  const ymd = iso.slice(0, 10).replace(/-/g, "");
  const hm = iso.slice(11, 16).replace(":", "");
  return { ymd, hm };
}

/**
 * Baut den Dateinamen-Stamm (ohne Endung) aus dem Muster.
 * Unbekannte `{…}`-Tokens bleiben stehen; leeres Muster → Default.
 */
export function buildExportBasename(pattern: string, ctx: FilenameCtx): string {
  const pat = String(pattern || "").trim() || DEFAULT_FILENAME_PATTERN;
  const { ymd, hm } = timeParts(ctx.t0Ms);
  const map: Record<string, string> = {
    ymd,
    hm,
    place: placeToken(ctx),
    duration: durationToken(ctx),
    model: sanitizeFilenamePart(shortModelLabel(ctx.modelLabel, "model"), 40),
  };
  let out = pat.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) =>
    Object.prototype.hasOwnProperty.call(map, key) ? map[key] : `{${key}}`);
  out = sanitizeFilenamePart(out.replace(/_+/g, "_"), 120);
  return out || "export";
}

export function buildExportFilename(pattern: string, ctx: FilenameCtx, ext: string): string {
  const stem = buildExportBasename(pattern, ctx);
  const e = String(ext || "").replace(/^\./, "") || "bin";
  return `${stem}.${e}`;
}

/**
 * Kandidaten bei Namenskollision: `stem.ext`, dann `stem-2.ext`, `stem-3.ext`, …
 */
export function bumpedFilename(stem: string, ext: string, n: number): string {
  const s = sanitizeFilenamePart(stem, 120);
  const e = String(ext || "").replace(/^\./, "") || "bin";
  if (n <= 1) return `${s}.${e}`;
  return `${s}-${n}.${e}`;
}

/** Nächster freier Name; `isTaken` true → schon belegt. */
export async function allocateUniqueFilename(
  stem: string,
  ext: string,
  isTaken: (filename: string) => boolean | Promise<boolean>,
  maxTries = 50,
): Promise<string> {
  for (let n = 1; n <= maxTries; n++) {
    const name = bumpedFilename(stem, ext, n);
    if (!(await isTaken(name))) return name;
  }
  throw new Error("Kein freier Dateiname (zu viele Kollisionen).");
}
