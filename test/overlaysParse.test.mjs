import { lineCoords, overlaysFromGeoJSON, parseOverlayFile } from "../src/overlays/parse.js";
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
  const { drafts } = await parseOverlayFile(GPX, "flight.gpx");
  check("gpx: eine Spur", drafts.length === 1, `n=${drafts.length}`);
  check("gpx: Name", drafts[0]?.name === "TestTrack", drafts[0]?.name);
  check("gpx: 3 Punkte mit ele", drafts[0]?.coords.length === 3 && drafts[0].coords[0].z === 1000);
}

{
  const { drafts } = await parseOverlayFile(KML, "line.kml");
  check("kml: eine Spur", drafts.length === 1, `n=${drafts.length}`);
  check("kml: Name", drafts[0]?.name === "KmlLine", drafts[0]?.name);
  check("kml: Höhe", drafts[0]?.coords[0].z === 900, String(drafts[0]?.coords[0].z));
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

console.log(failures ? `\n${failures} Fehler.` : "\nAlle Overlay-Tests bestanden.");
process.exit(failures ? 1 : 0);
