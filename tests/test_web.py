"""Tests for the dashboard frontend.

The source lives in ``frontend/`` (a React + shadcn/ui + Tailwind v4 app:
``app.tsx`` + ``components/**/*.tsx`` + ``styles.css`` + ``index.html``) and is
bundled by Bun into ``easytouch/static`` (``app.js`` + Tailwind-compiled
``style.css`` + copied ``index.html``), which the API serves at ``GET /`` and
``GET /static/<file>``. These tests assert the served shell links the built
assets and that the bundle/source wire the real, live-verified endpoints — no
browser required. They run against the committed build output in ``static/``;
run ``bun run build`` after editing ``frontend/`` to refresh it.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from easytouch.api import read_static

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"


def _all_src() -> str:
    # Concatenate every .ts/.tsx source file (app, hooks, lib, components).
    files = sorted(FRONTEND.rglob("*.ts")) + sorted(FRONTEND.rglob("*.tsx"))
    return "\n".join(p.read_text() for p in files)


def test_index_is_html_document():
    html, ctype = read_static("index.html")
    text = html.decode()
    assert text.lstrip().startswith("<!DOCTYPE html>")
    assert "<title>easytouch" in text
    assert ctype.startswith("text/html")


def test_index_links_built_assets():
    # the shell is just a mount point — it loads the bundled JS + CSS.
    text = read_static("index.html")[0].decode()
    assert 'href="/static/style.css"' in text
    assert 'src="/static/app.js"' in text
    assert 'id="root"' in text          # React mounts here


def test_built_bundle_is_javascript():
    js, ctype = read_static("app.js")
    assert ctype.startswith("text/javascript")
    assert len(js) > 0


def test_built_style_is_css():
    css, ctype = read_static("style.css")
    assert ctype.startswith("text/css")
    assert len(css) > 0


def test_static_read_rejects_traversal():
    with pytest.raises(FileNotFoundError):
        read_static("../api.py")


def test_bundle_references_endpoints():
    js = read_static("app.js")[0].decode()
    for path in ("/state", "/circuit/", "/heat", "/schedule", "/light", "/chlorinator"):
        assert path in js, path


def test_bundle_shows_salt_chlorinator():
    js = read_static("app.js")[0].decode().lower()
    assert "chlorinator" in js and "salt" in js


def test_source_wires_all_sections_and_controls():
    # every equipment-coverage feature is rendered/controlled in the React app.
    # Controls are matched by component name or aria-label, not button copy —
    # copy is free to change with a redesign; the accessible name is the
    # contract. ("Apply heat"/"Set output" buttons are gone by design: steppers
    # auto-send after SETTLE_MS; the clock syncs via its inline icon button.)
    src = _all_src()
    for marker in ("ValvesCard", "NamesCard", "IntelliChemCard", "LightsCard",
                   "CircuitsCard", "ChlorinatorCard", "SchedulesCard", "PumpsCard",
                   "Chlorinator output", "Sync controller clock to now",
                   "SETTLE_MS", "Save schedule"):
        assert marker in src, marker


def test_source_surfaces_command_verdict():
    # the validator: commands report the controller-confirmation verdict.
    src = _all_src()
    assert "confirmed" in src and "accepted" in src
