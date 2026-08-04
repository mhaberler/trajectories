import { expandProfile } from "../src/profileExpand.js";

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

{
  const out = expandProfile([
    { tSec: 0, targetAgl: 500 },
    { tSec: 3600, targetAgl: 500 },
  ]);
  check("flat: 2 points", out.length === 2);
  check("flat: heights", out[0].hAgl === 500 && out[1].hAgl === 500);
}

{
  const out = expandProfile([
    { tSec: 0, targetAgl: 150 },
    { tSec: 1200, targetAgl: 1800 },
  ]);
  check("climb: 2 points", out.length === 2, `n=${out.length}`);
  check("climb: ends at target", out[1].hAgl === 1800 && out[1].tSec === 1200);
}

{
  const out = expandProfile([
    { tSec: 1200, targetAgl: 1800 },
    { tSec: 0, targetAgl: 150 },
  ]);
  check("sort: times ascending", out[0].tSec === 0 && out[1].tSec === 1200);
  check("sort: heights follow", out[0].hAgl === 150 && out[1].hAgl === 1800);
}

{
  let threw = false;
  try {
    expandProfile([{ tSec: 0, targetAgl: 100 }]);
  } catch {
    threw = true;
  }
  check("rejects single point", threw);
}

{
  let threw = false;
  try {
    expandProfile([
      { tSec: 0, targetAgl: 100 },
      { tSec: 0, targetAgl: 200 },
    ]);
  } catch {
    threw = true;
  }
  check("rejects non-increasing times", threw);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll profileExpand tests passed.");
