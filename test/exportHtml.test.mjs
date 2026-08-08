import {
  buildPayload, jsonForScript, renderDocument, HTML_EXPORT_DEFAULTS,
} from "../src/export/htmlPayload.ts";

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

const T0 = Date.UTC(2026, 7, 8, 12, 0, 0);

/** Minimaler, aber formtreuer Zustand wie ihn app.js aufbaut. */
function fixture({ label = "500 m AGL", legendHtml = "" } = {}) {
  const pts = [
    { lat: 47.123456789, lon: 11.987654321, z: 1100.4, tMs: T0 },
    { lat: 47.2, lon: 12.0, z: 1250.6, tMs: T0 + 3600e3 },
    { lat: 47.3, lon: 12.1, z: null, tMs: T0 + 7200e3 },
  ];
  const markers = [
    { lat: 47.2, lon: 12.0, z: 1250.6, tMs: T0 + 3600e3, u: 5, v: -3, met: null },
    { lat: NaN, lon: 12.1, z: 1300, tMs: T0 + 7200e3, u: 1, v: 1, met: null },
  ];
  const run = {
    r: { points: pts, markers, status: "ok", reason: null },
    color: "#2a78d6", label, heightM: 500, method: "height", dash: null,
  };
  const lastRuns = {
    runs: [run], modelKey: "icon_d2", mode: "agl", t0Ms: T0, duration: 2, direction: 1,
  };
  const xsec = {
    runs: [{ ...run, terrain: [600.7, 700.2, null], terrainHi: [{ tSec: 0, z: 612.9 }, { tSec: 3600, z: 810.1 }] }],
    t0Ms: T0, direction: 1, overlay: false,
  };
  const ctx = {
    xsec,
    opts: { legendHtml },
    unitState: { height: "m", wind: "kmh" },
    markerFields: (m, lbl) => [
      { key: "Zeit", label: "Zeit", value: "14:00" },
      { key: "Serie", label: "Serie", value: lbl },
    ],
    trackName: (r, dir) => `${r.label} · ${dir > 0 ? "vor" : "rück"}`,
    now: Date.UTC(2026, 7, 8, 15, 30, 0),
  };
  return { lastRuns, ctx, xsec };
}

// 1 — Form der Nutzlast
{
  const { lastRuns, ctx } = fixture();
  const p = buildPayload(lastRuns, ctx);
  check("payload: ein Lauf", p.runs.length === 1);
  check("payload: Punktzahl bleibt", p.runs[0].pts.length === 3, `n=${p.runs[0].pts.length}`);
  check("payload: direction erhalten", p.meta.direction === 1);
  check("payload: modelKey erhalten", p.meta.modelKey === "icon_d2");
  check("payload: name via trackName", p.runs[0].name === "500 m AGL · vor", p.runs[0].name);
  const xr = p.xsec.runs[0];
  check("xsec: terrain so lang wie points",
    xr.terrain.length === xr.r.points.length, `${xr.terrain.length} vs ${xr.r.points.length}`);
  check("xsec: terrainHi je Lauf erhalten", Array.isArray(xr.terrainHi) && xr.terrainHi.length === 2);
  check("xsec: terrainHi gerundet", xr.terrainHi[0].z === 613, String(xr.terrainHi[0].z));
  check("units eingefroren", p.units.height === "m" && p.units.wind === "kmh");
}

// 2 — </script>-Maskierung (der wichtigste Test)
{
  const evil = '</script><img src=x onerror=alert(1)>';
  const { lastRuns, ctx } = fixture({ label: evil, legendHtml: evil });
  const p = buildPayload(lastRuns, ctx);
  const json = jsonForScript(p);
  check("escape: kein </script im Ausgabetext", !/<\/script/i.test(json));
  const back = JSON.parse(json);
  check("escape: legendHtml unverändert zurück", back.opts.legendHtml === evil);
  check("escape: label unverändert zurück", back.runs[0].label === evil);

  const doc = renderDocument({
    title: "t", leafletCss: "", viewerCss: "", leafletJs: "", viewerJs: "", json,
  });
  const m = doc.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/);
  check("escape: Datenblock extrahierbar", !!m);
  check("escape: extrahiertes JSON parst", !!m && JSON.parse(m[1]).runs[0].label === evil);
}

// 3 — U+2028 / <!-- Rundlauf
{
  const weird = "a\u2028b\u2029c<!--d";
  const { lastRuns, ctx } = fixture({ legendHtml: weird });
  const json = jsonForScript(buildPayload(lastRuns, ctx));
  check("escape: kein rohes U+2028", !/[\u2028\u2029]/.test(json));
  check("escape: kein rohes <!--", !json.includes("<!--"));
  check("escape: Sonderzeichen kommen zurück", JSON.parse(json).opts.legendHtml === weird);
}

// 4 — Dokumentgerüst
{
  const { lastRuns, ctx } = fixture();
  const doc = renderDocument({
    title: "Titel & <Test>",
    leafletCss: ".x{}", viewerCss: ".y{}", leafletJs: "/*L*/", viewerJs: "/*V*/",
    json: jsonForScript(buildPayload(lastRuns, ctx)),
  });
  check("doc: beginnt mit DOCTYPE", doc.startsWith("<!DOCTYPE html>"));
  check("doc: genau ein #map", (doc.match(/<div id="map">/g) || []).length === 1);
  check("doc: genau ein #profile", (doc.match(/<div id="profile">/g) || []).length === 1);
  check("doc: Titel maskiert", doc.includes("<title>Titel &amp; &lt;Test&gt;</title>"));
  check("doc: Leaflet und Viewer eingebettet", doc.includes("/*L*/") && doc.includes("/*V*/"));
}

// 5 — Marker-Zeilen
{
  const { lastRuns, ctx } = fixture();
  const p = buildPayload(lastRuns, ctx);
  const mk = p.runs[0].markers;
  check("marker: ungültige Koordinate gefiltert", mk.length === 1, `n=${mk.length}`);
  check("marker: rows als {label,value}",
    mk[0].rows.length === 2 && mk[0].rows[0].label === "Zeit" && mk[0].rows[0].value === "14:00");
  check("marker: kein key-Feld", !("key" in mk[0].rows[0]));
}

// 6 — Einstellungen wirken
{
  const { lastRuns, ctx } = fixture();
  const off = buildPayload(lastRuns, { ...ctx, opts: { markers: false, lineWidth: 7 } });
  check("opts: markers:false leert die Liste", off.runs[0].markers.length === 0);
  check("opts: lineWidth durchgereicht", off.opts.lineWidth === 7);
  check("opts: Defaults ergänzt", off.opts.markerRadius === HTML_EXPORT_DEFAULTS.markerRadius);
}

// 7 — Rundung, z:null überlebt
{
  const { lastRuns, ctx } = fixture();
  const p = buildPayload(lastRuns, ctx);
  const [lat, lon, z] = p.runs[0].pts[0];
  check("rundung: lat auf 5 Stellen", lat === 47.12346, String(lat));
  check("rundung: lon auf 5 Stellen", lon === 11.98765, String(lon));
  check("rundung: z auf ganze Meter", z === 1100, String(z));
  check("rundung: z:null bleibt null", p.runs[0].pts[2][2] === null);
  check("rundung: tMs unverändert", p.runs[0].pts[0][3] === T0);
}

// 8 — fehlender xsec-Zustand
{
  const { lastRuns, ctx } = fixture();
  let threw = null;
  try { buildPayload(lastRuns, { ...ctx, xsec: null }); } catch (e) { threw = e; }
  check("guard: wirft ohne xsec", !!threw);
  check("guard: verständliche Meldung", !!threw && /Querschnitt/.test(threw.message), threw?.message);
}

console.log(failures ? `\n${failures} Fehler.` : "\nAlle HTML-Export-Tests bestanden.");
process.exit(failures ? 1 : 0);
