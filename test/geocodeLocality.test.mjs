/**
 * Ortsauflösung für Dateinamen (Stadt/Gemeinde, nicht Straße).
 */
import { localityName } from "../src/geocode.js";

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
}

{
  check(
    "street reverse → city",
    localityName({ name: "Flurgasse", street: "Flurgasse", city: "Lieboch", osm_value: "street" }) === "Lieboch",
  );
  check(
    "village feature",
    localityName({ name: "Lieboch", osm_value: "village" }) === "Lieboch",
  );
  check(
    "town field",
    localityName({ name: "Hauptplatz", town: "Graz", osm_value: "pedestrian" }) === "Graz",
  );
  check(
    "street only → null",
    localityName({ name: "Flurgasse", street: "Flurgasse", osm_value: "street" }) === null,
  );
}

console.log(failures ? `\n${failures} Fehler.` : "\nAlle geocode-locality-Tests bestanden.");
process.exit(failures ? 1 : 0);
