import {
  heightListError, profileBlock, registerWebmcp, PROFILE_BLOCK, TOOL_NAMES,
} from "../src/webmcp.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(heightListError([]) === "1 bis 8 Höhen angeben.", "empty list");
assert(heightListError([1, 2, 3, 4, 5, 6, 7, 8, 9]), "nine heights");
assert(heightListError([100, "x"]), "non-numeric");
assert(heightListError([0, 500, 1500]) === null, "three heights ok");

assert(profileBlock("compute", true)?.error === PROFILE_BLOCK, "compute blocked");
assert(profileBlock("set_heights", true)?.error === PROFILE_BLOCK, "heights blocked");
assert(profileBlock("fill_height_profile", true)?.error === PROFILE_BLOCK, "fill blocked");
assert(profileBlock("set_start", true) === null, "set_start allowed");
assert(profileBlock("compute", false) === null, "compute allowed when profile off");
assert(TOOL_NAMES.length === 8, "eight tools");
assert((await registerWebmcp({})).length === 0, "no model context");

const registered = [];
const rejected = new Set(["set_duration"]);
globalThis.document = {
  modelContext: {
    async registerTool(tool) {
      if (tool.name === "fill_height_profile") {
        assert(tool.inputSchema.properties.n.type === "number", "n is number");
        assert(tool.inputSchema.properties.nBelow.type === "number", "nBelow is number");
      }
      if (rejected.has(tool.name)) throw new Error("schema rejected");
      registered.push(tool.name);
    },
  },
};
const names = await registerWebmcp({ flightProfileOn: () => false });
assert(names.includes("get_state") && names.includes("compute"), "later tools still register");
assert(!names.includes("set_duration"), "rejected tool omitted");
assert(names.length === 7, "seven tools");
assert(registered.length === 7, "register calls continued");

console.log("webmcp ok");
