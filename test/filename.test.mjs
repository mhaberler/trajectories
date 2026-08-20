/**
 * Export-Dateinamen (Muster + Tokens).
 */
import {
  DEFAULT_FILENAME_PATTERN,
  allocateUniqueFilename,
  buildExportBasename,
  buildExportFilename,
  bumpedFilename,
  sanitizeFilenamePart,
  shortModelLabel,
} from "../src/export/filename.ts";

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

{
  check("default pattern set", DEFAULT_FILENAME_PATTERN.includes("{place}"));
  check("sanitize umlaut", sanitizeFilenamePart("Innsbruck") === "Innsbruck");
  check("sanitize space", sanitizeFilenamePart("Bad Gastein") === "Bad_Gastein");
  check("sanitize max 30", sanitizeFilenamePart("ABCDEFGHIJKLMNOPQRSTUVWXYZ01234", 30) === "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123");
  check("sanitize max 30 trunc", sanitizeFilenamePart("ABCDEFGHIJKLMNOPQRSTUVWXYZ01234XXX", 30).length === 30);
  check("short model", shortModelLabel("ICON-D2 (~2,2 km)") === "ICON-D2");
}

{
  const ctx = {
    t0Ms: Date.UTC(2026, 7, 20, 9, 0),
    place: "Innsbruck",
    lat: 47.27,
    lon: 11.39,
    durationH: 12,
    direction: 1,
    modelLabel: "ICON-D2 (~2,2 km)",
  };
  const base = buildExportBasename(DEFAULT_FILENAME_PATTERN, ctx);
  check("basename shape", base === "20260820_0900Z_Innsbruck_12h-fwd_ICON-D2", base);
  check("with ext", buildExportFilename(DEFAULT_FILENAME_PATTERN, ctx, "html") ===
    "20260820_0900Z_Innsbruck_12h-fwd_ICON-D2.html");
}

{
  const ctx = {
    t0Ms: Date.UTC(2026, 7, 20, 9, 0),
    place: "",
    lat: 47.269,
    lon: 11.393,
    durationH: 6,
    direction: -1,
    modelLabel: "ICON-EU (~6,5 km)",
  };
  const base = buildExportBasename("{ymd}_{hm}Z_{place}_{duration}_{model}", ctx);
  check("coords fallback + back", /47\.27N_11\.39E/.test(base) && base.includes("6h-back"), base);
}

{
  check("bump 1", bumpedFilename("a", "html", 1) === "a.html");
  check("bump 2", bumpedFilename("a", "html", 2) === "a-2.html");
}

{
  const taken = new Set(["x.html", "x-2.html"]);
  const name = await allocateUniqueFilename("x", "html", (f) => taken.has(f));
  check("allocate skips to -3", name === "x-3.html", name);
}

console.log(failures ? `\n${failures} Fehler.` : "\nAlle filename-Tests bestanden.");
process.exit(failures ? 1 : 0);
