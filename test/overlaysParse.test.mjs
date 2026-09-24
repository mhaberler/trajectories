import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lineCoords, overlaysFromGeoJSON, parseOverlayFile } from "../src/overlays/parse.js";
import { metricsAt } from "../src/overlays/sample.js";
import { buildPayload, HTML_EXPORT_DEFAULTS } from "../src/export/htmlPayload.ts";

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="test">
  <trk><name>TestTrack</name>
    <trkseg>
      <trkpt lat="47.1" lon="11.1"><ele>1000</ele></trkpt>
      <trkpt lat="47.2" lon="11.2"><ele>1100</ele></trkpt>
      <trkpt lat="47.3" lon="11.3"><ele>1200</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

const KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>KmlLine</name>
      <LineString>
        <coordinates>11.1,47.1,900 11.2,47.2,950 11.3,47.3,980</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;

{
  const c = lineCoords([[11.5, 47.5, 800], [11.6, 47.6], ["x", 1]]);
  check("lineCoords: 2 gültige Punkte", c.length === 2);
  check("lineCoords: z übernommen", c[0].z === 800);
  check("lineCoords: fehlendes z → null", c[1].z === null);
}

{
  const gj = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "A" },
        geometry: {
          type: "MultiLineString",
          coordinates: [
            [[10, 50], [11, 51]],
            [[12, 52, 700], [13, 53, 710]],
          ],
        },
      },
    ],
  };
  const { drafts, warnings } = overlaysFromGeoJSON(gj, "multi.geojson");
  check("geojson: MultiLine → 2 Spuren", drafts.length === 2, `n=${drafts.length}`);
  check("geojson: Namen nummeriert", drafts[0].name.includes("(1)") && drafts[1].name.includes("(2)"));
  check("geojson: Höhe auf Teil 2", drafts[1].coords[0].z === 700);
  check("geojson: keine Warnung", warnings.length === 0);
}

{
  const gj = {
    type: "Feature",
    properties: {
      name: "TimedLine",
      coordTimes: ["2024-06-01T10:00:00Z", "2024-06-01T10:00:30Z"],
    },
    geometry: {
      type: "LineString",
      coordinates: [[11.1, 47.1, 800], [11.2, 47.2, 810]],
    },
  };
  const { drafts } = overlaysFromGeoJSON(gj, "t.geojson");
  check("geojson: coordTimes", drafts[0]?.coords[0].t === Date.parse("2024-06-01T10:00:00Z"));
  check("geojson: coordTimes 2", drafts[0]?.coords[1].t === Date.parse("2024-06-01T10:00:30Z"));
}

{
  const { drafts } = await parseOverlayFile(GPX, "flight.gpx");
  check("gpx: eine Spur", drafts.length === 1, `n=${drafts.length}`);
  check("gpx: Name", drafts[0]?.name === "TestTrack", drafts[0]?.name);
  check("gpx: 3 Punkte mit ele", drafts[0]?.coords.length === 3 && drafts[0].coords[0].z === 1000);
}

{
  const GPX_TIME = `<?xml version="1.0"?>
<gpx version="1.1" creator="test">
  <trk><name>Timed</name>
    <trkseg>
      <trkpt lat="47.1" lon="11.1"><ele>1000</ele><time>2024-06-01T10:00:00Z</time></trkpt>
      <trkpt lat="47.2" lon="11.2"><ele>1100</ele><time>2024-06-01T10:01:00Z</time></trkpt>
      <trkpt lat="47.3" lon="11.3"><ele>1200</ele><time>2024-06-01T10:02:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;
  const { drafts } = await parseOverlayFile(GPX_TIME, "timed.gpx");
  const ts = drafts[0]?.coords.map((c) => c.t);
  check("gpx: Zeiten übernommen", ts?.length === 3 && ts.every((t) => Number.isFinite(t)), String(ts));
  check("gpx: erste Zeit UTC", ts?.[0] === Date.parse("2024-06-01T10:00:00Z"));
  check("gpx: 60s Abstand", ts?.[1] - ts?.[0] === 60_000);
}

{
  const GPX_CLONE = `<?xml version="1.0"?>
<gpx version="1.1" creator="test">
  <trk><name>Clone</name>
    <trkseg>
      <trkpt lat="47.1" lon="11.1"><time>2024-06-01T10:00:00Z</time></trkpt>
      <trkpt lat="47.1" lon="11.1"><ele>1000</ele><time>2024-06-01T10:00:00Z</time></trkpt>
      <trkpt lat="47.2" lon="11.2"><ele>1100</ele><time>2024-06-01T10:01:00Z</time></trkpt>
      <trkpt lat="47.2" lon="11.2"><ele>1100</ele><time>2024-06-01T10:02:00Z</time></trkpt>
    </trkseg>
  </trk>
</gpx>`;
  const { drafts } = await parseOverlayFile(GPX_CLONE, "clone.gpx");
  const coords = drafts[0]?.coords;
  check("gpx: Klon entfernt", coords?.length === 3, `n=${coords?.length}`);
  check("gpx: Höhe vom Klon", coords?.[0].z === 1000, String(coords?.[0].z));
  const moved = metricsAt(coords, 0);
  check("gpx: Speed nach Klon", moved?.speedKmh != null && moved.speedKmh > 0, String(moved?.speedKmh));
  check("gpx: Richtung nach Klon", moved?.headingDeg != null, String(moved?.headingDeg));
  check(
    "gpx: Stillstand bleibt",
    coords?.[1].lat === coords?.[2].lat && coords[2].t - coords[1].t === 60_000,
  );
  const hover = metricsAt(coords, 1);
  check("gpx: Stillstand 0 km/h", hover?.speedKmh === 0, String(hover?.speedKmh));
  check("gpx: Stillstand ohne Richtung", hover?.headingDeg == null, String(hover?.headingDeg));
}

{
  const { drafts } = await parseOverlayFile(KML, "line.kml");
  check("kml: eine Spur", drafts.length === 1, `n=${drafts.length}`);
  check("kml: Name", drafts[0]?.name === "KmlLine", drafts[0]?.name);
  check("kml: Höhe", drafts[0]?.coords[0].z === 900, String(drafts[0]?.coords[0].z));
  check("kml: ohne FlightPack keine Zeit", drafts[0]?.coords.every((c) => c.t == null));
}

{
  const FP = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <description>Track created by Ultramagic FlightPack - Starting at time 13_08_2026 06_29_23 -
      Sampling period is 3 seconds - Flight duration is 58 min</description>
    <Placemark>
      <name>FpLine</name>
      <LineString>
        <coordinates>
          15.63343,48.44636,319
          15.63342,48.44637,320
          15.63341,48.44638,321
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
  const { drafts, warnings } = await parseOverlayFile(FP, "fp.kml");
  const ts = drafts[0]?.coords.map((c) => c.t);
  const t0 = Date.parse("2026-08-13T04:29:23Z");
  check("flightpack: eine Spur", drafts.length === 1, `n=${drafts.length}`);
  check("flightpack: keine Warnung", warnings.length === 0, warnings.join("; "));
  check("flightpack: t0 CEST→UTC", ts?.[0] === t0, String(ts?.[0]));
  check("flightpack: 3s Raster", ts?.[1] - ts?.[0] === 3000 && ts?.[2] - ts?.[1] === 3000);
}

{
  const { drafts, warnings } = await parseOverlayFile('{"type":"Point","coordinates":[1,2]}', "p.geojson");
  check("point-only: keine Linien", drafts.length === 0);
  check("point-only: Warnung", warnings.length > 0);
}

// Payload enthält overlays
{
  const T0 = Date.UTC(2026, 7, 8, 12, 0, 0);
  const run = {
    r: {
      points: [
        { lat: 47, lon: 11, z: 1000, tMs: T0 },
        { lat: 47.1, lon: 11.1, z: 1100, tMs: T0 + 3600e3 },
      ],
      markers: [],
      status: "ok",
      reason: null,
    },
    color: "#2a78d6",
    label: "500 m",
    heightM: 500,
    method: "height",
    dash: null,
  };
  const lastRuns = {
    runs: [run], modelKey: "icon_d2", mode: "agl", t0Ms: T0, duration: 1, direction: 1,
  };
  const xsec = {
    runs: [{ ...run, terrain: [600, 700] }],
    t0Ms: T0, direction: 1, overlay: false,
  };
  const p = buildPayload(lastRuns, {
    xsec,
    opts: {},
    unitState: { height: "m", wind: "kmh" },
    markerFields: () => [],
    trackName: (r) => r.label,
    now: T0,
    overlays: [{
      name: "Import",
      color: "#c45c26",
      note: "hello",
      visible: true,
      coords: [[47.05, 11.05, 1050], [47.15, 11.15, null]],
    }],
  });
  check("payload: overlays Länge", p.overlays.length === 1);
  check("payload: overlay note", p.overlays[0].note === "hello");
  check("payload: coords lat-first", p.overlays[0].coords[0][0] === 47.05);
  check("payload: Defaults defaultView", p.opts.defaultView === HTML_EXPORT_DEFAULTS.defaultView);
}

{
  const { zipSync, strToU8 } = await import("fflate");
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>KmzLine</name>
      <LineString>
        <coordinates>11.1,47.1,900 11.2,47.2,950 11.3,47.3,980</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
  const kmz = zipSync({ "doc.kml": strToU8(kml) });
  const { parseOverlayBytes, kmlFromKmz } = await import("../src/overlays/parse.js");
  const extracted = await kmlFromKmz(kmz);
  check("kmz: doc.kml extrahiert", /KmzLine/.test(extracted.kmlText));
  const { drafts } = await parseOverlayBytes(kmz, "flight.kmz");
  check("kmz: eine Spur", drafts.length === 1, `n=${drafts.length}`);
  check("kmz: Name", drafts[0]?.name === "KmzLine", drafts[0]?.name);
  check("kmz: Höhe", drafts[0]?.coords[0].z === 900, String(drafts[0]?.coords[0].z));
}

const IGC_HAPPY = [
  "AXXXABC",
  "HFDTE150717",
  "HFPLTPILOTINCHARGE:Test Pilot",
  "HFGIDGLIDERID:D-TEST",
  "B1026555103888N00703115EA0065700751",
  "B1026565103890N00703120EA0065800752",
  "B1026575103892N00703125EA0065900753",
].join("\n");

{
  const { drafts, warnings } = await parseOverlayFile(IGC_HAPPY, "flight.igc");
  check("igc: eine Spur", drafts.length === 1, `n=${drafts.length}`);
  check("igc: Name aus GID", drafts[0]?.name === "D-TEST", drafts[0]?.name);
  check("igc: 3 Punkte", drafts[0]?.coords.length === 3);
  check("igc: GPS-Höhe", drafts[0]?.coords[0].z === 751, String(drafts[0]?.coords[0].z));
  check("igc: t in ms", drafts[0]?.coords[0].t === Date.parse("2017-07-15T10:26:55Z"));
  check("igc: 1s Abstand", drafts[0]?.coords[1].t - drafts[0]?.coords[0].t === 1000);
  check("igc: sniff ohne Extra-Warnung", warnings.length === 0, warnings.join("; "));
}

{
  const igc = [
    "AXXXABC",
    "HFDTE150717",
    "B1026555103888N00703115EA0065700751",
    "B1026565103890N00703120EV0065800752",
    "B1026575103892N00703125EA0065900753",
  ].join("\n");
  const { drafts, warnings } = await parseOverlayFile(igc, "dropv.igc");
  check("igc V: 2 gültige Punkte", drafts[0]?.coords.length === 2);
  check("igc V: Warnung", warnings.some((w) => /ungültige GPS-Fixes/i.test(w)), warnings.join("; "));
  check("igc V: GPS-Höhen der A-Fixes", drafts[0]?.coords[0].z === 751 && drafts[0]?.coords[1].z === 753);
}

{
  const igc = [
    "AXXXABC",
    "HFDTE150717",
    "B1026555103888N00703115EA0065700000",
    "B1026565103890N00703120EA0065800000",
  ].join("\n");
  const { drafts } = await parseOverlayFile(igc, "press.igc");
  check("igc GPS00000: Druckhöhe", drafts[0]?.coords[0].z === 657 && drafts[0]?.coords[1].z === 658);
}

{
  const igc = [
    "AXXXABC",
    "HFDTE150717",
    "B2359005103888N00703115EA0065700751",
    "B0000015103890N00703120EA0065800752",
  ].join("\n");
  const { drafts } = await parseOverlayFile(igc, "wrap.igc");
  const t0 = drafts[0]?.coords[0].t;
  const t1 = drafts[0]?.coords[1].t;
  check("igc midnight: erster Tag", t0 === Date.parse("2017-07-15T23:59:00Z"));
  check("igc midnight: +1 Tag", t1 === Date.parse("2017-07-16T00:00:01Z"), String(t1));
}

{
  const igc = [
    "AXXXABC",
    "HFDTE150717",
    "B1026555103888N00703115EV0065700751",
    "B1026565103890N00703120EV0065800752",
  ].join("\n");
  const { drafts, warnings } = await parseOverlayFile(igc, "allv.igc");
  check("igc all-V: keine Spur", drafts.length === 0);
  check("igc all-V: Warnung Linien", warnings.some((w) => /Keine Linienzüge/i.test(w)), warnings.join("; "));
}

{
  const { drafts, warnings } = await parseOverlayFile(
    '{"type":"Point","coordinates":[1,2]}',
    "n.igc",
  );
  check("igc Dateiname: nicht als GeoJSON", drafts.length === 0);
  check(
    "igc Dateiname: IGC-Fehler",
    warnings.some((w) => /IGC-Parsefehler/i.test(w)),
    warnings.join("; "),
  );
}

{
  const { drafts } = await parseOverlayFile(IGC_HAPPY, "unnamed.txt");
  check("igc sniff ohne .igc", drafts.length === 1 && drafts[0]?.coords.length === 3);
}

{
  const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures/igc");
  const files = (await readdir(fixtureDir)).filter((f) => f.toLowerCase().endsWith(".igc")).sort();
  check("igc fixtures: Dateien vorhanden", files.length >= 12, `n=${files.length}`);
  for (const f of files) {
    const text = await readFile(join(fixtureDir, f), "utf8");
    const { drafts, warnings } = await parseOverlayFile(text, f);
    const n = drafts[0]?.coords?.length ?? 0;
    const c0 = drafts[0]?.coords?.[0];
    check(
      `igc fixture ${f}: Spur mit ≥2 Punkten`,
      drafts.length === 1 && n >= 2,
      `drafts=${drafts.length} pts=${n} ${warnings[0] || ""}`,
    );
    check(
      `igc fixture ${f}: lat/lon/t`,
      Number.isFinite(c0?.lat) && Number.isFinite(c0?.lon) && Number.isFinite(c0?.t),
      `lat=${c0?.lat} lon=${c0?.lon} t=${c0?.t}`,
    );
  }
}

console.log(failures ? `\n${failures} Fehler.` : "\nAlle Overlay-Tests bestanden.");
process.exit(failures ? 1 : 0);
