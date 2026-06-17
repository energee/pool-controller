"""Tests for the self-contained dashboard page (``easytouch.web.PAGE``).

The dashboard is a single static HTML document — inline CSS + JS, no external
assets — served at ``GET /`` by the API. These tests assert it is a well-formed,
fully self-contained document wired to the real, live-verified endpoints it must
consume, without needing a browser to run.
"""
from __future__ import annotations

from easytouch.web import PAGE


def test_page_is_html_document():
    assert PAGE.lstrip().startswith("<!DOCTYPE html>")
    assert "<title>easytouch" in PAGE


def test_page_is_self_contained_no_external_assets():
    # stdlib-only / offline: styles and scripts are inline, nothing loaded off-box.
    assert "<style>" in PAGE and "<script>" in PAGE
    assert "<script src" not in PAGE      # no external scripts
    assert "<link" not in PAGE            # no external stylesheets
    assert "https://" not in PAGE         # no CDN references


def test_page_references_state_endpoint():
    # the page is a pure client of GET /state (the full snapshot it renders).
    assert "/state" in PAGE


def test_page_references_circuit_endpoint():
    assert "/circuit/" in PAGE


def test_page_references_heat_endpoint():
    assert "/heat" in PAGE


def test_page_references_schedule_endpoint():
    assert "/schedule" in PAGE


def test_page_shows_salt_chlorinator():
    # the salt card reads the chlorinator section of /state and labels it.
    low = PAGE.lower()
    assert "chlorinator" in low
    assert "salt" in low


def test_page_exposes_all_decoded_sections_and_controls():
    # every equipment-coverage feature is wired into the dashboard (read-outs are
    # rendered via renderCards, controls call the write endpoints) -- not just the API.
    for marker in ("valvesCard(s.valves)", "namesCard(s.names)", "intellichemCard",
                   "lightsCard", "setChlor", "setClock", "setLight", "setPump"):
        assert marker in PAGE, marker
