/**
 * API-Origin-Normalisierung und Runtime-Overrides in config.js.
 */
import {
  DEFAULT_API_BASE,
  DEFAULT_TRAJECTORY_API,
  MODELS,
  modelApiBase,
  modelForecastUrl,
  normalizeApiOrigin,
  omApiBase,
  setApiEndpoints,
  trajectoryApi,
} from "../src/config.js";

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

check("empty → null", normalizeApiOrigin("") === null);
check("whitespace → null", normalizeApiOrigin("  ") === null);
check("relative → null", normalizeApiOrigin("/v1") === null);
check("javascript → null", normalizeApiOrigin("javascript:alert(1)") === null);
check("ftp → null", normalizeApiOrigin("ftp://om.example") === null);

check(
  "https default stripped slash",
  normalizeApiOrigin("https://trajectory.mah.priv.at/") === DEFAULT_TRAJECTORY_API,
);
check(
  "host:port",
  normalizeApiOrigin("http://127.0.0.1:8000/") === "http://127.0.0.1:8000",
);
check(
  "path kept without trailing slash",
  normalizeApiOrigin("https://example.com/api/") === "https://example.com/api",
);

setApiEndpoints({ trajectoryApi: "", apiBase: "" });
check("getter default traj", trajectoryApi() === DEFAULT_TRAJECTORY_API);
check("getter default om", omApiBase() === DEFAULT_API_BASE);

setApiEndpoints({ trajectoryApi: "https://api.example:8443/" });
check("override traj", trajectoryApi() === "https://api.example:8443");
setApiEndpoints({ trajectoryApi: DEFAULT_TRAJECTORY_API });
check("same as default clears override", trajectoryApi() === DEFAULT_TRAJECTORY_API);

setApiEndpoints({ apiBase: "https://om.example/" });
check("override om", omApiBase() === "https://om.example");
check("icon_d2 uses override", modelApiBase(MODELS.icon_d2) === "https://om.example");
check("icon_global uses override", modelApiBase(MODELS.icon_global) === "https://om.example");
check(
  "icon_global forecast path",
  modelForecastUrl(MODELS.icon_global) === "https://om.example/v1/forecast",
);

setApiEndpoints({ trajectoryApi: "", apiBase: "" });

if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log("ok");
