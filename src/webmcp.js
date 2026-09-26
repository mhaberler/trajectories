/** WebMCP tools for the trajectory panel. No-op when the browser has no model context. */

export const PROFILE_BLOCK = "Flugprofil ist an. Bitte ausschalten.";

export const TOOL_NAMES = [
  "get_state",
  "set_start",
  "set_model",
  "set_time",
  "set_duration",
  "set_heights",
  "fill_height_profile",
  "compute",
];

const PROFILE_GUARDED = new Set(["set_heights", "fill_height_profile", "compute"]);

export function profileBlock(name, flightProfileOn) {
  if (flightProfileOn && PROFILE_GUARDED.has(name)) return { error: PROFILE_BLOCK };
  return null;
}

/** @returns {string | null} */
export function heightListError(metres) {
  if (!Array.isArray(metres) || metres.length < 1 || metres.length > 8) {
    return "1 bis 8 Höhen angeben.";
  }
  if (metres.some((m) => !Number.isFinite(+m))) return "Höhen müssen Zahlen in Metern sein.";
  return null;
}

function modelContext() {
  if (typeof document !== "undefined" && document.modelContext?.registerTool) {
    return document.modelContext;
  }
  if (typeof navigator !== "undefined" && navigator.modelContext?.registerTool) {
    return navigator.modelContext;
  }
  return null;
}

/**
 * Register each tool on its own. One rejected schema must not hide the rest.
 * @param {object} api panel operations from app.js
 * @returns {Promise<string[]>} names that registered
 */
export async function registerWebmcp(api) {
  const ctx = modelContext();
  if (!ctx) return [];
  const registered = [];
  for (const tool of toolDefs(api)) {
    try {
      await ctx.registerTool(tool);
      registered.push(tool.name);
    } catch (err) {
      console.warn("[webmcp] register failed", tool.name, err);
    }
  }
  return registered;
}

function toolDefs(api) {
  const guard = (name, fn) => async (args) => {
    const blocked = profileBlock(name, api.flightProfileOn());
    if (blocked) return blocked;
    return fn(args || {});
  };
  return [
    {
      name: "get_state",
      description: "Read the trajectory panel: model, run time, start point, start time, duration, heights, and whether a result is drawn.",
      annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {} },
      execute: async () => api.getState(),
    },
    {
      name: "set_start",
      description: "Move the trajectory start point. Latitude and longitude in degrees.",
      inputSchema: {
        type: "object",
        properties: {
          latitude: { type: "number", minimum: -90, maximum: 90 },
          longitude: { type: "number", minimum: -180, maximum: 180 },
        },
        required: ["latitude", "longitude"],
      },
      execute: async ({ latitude, longitude }) => {
        api.setStart(latitude, longitude);
        return api.getState();
      },
    },
    {
      name: "set_model",
      description: "Select the ICON model and wait until its run metadata has loaded.",
      inputSchema: {
        type: "object",
        properties: {
          model: { type: "string", enum: ["icon_eu", "icon_d2", "icon_global"] },
        },
        required: ["model"],
      },
      execute: async ({ model }) => api.setModel(model),
    },
    {
      name: "set_time",
      description: "Set the trajectory start time as ISO-8601 UTC. Rejected when it is outside the loaded model span.",
      inputSchema: {
        type: "object",
        properties: { time: { type: "string" } },
        required: ["time"],
      },
      execute: async ({ time }) => api.setTime(time),
    },
    {
      name: "set_duration",
      description: "Set the forecast duration in hours. Clamped to the model horizon (minimum 0.25).",
      inputSchema: {
        type: "object",
        properties: { hours: { type: "number", minimum: 0.25 } },
        required: ["hours"],
      },
      execute: async ({ hours }) => api.setDurationHours(hours),
    },
    {
      name: "set_heights",
      description: "Replace the start heights with 1 to 8 metre values in the current height reference (AGL or AMSL). Refuses while flight profile is on.",
      inputSchema: {
        type: "object",
        properties: {
          heights: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 8 },
        },
        required: ["heights"],
      },
      execute: guard("set_heights", ({ heights }) => {
        const err = heightListError(heights);
        if (err) return { error: err };
        return api.setHeights(heights.map((m) => +m));
      }),
    },
    {
      name: "fill_height_profile",
      description: "Fill start heights from the generator. Floor 0 means ground at the start point. Refuses while flight profile is on.",
      inputSchema: {
        type: "object",
        properties: {
          n: { type: "number", minimum: 1, maximum: 8 },
          nBelow: { type: "number", minimum: 0, maximum: 7 },
          floor: { type: "number" },
          ceiling: { type: "number" },
          marker: { type: "number" },
        },
        required: ["n", "nBelow", "floor", "ceiling", "marker"],
      },
      execute: guard("fill_height_profile", (knobs) => api.fillHeightProfile(knobs)),
    },
    {
      name: "compute",
      description: "Compute trajectories from the current panel settings and wait until the run finishes. Refuses while flight profile is on.",
      inputSchema: { type: "object", properties: {} },
      execute: guard("compute", () => api.compute()),
    },
  ];
}
