/**
 * Viewer der exportierten HTML-Karte.
 *
 * Wird als eigener Vite-Einstieg im IIFE-Format gebaut und danach per `?raw`
 * in das Exportdokument eingebettet. Dadurch laufen `crosssection` und `units`
 * über den echten Modulgraphen — kein Textumbau am Quelltext nötig.
 *
 * Leaflet liegt zur Laufzeit als globales `L` vor (davor eingebettet).
 */

import { renderCrossSection } from "../crosssection";
import { setUnits } from "../units";
import type { XsecData } from "../types";
import type { Payload, PayloadRun, PopupRow } from "./htmlPayload";
import { readViewState, writeViewState } from "./htmlUrl";

declare const L: any;

interface Track {
  run: PayloadRun;
  layer: any;
  bounds: any;
}

interface OverlayTrack {
  name: string;
  color: string;
  note: string;
  visible: boolean;
  layer: any;
  bounds: any;
}

export interface ViewerApi {
  invalidateSize: () => void;
  morphRuns: (runs: PayloadRun[]) => void;
  setProfileXsec: (xsec: XsecData) => void;
}

let viewerMap: any = null;
let viewerTracks: Track[] = [];
let viewerPayload: Payload | null = null;
let profileXsec: XsecData | null = null;
let altitudeKey: string | null = null;
let profileRedraw: (() => void) | null = null;

function esc(s: string) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

/**
 * Basiskarten. Die `attribution` ist Lizenzpflicht, keine Zierde — sie muss
 * an jeder Kachelquelle hängen bleiben.
 */
function buildBaseLayers() {
  return {
    "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      subdomains: ["a", "b", "c"],
    }),
    "OpenTopoMap": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17,
      subdomains: ["a", "b", "c"],
      attribution: "© OpenStreetMap contributors, SRTM | © <a href=\"https://opentopomap.org\">OpenTopoMap</a> (CC-BY-SA)",
    }),
    "Esri Satellit (hybrid)": L.layerGroup([
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19,
      }),
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19,
        pane: "overlayPane",
        zIndex: 2,
      }),
    ], {
      attribution: "© Esri, USDA, USGS © OpenStreetMap contributors, and the GIS user community",
    }),
  } as Record<string, any>;
}

/** Deckkraft auf die aktive Basiskarte anwenden (Esri ist eine Gruppe). */
function applyOpacity(layer: any, v: number) {
  if (!layer) return;
  if (typeof layer.setOpacity === "function") layer.setOpacity(v);
  else if (typeof layer.eachLayer === "function") layer.eachLayer((l: any) => l.setOpacity?.(v));
}

function buildOpacityControl(map: any, getActive: () => any, initial: number) {
  const Ctl = L.Control.extend({
    onAdd() {
      const d = L.DomUtil.create("div", "gv-opacity");
      d.innerHTML = '<span>Karte</span><input type="range" min="0.2" max="1" step="0.05" />';
      const inp = d.querySelector("input") as HTMLInputElement;
      inp.value = String(initial);
      L.DomEvent.disableClickPropagation(d);
      L.DomEvent.disableScrollPropagation(d);
      inp.addEventListener("input", () => applyOpacity(getActive(), +inp.value));
      return d;
    },
  });
  map.addControl(new Ctl({ position: "bottomleft" }));
}

/** Popup-Inhalt aus den vorberechneten Zeilen (bereits in Anzeige-Einheit). */
function popupHtml(name: string, rows: PopupRow[]) {
  const body = rows
    .map((r) => `<tr><td style="padding-right:6px;color:#52514e">${esc(r.label)}</td><td>${esc(r.value)}</td></tr>`)
    .join("");
  return `<strong>${esc(name)}</strong><table style="border-collapse:collapse;margin-top:3px">${body}</table>`;
}

function altitudeOptionKey(run: { heightM: number; method: string }) {
  return `${run.heightM}|${run.method}`;
}

function filterXsecByAltitude(xsec: XsecData, key: string | null): XsecData {
  if (!key || !xsec?.runs?.length) return xsec;
  const runs = xsec.runs.filter((r) => altitudeOptionKey(r) === key);
  if (!runs.length) return { ...xsec, runs: [xsec.runs[0]], overlay: false };
  return { ...xsec, runs, overlay: false };
}

function trackKey(run: PayloadRun) {
  return `${run.heightM}|${run.method}`;
}

function buildOneTrack(
  map: any,
  data: Payload,
  run: PayloadRun,
  { addToMap = true }: { addToMap?: boolean } = {},
): Track {
  const { opts } = data;
  const latlngs = run.pts.map((p) => [p[0], p[1]]);
  const group = L.layerGroup();
  L.polyline(latlngs, {
    color: run.color,
    weight: opts.lineWidth,
    opacity: opts.lineOpacity,
    dashArray: run.dash || undefined,
  }).bindTooltip(run.name, { sticky: true }).addTo(group);

  for (const m of run.markers) {
    L.circleMarker([m.lat, m.lon], {
      radius: opts.markerRadius,
      color: run.color,
      weight: 1.5,
      fillColor: "#ffffff",
      fillOpacity: 1,
    }).bindPopup(popupHtml(run.name, m.rows)).addTo(group);
  }
  if (addToMap) group.addTo(map);
  return { run, layer: group, bounds: L.latLngBounds(latlngs) };
}

function buildTracks(map: any, data: Payload, runs: PayloadRun[]): Track[] {
  return runs.map((run) => buildOneTrack(map, data, run));
}

/** Schwebender Kasten mit Kopfzeile: verschiebbar, per Doppelklick einklappbar. */
function floatingPanel(map: any, position: string, title: string, body: HTMLElement) {
  const Ctl = L.Control.extend({
    onAdd() {
      const d = L.DomUtil.create("div", "gv-panel") as HTMLElement;
      const head = L.DomUtil.create("div", "gv-panel-head", d) as HTMLElement;
      head.textContent = title;
      const wrap = L.DomUtil.create("div", "gv-panel-body", d) as HTMLElement;
      wrap.appendChild(body);
      L.DomEvent.disableClickPropagation(d);
      L.DomEvent.disableScrollPropagation(d);
      head.addEventListener("dblclick", (e) => {
        e.preventDefault();
        d.classList.toggle("collapsed");
      });
      // Ziehen per Pointer; Leaflet-Panning bleibt dabei aus.
      let drag: { dx: number; dy: number } | null = null;
      head.addEventListener("pointerdown", (e) => {
        const r = d.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        head.setPointerCapture(e.pointerId);
        d.style.position = "fixed";
        d.style.margin = "0";
      });
      head.addEventListener("pointermove", (e) => {
        if (!drag) return;
        d.style.left = `${e.clientX - drag.dx}px`;
        d.style.top = `${e.clientY - drag.dy}px`;
        d.style.right = "auto";
        d.style.bottom = "auto";
      });
      head.addEventListener("pointerup", (e) => {
        drag = null;
        head.releasePointerCapture(e.pointerId);
      });
      return d;
    },
  });
  return map.addControl(new Ctl({ position }));
}

/**
 * @param onProfile Schalter für den Querschnitt; fehlt er (keine Höhendaten),
 *                  entfällt die Zeile am Ende der Liste.
 */
function buildTracklist(
  map: any,
  tracks: Track[],
  overlays: OverlayTrack[],
  onProfile: ((on: boolean) => void) | null,
  profileOn: boolean,
) {
  const body = document.createElement("div");

  for (const t of tracks) {
    const row = document.createElement("div");
    row.className = "gv-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.addEventListener("change", () => {
      if (cb.checked) t.layer.addTo(map);
      else map.removeLayer(t.layer);
    });

    const chip = document.createElement("span");
    chip.className = "chip";
    chip.style.background = t.run.color;

    const name = document.createElement("span");
    name.className = "gv-name";
    name.textContent = t.run.label;
    name.title = t.run.name;

    const zoom = document.createElement("button");
    zoom.className = "gv-zoom";
    zoom.textContent = "⤢";
    zoom.title = "Auf diesen Track zoomen";
    zoom.addEventListener("click", () => map.fitBounds(t.bounds, { padding: [20, 20] }));

    row.append(cb, chip, name, zoom);
    body.appendChild(row);
  }

  if (overlays.length) {
    const head = document.createElement("div");
    head.className = "gv-section";
    head.textContent = "Flugspuren";
    body.appendChild(head);

    for (const o of overlays) {
      const row = document.createElement("div");
      row.className = "gv-row";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = o.visible !== false;
      cb.addEventListener("change", () => {
        if (cb.checked) o.layer.addTo(map);
        else map.removeLayer(o.layer);
      });

      const chip = document.createElement("span");
      chip.className = "chip";
      chip.style.background = o.color;

      const name = document.createElement("span");
      name.className = "gv-name";
      name.textContent = o.name;
      if (o.note) name.title = o.note;

      const zoom = document.createElement("button");
      zoom.className = "gv-zoom";
      zoom.textContent = "⤢";
      zoom.title = "Auf diese Flugspur zoomen";
      zoom.addEventListener("click", () => {
        if (o.bounds?.isValid?.()) map.fitBounds(o.bounds, { padding: [20, 20] });
      });

      row.append(cb, chip, name, zoom);
      body.appendChild(row);
    }
  }

  // Querschnitt-Schalter am Ende der Liste, abgesetzt von den Tracks.
  if (onProfile) {
    const row = document.createElement("div");
    row.className = "gv-row gv-row-opt";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "gv-profile-toggle";
    cb.checked = profileOn;
    cb.addEventListener("change", () => {
      onProfile(cb.checked);
      writeViewState({ profile: cb.checked });
    });

    const label = document.createElement("label");
    label.className = "gv-name";
    label.htmlFor = cb.id;
    label.textContent = "Höhenprofil";
    label.title = "Querschnitt unter der Karte ein-/ausblenden";

    row.append(cb, label);
    body.appendChild(row);
  }
  floatingPanel(map, "topright", "Tracks", body);
}

function buildLegend(map: any, html: string, generated: string) {
  const body = document.createElement("div");
  body.className = "gv-legend-body";
  // Absicht: Der Text ist HTML. Verfasser ist, wer exportiert — hier wird
  // nicht saniert, ein halber Filter wäre schlechter als gar keiner.
  body.innerHTML = html;
  const foot = document.createElement("div");
  foot.className = "gv-foot";
  foot.textContent = `Erzeugt ${generated.slice(0, 16).replace("T", " ")}Z · Windtrajektorien`;
  body.appendChild(foot);
  floatingPanel(map, "topleft", "Legende", body);
}

/**
 * Querschnitt unter der Karte. Gibt einen Schalter zurück, damit die
 * Tracklist ihn ein- und ausblenden kann; `profileOn` ist der Anfangszustand
 * (URL oder Export-Default).
 * @returns null, wenn es gar keine Höhendaten gibt (dann kein Schalter).
 */
function buildProfile(map: any, data: Payload, profileOn: boolean): ((on: boolean) => void) | null {
  const host = document.getElementById("profile") as HTMLElement;
  if (!data.xsec?.runs?.length) {
    host.style.display = "none";
    return null;
  }
  profileXsec = data.xsec;
  altitudeKey = altitudeOptionKey(data.xsec.runs[0]);

  host.innerHTML = "";
  const toolbar = document.createElement("div");
  toolbar.className = "gv-profile-toolbar";
  const lab = document.createElement("label");
  lab.textContent = "Höhe ";
  const sel = document.createElement("select");
  sel.id = "gv-xsec-alt";
  const seen = new Set<string>();
  for (const run of data.xsec.runs) {
    const key = altitudeOptionKey(run);
    if (seen.has(key)) continue;
    seen.add(key);
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = run.label || `${run.heightM} m`;
    sel.appendChild(opt);
  }
  sel.value = altitudeKey;
  sel.addEventListener("change", () => {
    altitudeKey = sel.value;
    draw();
  });
  lab.appendChild(sel);
  toolbar.appendChild(lab);
  const chart = document.createElement("div");
  chart.id = "gv-xsec-chart";
  chart.style.cssText = "flex:1;min-height:0;width:100%";
  host.append(toolbar, chart);

  const draw = () => {
    if (!profileXsec || chart.clientWidth <= 0) return;
    renderCrossSection(chart, filterXsecByAltitude(profileXsec, altitudeKey));
  };
  profileRedraw = draw;

  let last = -1;
  const redraw = () => {
    const w = Math.round(host.clientWidth);
    if (w > 0 && w !== last) {
      last = w;
      draw();
    }
  };
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(redraw).observe(host);
  requestAnimationFrame(redraw);
  window.addEventListener("load", redraw);
  let t: ReturnType<typeof setTimeout>;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(redraw, 120);
  });

  const setVisible = (on: boolean) => {
    host.style.display = on ? "flex" : "none";
    host.style.flexDirection = "column";
    host.style.height = on ? `${data.opts.profileHeight}px` : "";
    setTimeout(() => {
      map.invalidateSize();
      last = -1;
      redraw();
    }, 0);
  };
  setVisible(profileOn);
  return setVisible;
}

function initViewer(data: Payload): ViewerApi {
  setUnits(data.units);
  document.title = data.meta.title;
  viewerPayload = data;

  const bases = buildBaseLayers();
  const startName = bases[data.opts.defaultBase] ? data.opts.defaultBase : "OpenStreetMap";
  let active = bases[startName];

  const map = L.map("map");
  viewerMap = map;
  map.setView([50.5, 10.5], 6);
  active.addTo(map);
  L.control.layers(bases, null, { position: "topleft" }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  map.on("baselayerchange", (e: any) => {
    active = e.layer;
    applyOpacity(active, data.opts.baseOpacity);
  });
  applyOpacity(active, data.opts.baseOpacity);
  buildOpacityControl(map, () => active, data.opts.baseOpacity);

  viewerTracks = buildTracks(map, data, data.runs);
  const overlays = buildOverlays(map, data);
  let bounds = viewerTracks.reduce((b, t) => (b ? b.extend(t.bounds) : t.bounds), null as any);
  for (const o of overlays) {
    if (o.visible === false || !o.bounds?.isValid?.()) continue;
    bounds = bounds ? bounds.extend(o.bounds) : o.bounds;
  }
  if (bounds) map.fitBounds(bounds, { padding: [30, 30] });

  const urlProfile = readViewState().profile;
  const profileOn = urlProfile !== undefined ? urlProfile : !!data.opts.profile;
  const toggleProfile = buildProfile(map, data, profileOn);
  if (data.opts.tracklist && (viewerTracks.length || overlays.length)) {
    buildTracklist(map, viewerTracks, overlays, toggleProfile, profileOn);
  }
  if (data.opts.legendHtml.trim()) buildLegend(map, data.opts.legendHtml, data.meta.generated);

  writeViewState({ view: "2d", profile: profileOn });

  const syncSize = () => map.invalidateSize();
  requestAnimationFrame(() => {
    syncSize();
    requestAnimationFrame(syncSize);
  });

  return {
    invalidateSize: syncSize,
    morphRuns(runs: PayloadRun[]) {
      if (!viewerMap || !viewerPayload) return;
      // Mutate existing Track objects so tracklist closures keep working.
      const byKey = new Map(runs.map((r) => [trackKey(r), r]));
      for (const t of viewerTracks) {
        const run = byKey.get(trackKey(t.run));
        if (!run) continue;
        const visible = viewerMap.hasLayer(t.layer);
        viewerMap.removeLayer(t.layer);
        const next = buildOneTrack(viewerMap, viewerPayload, run, { addToMap: false });
        t.run = next.run;
        t.layer = next.layer;
        t.bounds = next.bounds;
        if (visible) t.layer.addTo(viewerMap);
      }
    },
    setProfileXsec(xsec: XsecData) {
      profileXsec = xsec;
      profileRedraw?.();
    },
  };
}

function buildOverlays(map: any, data: Payload): OverlayTrack[] {
  const out: OverlayTrack[] = [];
  for (const o of data.overlays || []) {
    if (!o.coords || o.coords.length < 2) continue;
    const latlngs = o.coords.map((c) => [c[0], c[1]]);
    const bounds = L.latLngBounds(latlngs);
    const group = L.layerGroup();
    const line = L.polyline(latlngs, {
      color: o.color || "#c45c26",
      weight: Math.max(2, (data.opts.lineWidth || 3) - 0.5),
      opacity: 0.9,
      dashArray: "6 4",
    }).bindTooltip(o.name, { sticky: true });
    if (o.note) {
      line.bindPopup(
        `<strong>${esc(o.name)}</strong><div style="margin-top:4px;white-space:pre-wrap">${esc(o.note)}</div>`,
      );
    }
    line.addTo(group);
    const visible = o.visible !== false;
    if (visible) group.addTo(map);
    out.push({
      name: o.name,
      color: o.color || "#c45c26",
      note: o.note || "",
      visible,
      layer: group,
      bounds,
    });
  }
  return out;
}

export { initViewer };
