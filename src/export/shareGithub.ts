/**
 * HTML-Export auf GitHub Pages teilen (Contents API, Browser-PAT).
 */

import { allocateUniqueFilename, sanitizeFilenamePart } from "./filename";

export interface ShareGithubOpts {
  html: string;
  filename: string;
  token: string;
  owner: string;
  repo: string;
  branch: string;
  /** Überschreibt die abgeleitete github.io-Basis (Custom Domain). */
  pagesBase?: string;
  /** Bei Namenskollision `stem-2.html`, `stem-3.html`, … (Default true). */
  unique?: boolean;
}

export interface ShareGithubResult {
  pagesUrl: string;
  path: string;
  commitSha?: string;
  /** GitHub-Web-URL der Datei (sofort sichtbar, kein Pages-Build). */
  htmlUrl?: string;
}

export const SHARE_GITHUB_DEFAULTS = {
  owner: "mhaberler",
  repo: "trajectories",
  branch: "gh-pages",
  pagesBase: "",
  token: "",
};

/** `https://{owner}.github.io/{repo}/` */
export function defaultPagesBase(owner: string, repo: string): string {
  const o = String(owner || "").trim();
  const r = String(repo || "").trim();
  if (!o || !r) return "";
  return `https://${o}.github.io/${r}/`;
}

export function pagesUrl(file: string, owner: string, repo: string, pagesBase?: string): string {
  const base = (pagesBase && pagesBase.trim()) || defaultPagesBase(owner, repo);
  const b = base.endsWith("/") ? base : `${base}/`;
  const name = String(file || "").replace(/^\/+/, "");
  return `${b}${name}`;
}

/** @deprecated use sanitizeFilenamePart from ./filename */
export function sanitizeShareName(s: string): string {
  return sanitizeFilenamePart(s, 80);
}

/** @deprecated Prefer buildExportFilename from ./filename */
export function buildShareFilename(modelKey: string, t0Ms: number, id?: string): string {
  const stamp = new Date(t0Ms).toISOString().slice(0, 16)
    .replace(/[-:]/g, "").replace("T", "_");
  const short = id || Math.random().toString(36).slice(2, 8);
  return `trajektorien_${sanitizeFilenamePart(modelKey)}_${stamp}_${short}.html`;
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function apiErrorMessage(status: number, body: string): string {
  let msg = body;
  try {
    const j = JSON.parse(body);
    if (j?.message) msg = j.message;
  } catch {
    /* raw */
  }
  if (status === 401) return "GitHub: ungültiger oder fehlender Token (401).";
  if (status === 403) return `GitHub: kein Schreibrecht oder Rate-Limit (403). ${msg}`;
  if (status === 404) {
    return `GitHub: Repo oder Branch nicht gefunden (404). ${msg}`;
  }
  return `GitHub-API ${status}: ${msg || "unbekannter Fehler"}`;
}

async function contentsExists(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status === 404) return false;
  if (res.ok) return true;
  const text = await res.text();
  throw new Error(apiErrorMessage(res.status, text));
}

/**
 * Lädt HTML als neue Datei auf den gewählten Branch (Contents API).
 * Mit `unique` (Default true) bei Kollision `stem-2.html` usw.
 */
export async function shareHtml(opts: ShareGithubOpts, fetchImpl: typeof fetch = fetch): Promise<ShareGithubResult> {
  const token = opts.token?.trim();
  const owner = opts.owner?.trim();
  const repo = opts.repo?.trim();
  const branch = opts.branch?.trim() || "gh-pages";
  let filename = sanitizeFilenamePart(String(opts.filename || "").replace(/\.html$/i, ""), 120) + ".html";

  if (!token) throw new Error("GitHub-PAT fehlt.");
  if (!owner || !repo) throw new Error("GitHub owner/repo fehlen.");
  if (!opts.html) throw new Error("Kein HTML zum Teilen.");

  if (opts.unique !== false) {
    const stem = filename.replace(/\.html$/i, "");
    filename = await allocateUniqueFilename(stem, "html", (name) =>
      contentsExists(owner, repo, name, branch, token, fetchImpl));
  }

  const path = filename;
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`;
  const res = await fetchImpl(url, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      message: `Share ${filename}`,
      content: utf8ToBase64(opts.html),
      branch,
    }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(apiErrorMessage(res.status, text));

  let commitSha: string | undefined;
  let htmlUrl: string | undefined;
  try {
    const j = JSON.parse(text);
    commitSha = j?.commit?.sha;
    htmlUrl = j?.content?.html_url;
  } catch {
    /* ignore */
  }

  return {
    pagesUrl: pagesUrl(path, owner, repo, opts.pagesBase),
    path,
    commitSha,
    htmlUrl,
  };
}

/**
 * Wartet, bis die Pages-URL HTTP 200 liefert (Deploy-Verzögerung), oder Timeout.
 * @returns true wenn erreichbar
 */
export async function waitForPagesUrl(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      let res = await fetchImpl(url, { method: "HEAD", cache: "no-store" });
      if (res.ok) return true;
      if (res.status === 404 || res.status === 405 || res.status === 403) {
        res = await fetchImpl(url, { method: "GET", cache: "no-store" });
        if (res.ok) return true;
      }
    } catch {
      /* CORS/netz — weiter versuchen */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
