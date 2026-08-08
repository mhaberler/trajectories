/**
 * Wächter für die Kopplung zwischen App und HTML-Export.
 *
 * Der Export bettet Leaflet aus node_modules ein, die App lädt es weiterhin
 * per CDN. Läuft die Version auseinander, sähe die exportierte Karte anders
 * aus als die im Browser — ohne dass irgendetwas bricht. Darum hier geprüft.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const html = readFileSync(join(root, "index.html"), "utf8");

const pinned = String(pkg.dependencies?.leaflet || "").replace(/^[\^~]/, "");
check("package.json kennt leaflet", !!pinned, pinned);

const cdn = [...html.matchAll(/leaflet@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
check("index.html lädt Leaflet per CDN", cdn.length >= 2, `${cdn.length} Fundstellen`);
check("CDN-Fundstellen einig", new Set(cdn).size === 1, cdn.join(", "));
check("CDN-Version == package.json", cdn[0] === pinned, `${cdn[0]} vs ${pinned}`);

// Der Viewer wird als eigener Vite-Einstieg gebaut; die Quelle darf daher
// ganz normal importieren. Nur der Einstiegspunkt muss stimmen.
const viewer = readFileSync(join(root, "src/export/htmlViewer.ts"), "utf8");
check("Viewer ruft initViewer auf", /function initViewer/.test(viewer));
check("Viewer hängt sich an window", /window[^)]*\)?\s*\.initViewer\s*=/.test(viewer));

console.log(failures ? `\n${failures} Fehler.` : "\nAlle Export-Wächter bestanden.");
process.exit(failures ? 1 : 0);
