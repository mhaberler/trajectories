/**
 * Query-Parse/Write für den HTML-Export-Viewer (ohne DOM/history).
 */
import {
  applyViewStateToSearch,
  hasCamera,
  parseViewState,
} from "../src/export/htmlUrl.ts";

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

{
  const s = parseViewState("view=3d&profile=1&exagg=4.5&lon=15.63001&lat=48.45002&h=4200.1&heading=28.2&pitch=-32.3&roll=0.4");
  check("parse: view 3d", s.view === "3d");
  check("parse: profile on", s.profile === true);
  check("parse: exagg", s.exagg === 4.5, String(s.exagg));
  check("parse: has camera", hasCamera(s));
  check("parse: lon", s.camera?.lon === 15.63001, String(s.camera?.lon));
  check("parse: pitch", s.camera?.pitch === -32.3, String(s.camera?.pitch));
}

{
  const s = parseViewState("view=2d&profile=0");
  check("parse: view 2d", s.view === "2d");
  check("parse: profile off", s.profile === false);
  check("parse: no camera", s.camera === null);
}

{
  const s = parseViewState("profile=true&view=bogus&exagg=0.5&lon=10");
  check("parse: profile true alias", s.profile === true);
  check("parse: bad view ignored", s.view === undefined);
  check("parse: exagg below 1 ignored", s.exagg === undefined);
  check("parse: incomplete camera null", s.camera === null);
}

{
  const cam = { lon: 15.630009, lat: 48.450021, h: 4200.14, heading: 28.24, pitch: -32.36, roll: 0.41 };
  const q = applyViewStateToSearch("foo=bar", {
    view: "3d",
    profile: false,
    exagg: 3,
    camera: cam,
  });
  const back = parseViewState(q);
  check("roundtrip: keeps unrelated", q.includes("foo=bar"));
  check("roundtrip: view", back.view === "3d");
  check("roundtrip: profile", back.profile === false);
  check("roundtrip: exagg", back.exagg === 3);
  check("roundtrip: lon rounded", back.camera?.lon === 15.63001, String(back.camera?.lon));
  check("roundtrip: h rounded", back.camera?.h === 4200.1, String(back.camera?.h));
}

{
  const q = applyViewStateToSearch("view=3d&lon=1&lat=2&h=3&heading=4&pitch=5&roll=6", {
    view: "2d",
    camera: null,
  });
  const back = parseViewState(q);
  check("drop cam: view 2d", back.view === "2d");
  check("drop cam: no lon", !q.includes("lon="));
  check("drop cam: camera null", back.camera === null);
}

console.log(failures ? `\n${failures} Fehler.` : "\nAlle htmlUrl-Tests bestanden.");
process.exit(failures ? 1 : 0);
