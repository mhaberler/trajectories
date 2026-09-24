import { canSampleWind, modelRowsHtml, towardDeg } from "../track-import/hindcast.js";

let failed = 0;
function check(name, ok, detail) {
  if (ok) return;
  failed += 1;
  console.error("FAIL", name, detail ?? "");
}

check("toward +180", towardDeg(270) === 90, towardDeg(270));
check("toward wrap", towardDeg(10) === 190, towardDeg(10));
check("toward missing", towardDeg(null) === null);
check("no sample without z", canSampleWind({ lat: 47, lon: 12, z: null, t: 1 }) === false);
check("no sample negative amsl", canSampleWind({ lat: 47, lon: 12, z: -1, t: 1 }) === false);

const loading = modelRowsHtml("loading");
check("loading ellipsis", loading.includes(">…<") && loading.includes(">D2<") && loading.includes(">Global<"));

const rows = modelRowsHtml([
  { model: "icon_d2", wind_speed_kmh: 12.4, wind_direction_deg: 265 },
  { model: "icon_eu", error: true, reason: "outside" },
  { model: "icon_global", wind_speed_kmh: 8, wind_direction_deg: 0 },
]);
const marked = modelRowsHtml([
  { model: "icon_d2", wind_speed_kmh: 21, wind_direction_deg: 280 },
  { model: "icon_eu", wind_speed_kmh: 30, wind_direction_deg: 268 },
  { model: "icon_global", wind_speed_kmh: 40, wind_direction_deg: 0 },
], { speedKmh: 20, headingDeg: 90 });
check("d2 toward", rows.includes("12.4 km/h · 85° O"), rows);
check("eu omitted", !rows.includes(">EU<"), rows);
check("global north becomes south", rows.includes("8.0 km/h · 180° S"), rows);
check("closest speed is d2", marked.includes(">D2</span><b><span class=\"hud-close\">21.0 km/h</span>"), marked);
check("closest dir is eu", marked.includes("<span class=\"hud-close\">88° O</span>"), marked);
check("global unmarked", !marked.includes("hud-close\">40.0") && !marked.includes("hud-close\">180°"), marked);
check("empty is blank", modelRowsHtml(null) === "");

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("hindcast ok");
