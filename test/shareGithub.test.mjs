/**
 * GitHub-Pages-Share-Helfer (ohne Netz, außer gemocktem fetch).
 */
import {
  SHARE_GITHUB_DEFAULTS,
  buildShareFilename,
  defaultPagesBase,
  pagesUrl,
  sanitizeShareName,
  shareHtml,
  waitForPagesUrl,
} from "../src/export/shareGithub.ts";

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

{
  check("defaults owner", SHARE_GITHUB_DEFAULTS.owner === "mhaberler");
  check("defaults repo", SHARE_GITHUB_DEFAULTS.repo === "trajectories");
  check("defaults branch", SHARE_GITHUB_DEFAULTS.branch === "gh-pages");
}

{
  check("pages base", defaultPagesBase("mhaberler", "trajectories") ===
    "https://mhaberler.github.io/trajectories/");
  check("pagesUrl default", pagesUrl("a.html", "u", "r") ===
    "https://u.github.io/r/a.html");
  check("pagesUrl custom base", pagesUrl("a.html", "u", "r", "https://share.example/") ===
    "https://share.example/a.html");
  check("pagesUrl base ohne Slash", pagesUrl("a.html", "u", "r", "https://share.example") ===
    "https://share.example/a.html");
}

{
  check("sanitize", sanitizeShareName("icon d2!") === "icon_d2");
  const fn = buildShareFilename("icon_d2", Date.UTC(2026, 7, 12, 8, 0), "abc123");
  check("filename shape", fn === "trajektorien_icon_d2_20260812_0800_abc123.html", fn);
}

{
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init: init || { method: "GET" } });
    if (!init || init.method === "GET" || !init.method) {
      return { ok: false, status: 404, async text() { return ""; } };
    }
    return {
      ok: true,
      status: 201,
      async text() {
        return JSON.stringify({ commit: { sha: "deadbeef" } });
      },
    };
  };
  const r = await shareHtml({
    html: "<!DOCTYPE html><title>t</title>",
    filename: "trajektorien_icon_d2_20260812_0800_abc123.html",
    token: "ghp_test",
    owner: "mhaberler",
    repo: "trajectories",
    branch: "gh-pages",
  }, fakeFetch);
  check("share url", r.pagesUrl ===
    "https://mhaberler.github.io/trajectories/trajektorien_icon_d2_20260812_0800_abc123.html",
  r.pagesUrl);
  check("share path", r.path.endsWith(".html"));
  check("share commit", r.commitSha === "deadbeef");
  check("GET then PUT", calls.length === 2, String(calls.length));
  check("PUT branch", JSON.parse(calls[1].init.body).branch === "gh-pages");
  check("Auth bearer", calls[1].init.headers.Authorization === "Bearer ghp_test");
}

{
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, method: init?.method || "GET" });
    const path = String(url).split("/contents/")[1]?.split("?")[0] || "";
    if (!init || init.method === "GET" || !init.method) {
      // first name exists, -2 free
      const exists = decodeURIComponent(path) === "demo.html";
      return { ok: exists, status: exists ? 200 : 404, async text() { return "{}"; } };
    }
    return {
      ok: true,
      status: 201,
      async text() {
        return JSON.stringify({
          commit: { sha: "abc" },
          content: { html_url: "https://github.com/x" },
        });
      },
    };
  };
  const r = await shareHtml({
    html: "<html></html>",
    filename: "demo.html",
    token: "t",
    owner: "o",
    repo: "r",
    branch: "gh-pages",
    unique: true,
  }, fakeFetch);
  check("bump path", r.path === "demo-2.html", r.path);
  check("bump pages url", r.pagesUrl.endsWith("/demo-2.html"), r.pagesUrl);
}

{
  let n = 0;
  const fakeFetch = async () => {
    n += 1;
    return { ok: n >= 2, status: n >= 2 ? 200 : 404 };
  };
  const ok = await waitForPagesUrl("https://example.test/x.html", {
    timeoutMs: 50,
    intervalMs: 10,
    fetchImpl: fakeFetch,
  });
  check("waitForPages eventually ok", ok === true);
  check("waitForPages retried", n >= 2, String(n));
}

{
  const fakeFetch = async () => ({ ok: false, status: 404 });
  const ok = await waitForPagesUrl("https://example.test/x.html", {
    timeoutMs: 35,
    intervalMs: 20,
    fetchImpl: fakeFetch,
  });
  check("waitForPages timeout", ok === false);
}

{
  let threw = null;
  try {
    await shareHtml({
      html: "<html></html>",
      filename: "x.html",
      token: "",
      owner: "a",
      repo: "b",
      branch: "gh-pages",
    }, async () => ({ ok: true, status: 200, text: async () => "{}" }));
  } catch (e) {
    threw = e;
  }
  check("missing token throws", !!threw && /PAT/.test(threw.message), threw?.message);
}

{
  let threw = null;
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    async text() { return JSON.stringify({ message: "Bad credentials" }); },
  });
  try {
    await shareHtml({
      html: "<html></html>",
      filename: "x.html",
      token: "bad",
      owner: "a",
      repo: "b",
      branch: "gh-pages",
    }, fakeFetch);
  } catch (e) {
    threw = e;
  }
  check("401 mapped", !!threw && /401/.test(threw.message), threw?.message);
}

console.log(failures ? `\n${failures} Fehler.` : "\nAlle shareGithub-Tests bestanden.");
process.exit(failures ? 1 : 0);
