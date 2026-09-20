import {
  bearingDeg,
  cardinalFromDeg,
  metricsAt,
  nearestTrackPoint,
  speedKmh,
} from "../src/overlays/sample.js";
import { displayStride } from "../src/overlays/canvasTrack.js";

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

{
  const a = { lat: 47, lon: 11 };
  const north = { lat: 48, lon: 11 };
  const east = { lat: 47, lon: 12 };
  const bN = bearingDeg(a, north);
  const bE = bearingDeg(a, east);
  check("bearing Nord ≈ 0", bN != null && (bN < 2 || bN > 358), String(bN));
  check("bearing Ost ≈ 90", bE != null && Math.abs(bE - 90) < 2, String(bE));
  check("cardinal N", cardinalFromDeg(0) === "N");
  check("cardinal O", cardinalFromDeg(90) === "O");
}

{
  const a = { lat: 50, lon: 10, t: 1_000_000 };
  const b = { lat: 50.01, lon: 10, t: 1_000_000 + 36_000 };
  const v = speedKmh(a, b);
  check("speed endlich", v != null && Number.isFinite(v), String(v));
  check("speed ~111 km/h (0.01°/36s)", v != null && Math.abs(v - 111.2) < 5, String(v));
  check("speed ohne Zeit", speedKmh({ lat: 1, lon: 1 }, { lat: 2, lon: 2 }) == null);
}

{
  const coords = [
    { lat: 47.0, lon: 11.0, z: 800, t: 0 },
    { lat: 47.1, lon: 11.0, z: 900, t: 3600_000 },
    { lat: 47.2, lon: 11.0, z: 1000, t: 7200_000 },
  ];
  const m0 = metricsAt(coords, 0);
  const m2 = metricsAt(coords, 2);
  check("metrics z", m0.z === 800 && m2.z === 1000);
  check("metrics heading Nord", m0.headingDeg != null && (m0.headingDeg < 2 || m0.headingDeg > 358));
  check("metrics last uses prev segment", m2.headingDeg != null && (m2.headingDeg < 2 || m2.headingDeg > 358));
  check("metrics speed", m0.speedKmh != null && m0.speedKmh > 0);
  check("metricsAt OOB", metricsAt(coords, -1) == null && metricsAt(coords, 9) == null);
}

function fakeMap() {
  return {
    latLngToContainerPoint(ll) {
      return { x: ll.lng * 100, y: -ll.lat * 100 };
    },
  };
}

{
  const tracks = [
    {
      id: "a",
      name: "A",
      visible: true,
      coords: [
        { lat: 47, lon: 11 },
        { lat: 48, lon: 11 },
      ],
    },
    {
      id: "b",
      name: "B",
      visible: true,
      coords: [
        { lat: 47, lon: 12 },
        { lat: 48, lon: 12 },
      ],
    },
  ];
  const map = fakeMap();
  const hit = nearestTrackPoint(tracks, { lat: 47.01, lng: 11.01 }, map, 5);
  check("nearest: Spur A", hit?.track?.id === "a", hit?.track?.id);
  check("nearest: Index 0", hit?.index === 0, String(hit?.index));
  const miss = nearestTrackPoint(tracks, { lat: 40, lng: 0 }, map, 5);
  check("nearest: miss", miss == null);
  tracks[0].visible = false;
  const hitB = nearestTrackPoint(tracks, { lat: 47, lng: 12 }, map, 5);
  check("nearest: unsichtbar übersprungen", hitB?.track?.id === "b");
}

{
  check("canvas stride 1 unter Cap", displayStride(8000) === 1);
  check("canvas stride über Cap", displayStride(16000) === 2);
}

console.log(failures ? `\n${failures} Fehler.` : "\nAlle Sample-Tests bestanden.");
process.exit(failures ? 1 : 0);
