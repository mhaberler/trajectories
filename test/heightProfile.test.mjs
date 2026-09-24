import { fillHeightProfile, resolveFloor } from "../src/heightProfile.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const ground = resolveFloor(0, "amsl", 437);
assert(ground === 400, `amsl ground snap ${ground}`);
assert(resolveFloor(0, "agl", 437) === 0, "agl floor 0");
assert(resolveFloor(250, "agl", 437) === 300, "explicit floor snaps 100");

const filled = fillHeightProfile(
  { n: 8, nBelow: 3, floor: 0, ceiling: 1500, marker: 500 },
  { mode: "agl" },
);
assert(filled.alts.length === 8, `expected 8, got ${filled.alts.join(",")}`);
assert(filled.alts[0] === 0, "floor kept");
assert(filled.alts.includes(500), "marker kept");
assert(filled.alts.at(-1) === 1500, "ceiling kept");
assert(filled.alts.filter((m) => m < 500).length === 3, "three strictly below marker");
assert(filled.alts.every((m, i) => i === 0 || m > filled.alts[i - 1]), "strictly increasing");

const tight = fillHeightProfile(
  { n: 8, nBelow: 3, floor: 0, ceiling: 100, marker: 100 },
  { mode: "agl" },
);
assert(tight.alts.length < 8, "tight band drops extras");
assert(tight.warning, "warning when short");

const one = fillHeightProfile(
  { n: 1, nBelow: 5, floor: 0, ceiling: 1500, marker: 800 },
  { mode: "agl" },
);
assert(one.alts.length === 1 && one.alts[0] === 800, `single is marker ${one.alts}`);

console.log("heightProfile ok");
