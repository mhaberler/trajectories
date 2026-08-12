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
const entry = readFileSync(join(root, "src/export/htmlExportMain.ts"), "utf8");
check("Viewer ruft initViewer auf", /function initViewer/.test(viewer));
check("Einstieg hängt initExport an window", /initExport\s*=/.test(entry) && /window[^;]*initExport/.test(entry));
check("Einstieg hängt initViewer an window", /window[^;]*initViewer\s*=/.test(entry));

// Leaflets CSS verweist relativ auf images/*.png. html.ts ersetzt diese
// Verweise beim Export durch data:-URIs; passt das Muster nicht mehr, bliebe
// das Ebenen-Symbol in der exportierten Datei ein leerer weißer Kasten.
const leafletCss = readFileSync(join(root, "node_modules/leaflet/dist/leaflet.css"), "utf8");
const imgRefs = leafletCss.match(/url\(\s*['"]?images\/[^)]*\)/g) || [];
check("Leaflet-CSS hat relative Bildverweise", imgRefs.length === 3, imgRefs.join(", "));

const htmlTs = readFileSync(join(root, "src/export/html.ts"), "utf8");
// Die Verweise, die ersetzt werden müssen — je einer je Bild aus Leaflets CSS.
for (const name of ["layers-2x", "layers", "marker-icon"]) {
  check(`html.ts ersetzt ${name}.png`,
    new RegExp(`images\\\\?/${name}\\\\?\\.png`).test(htmlTs), name);
}
// Die Ersetzung muss zur Exportzeit laufen. Als Modulkonstante faltet der
// Bundler den Ausdruck zusammen und die Originalverweise blieben stehen.
check("Ersetzung passiert in einer Funktion, nicht als Konstante",
  /function inlineLeafletImages/.test(htmlTs));
check("buildHTML nutzt die Funktion",
  /leafletCss:\s*inlineLeafletImages\(\)/.test(htmlTs));

// `?inline` liefert im Dev-Server einen Serverpfad statt einer data:-URI —
// die exportierte Datei zeigte dann auf file:///node_modules/… ins Leere.
// Darum das eigene virtuelle Modul, das in beiden Modi base64 liefert.
check("html.ts importiert die Bilder nicht per ?inline",
  !/^\s*import[^\n]*\?inline/m.test(htmlTs));
check("html.ts nutzt virtual:leaflet-images",
  htmlTs.includes("virtual:leaflet-images"));

const viteCfg = readFileSync(join(root, "vite.config.js"), "utf8");
check("vite.config.js liefert virtual:leaflet-images",
  viteCfg.includes("virtual:leaflet-images"));
check("virtual:leaflet-images kodiert base64",
  /toString\(["']base64["']\)/.test(viteCfg));
check("Plugin ist registriert", /plugins:\s*\[\s*leafletImages\(\)/.test(viteCfg));

console.log(failures ? `\n${failures} Fehler.` : "\nAlle Export-Wächter bestanden.");
process.exit(failures ? 1 : 0);
