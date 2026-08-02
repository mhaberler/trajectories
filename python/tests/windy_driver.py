"""
Playwright driver for Windy trajectories (built-in / traj plugin).

Opens Windy, selects ICON-EU or ICON-D2, runs trajectories near a fixed point,
downloads GPX via the Save/export control when available.

Windy's UI changes often — this driver is best-effort. Failures surface as
pytest skip/fail with a clear message rather than silent pass.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

# Model keys in our package → Windy UI / URL fragments
WINDY_MODELS = {
    "icon_eu": {"url_model": "iconEu", "labels": ["ICON-EU", "ICON EU", "iconEu"]},
    "icon_d2": {"url_model": "iconD2", "labels": ["ICON-D2", "ICON D2", "iconD2"]},
}


@dataclass
class WindyRunSpec:
    lat: float
    lon: float
    model: str  # icon_eu | icon_d2
    duration_h: float = 2
    # Pressure levels commonly used by Windy traj (hPa labels)
    levels_hpa: tuple[int, ...] = (925, 850, 700)


def windy_map_url(spec: WindyRunSpec) -> str:
    m = WINDY_MODELS[spec.model]["url_model"]
    # Detail + wind overlay + model; traj plugin opened separately
    return (
        f"https://www.windy.com/{spec.lat}/{spec.lon}"
        f"?{m},{spec.lat},{spec.lon},8"
    )


def fetch_windy_gpx(spec: WindyRunSpec, download_dir: Path, *, headless: bool = True) -> Path:
    """
    Drive Windy in Chromium and return path to downloaded GPX.

    Strategy:
      1. Open map at lat/lon with the target model.
      2. Open trajectories via menu / plugin URL / keyboard if needed.
      3. Click Start, wait for tracks, click Save / download GPX.
      4. Return the newest .gpx in download_dir.
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise RuntimeError("playwright not installed; pip install -e 'python/[dev]'") from exc

    download_dir.mkdir(parents=True, exist_ok=True)
    before = {p.name for p in download_dir.glob("*.gpx")}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()
        page.goto(windy_map_url(spec), wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_timeout(4000)

        # Dismiss cookie / consent if present
        for sel in (
            "button:has-text('Accept')",
            "button:has-text('Agree')",
            "button:has-text('Akzeptieren')",
            "#plugin-rhc-consent button",
        ):
            try:
                btn = page.locator(sel).first
                if btn.is_visible(timeout=1500):
                    btn.click()
                    page.wait_for_timeout(500)
            except Exception:
                pass

        # Try opening traj via installed plugins path or search
        opened = _open_trajectories(page)
        if not opened:
            # Direct plugin deep-link (legacy + current gallery)
            page.goto(
                f"https://www.windy.com/plugins/windy-plugin-traj"
                f"?{WINDY_MODELS[spec.model]['url_model']},{spec.lat},{spec.lon},8",
                wait_until="domcontentloaded",
                timeout=90_000,
            )
            page.wait_for_timeout(5000)
            _open_trajectories(page)

        _select_model(page, spec.model)
        _configure_and_start(page, spec)

        gpx_path = _download_gpx(page, download_dir, before)
        browser.close()

    if gpx_path is None:
        raise RuntimeError(
            "Windy GPX download not found. UI may have changed; "
            "run with headless=False to inspect, or export GPX manually."
        )
    return gpx_path


def _open_trajectories(page) -> bool:
    candidates = [
        "text=Trajectories",
        "text=Trajectory",
        "text=Trajektorien",
        "[data-plugin='windy-plugin-traj']",
        "a[href*='traj']",
        "button:has-text('traj')",
    ]
    for sel in candidates:
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=2000):
                loc.click()
                page.wait_for_timeout(1500)
                return True
        except Exception:
            continue
    # Hamburger → Install / Plugins
    for menu in ("#mobile-ovr-select", ".menu-btn", "button.hamburger", "#hamburger"):
        try:
            m = page.locator(menu).first
            if m.is_visible(timeout=1000):
                m.click()
                page.wait_for_timeout(800)
                break
        except Exception:
            pass
    for sel in ("text=Install Windy plugin", "text=Plugins", "text=Trajectory"):
        try:
            loc = page.locator(sel).first
            if loc.is_visible(timeout=2000):
                loc.click()
                page.wait_for_timeout(1000)
                t = page.locator("text=Trajectory").first
                if t.is_visible(timeout=2000):
                    t.click()
                    page.wait_for_timeout(1500)
                    return True
        except Exception:
            continue
    return False


def _select_model(page, model: str) -> None:
    labels = WINDY_MODELS[model]["labels"]
    # Bottom-right model picker
    for lab in labels:
        try:
            loc = page.locator(f"text={lab}").first
            if loc.is_visible(timeout=2000):
                loc.click()
                page.wait_for_timeout(1000)
                return
        except Exception:
            continue
    # Open model menu then pick
    for sel in (".model-switcher", "#model-info", "div.progress-bar"):
        try:
            page.locator(sel).first.click(timeout=1500)
            page.wait_for_timeout(500)
        except Exception:
            pass
    for lab in labels:
        try:
            page.get_by_text(lab, exact=False).first.click(timeout=2000)
            page.wait_for_timeout(800)
            return
        except Exception:
            continue


def _configure_and_start(page, spec: WindyRunSpec) -> None:
    # Duration: look for an input or select near "hours" / "Dauer"
    for sel in (
        "input[name='hours']",
        "input[type='number']",
        "#traj-hours",
    ):
        try:
            inp = page.locator(sel).first
            if inp.is_visible(timeout=1000):
                inp.fill(str(int(spec.duration_h)))
                break
        except Exception:
            pass

    # Click map center to set start (already navigated to lat/lon)
    try:
        box = page.locator("#mapcontainer, #map, .map-container, #windy").first
        if box.is_visible(timeout=2000):
            box.click(position={"x": 400, "y": 300})
            page.wait_for_timeout(500)
    except Exception:
        pass

    for sel in (
        "button:has-text('Start')",
        "button:has-text('START')",
        "button:has-text('Run')",
        "#traj-start",
        "button.start",
    ):
        try:
            btn = page.locator(sel).first
            if btn.is_visible(timeout=2000):
                btn.click()
                page.wait_for_timeout(8000)
                return
        except Exception:
            continue
    raise RuntimeError("Could not find Windy trajectories Start button")


def _download_gpx(page, download_dir: Path, before: set[str]) -> Path | None:
    for sel in (
        "button:has-text('Save')",
        "button:has-text('Download')",
        "a:has-text('GPX')",
        "button:has-text('GPX')",
        "text=Save",
    ):
        try:
            loc = page.locator(sel).first
            if not loc.is_visible(timeout=2000):
                continue
            with page.expect_download(timeout=30_000) as di:
                loc.click()
            download = di.value
            dest = download_dir / (download.suggested_filename or "windy.gpx")
            download.save_as(str(dest))
            return dest
        except Exception:
            continue

    # Fallback: wait for a new file written by browser download path
    deadline = time.time() + 15
    while time.time() < deadline:
        for p in download_dir.glob("*.gpx"):
            if p.name not in before:
                return p
        time.sleep(0.5)
    return None


def model_heights_for_pressure_compare() -> list[float]:
    """
    Approximate AGL heights (m) that often sit near Windy's 925/850/700 hPa
    surfaces in mid-Europe — rough pairing for visual tests.
    """
    return [750, 1500, 3000]
