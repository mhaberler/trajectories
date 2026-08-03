import { expandProfile, targetStepPolyline } from "../src/profileExpand.js";

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

// Flat jump profile
{
  const out = expandProfile([
    { tSec: 0, targetAgl: 500, rate: "jump" },
    { tSec: 3600, targetAgl: 500, rate: "jump" },
  ]);
  check("flat: 2 points", out.length === 2);
  check("flat: heights", out[0].hAgl === 500 && out[1].hAgl === 500);
}

// Jump climb across full gap
{
  const out = expandProfile([
    { tSec: 0, targetAgl: 150, rate: "jump" },
    { tSec: 1200, targetAgl: 1800, rate: "jump" },
  ]);
  check("jump: 2 points", out.length === 2, `n=${out.length}`);
  check("jump: ends at target", out[1].hAgl === 1800 && out[1].tSec === 1200);
}

// Finite rate: back-timed ramp (1650 m at 3 m/s = 550 s)
{
  const out = expandProfile([
    { tSec: 0, targetAgl: 150, rate: "jump" },
    { tSec: 1200, targetAgl: 1800, rate: 3 },
  ]);
  check("rate: has hold corner", out.length === 3, `n=${out.length}`);
  check("rate: ramp start", Math.abs(out[1].tSec - (1200 - 550)) < 1e-6 && out[1].hAgl === 150,
    `t=${out[1]?.tSec} h=${out[1]?.hAgl}`);
  check("rate: arrives on time", out[2].tSec === 1200 && out[2].hAgl === 1800);
}

// Rate clamped when gap too short (300 m in 10 s needs 30 m/s; rate 3 → full-gap ramp)
{
  const out = expandProfile([
    { tSec: 0, targetAgl: 100, rate: "jump" },
    { tSec: 10, targetAgl: 400, rate: 3 },
  ]);
  // need = 100 s > gap 10 → tStart = tPrev → no hold corner
  check("clamp: no hold when gap short", out.length === 2, `n=${out.length}`);
  check("clamp: steep across gap", out[0].hAgl === 100 && out[1].hAgl === 400);
}

// Target step polyline
{
  const steps = targetStepPolyline([
    { tSec: 0, targetAgl: 100 },
    { tSec: 60, targetAgl: 200 },
  ]);
  check("steps: hold then jump", steps.length === 3
    && steps[0].hAgl === 100
    && steps[1].tSec === 60 && steps[1].hAgl === 100
    && steps[2].hAgl === 200);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll profileExpand tests passed.");
