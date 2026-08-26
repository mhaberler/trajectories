import { GROUPS, colorStops, buildScale } from "@colormap";

/**
 * Vanilla colormap dropdown (port of colormap/src/components/ColormapSelector.vue).
 * @param {HTMLElement} host
 * @param {{ name: string, domain: [number, number], onChange: (name: string) => void }} opts
 */
export function mountColormapSelect(host, opts) {
  const gradients = {};
  for (const names of Object.values(GROUPS)) {
    for (const name of names) {
      const stops = colorStops(name, 16);
      gradients[name] = `linear-gradient(to right, ${stops.join(",")})`;
    }
  }

  let name = opts.name || "viridis";
  let domain = opts.domain || [0, 1];
  let open = false;

  const root = document.createElement("div");
  root.className = "colormap-select";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "trigger";

  const swatch = document.createElement("span");
  swatch.className = "swatch";
  const label = document.createElement("span");
  label.className = "cmap-label";
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▾";
  trigger.append(swatch, label, caret);

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.hidden = true;

  for (const [group, names] of Object.entries(GROUPS)) {
    const g = document.createElement("div");
    g.className = "group";
    const gl = document.createElement("div");
    gl.className = "group-label";
    gl.textContent = group;
    g.appendChild(gl);
    for (const n of names) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option";
      btn.dataset.name = n;
      const s = document.createElement("span");
      s.className = "swatch";
      s.style.background = gradients[n];
      const l = document.createElement("span");
      l.className = "cmap-label";
      l.textContent = n;
      btn.append(s, l);
      btn.addEventListener("click", () => {
        name = n;
        open = false;
        sync();
        opts.onChange(name);
      });
      g.appendChild(btn);
    }
    menu.appendChild(g);
  }

  root.append(trigger, menu);
  host.replaceChildren(root);

  function sync() {
    swatch.style.background = gradients[name] || "#ccc";
    label.textContent = name;
    menu.hidden = !open;
    for (const btn of menu.querySelectorAll(".option")) {
      btn.classList.toggle("active", btn.dataset.name === name);
    }
  }

  trigger.addEventListener("click", () => {
    open = !open;
    sync();
  });

  function onDocClick(e) {
    if (!root.contains(e.target)) {
      open = false;
      sync();
    }
  }
  document.addEventListener("click", onDocClick);

  sync();

  return {
    getName: () => name,
    setName(n) {
      name = n;
      sync();
    },
    setDomain(d) {
      domain = d;
    },
    scale() {
      return buildScale(name, domain);
    },
    gradientCss() {
      return gradients[name] || "";
    },
    destroy() {
      document.removeEventListener("click", onDocClick);
    },
  };
}

export { colorStops, buildScale };
