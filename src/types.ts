/**
 * Gemeinsame Datenformen der Trajektorien-App.
 *
 * Diese Typen beschreiben, was `integrator.js` erzeugt und was app.js in
 * `state.lastRuns` / `state.xsec` weiterreicht — bisher nur als verstreute
 * JSDoc-Kommentare vorhanden. Querschnitt und Export lesen alle davon.
 */

/** Vertikalfläche, entlang der integriert wird (siehe windfield.js). */
export type MethodKey = "height" | "pressure" | "theta" | "z3d";

/** Höhenbezug der Startangabe. */
export type HeightMode = "agl" | "amsl";

/** +1 vorwärts, -1 rückwärts. */
export type Direction = 1 | -1;

/** Zusatzparameter an einer Zeitmarke (nur wenn „Zusatzparameter" aktiv). */
export interface MetData {
  /** Temperatur (°C) */
  t: number;
  /** Taupunkt (°C) */
  td: number;
  /** relative Feuchte (%) */
  rh: number;
  /** Druck (hPa) */
  p: number;
}

/** Stützpunkt der Trajektorie. `z` ist AMSL in Metern, null solange unbekannt. */
export interface TrajPoint {
  lat: number;
  lon: number;
  z: number | null;
  tMs: number;
}

/** Zeitmarke mit Windvektor (m/s) und optionalen Zusatzparametern. */
export interface Marker {
  lat: number;
  lon: number;
  z: number | null;
  tMs: number;
  /** Ostkomponente (m/s) */
  u: number;
  /** Nordkomponente (m/s) */
  v: number;
  met?: MetData | null;
}

/** Rohergebnis aus `computeTrajectory`. */
export interface TrajResult {
  points: TrajPoint[];
  markers: Marker[];
  status: "ok" | "stopped";
  reason: string | null;
}

/**
 * Ein berechneter Lauf samt Darstellung. `terrain` ist die Modellorographie
 * entlang des Pfades (ein Wert je Punkt in `r.points`, null wo unbekannt);
 * `terrainHi` das dichter abgetastete Mapterhorn-DEM aus der API — anders
 * abgetastet, daher eigene Zeitachse statt Index-Parallelität.
 */
export interface Run {
  r: TrajResult;
  /** #rrggbb */
  color: string;
  label: string;
  heightM: number;
  method: MethodKey;
  /** SVG stroke-dasharray, null = durchgezogen */
  dash: string | null;
  terrain?: (number | null)[];
  terrainHi?: TerrainSeries;
}

/** DEM-Profil entlang eines Pfades: Höhe (m NN) über Sekunden seit Start. */
export type TerrainSeries = { tSec: number; z: number }[];

/** Was der Download-Handler exportiert (`state.lastRuns`). */
export interface LastRuns {
  runs: Run[];
  modelKey: string;
  mode: HeightMode;
  t0Ms: number;
  /** angeforderte Dauer in Stunden */
  duration: number;
  direction: Direction;
}

/**
 * Eingabe für `renderCrossSection`. `runs` trägt hier immer ein `terrain`
 * (mit null aufgefüllt, nie fehlend). Bei `overlay` liegen alle Serien in
 * einem Streifen, das Gelände stammt dann vom Referenzpfad (erste Serie).
 */
export interface XsecData {
  runs: (Run & { terrain: (number | null)[] })[];
  t0Ms: number;
  direction: Direction;
  overlay: boolean;
  /**
   * @deprecated Altlast: DEM des ersten Streifens. Neu steckt das DEM je Lauf
   * in `run.terrainHi`; hier nur noch als Rückfall für die Flugprofil-Ansicht.
   */
  terrainHi?: TerrainSeries;
}
