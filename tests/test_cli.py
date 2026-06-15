"""Tests for new CLI surface: the heat-mode resolver and serve/heat/set-heat args."""
from __future__ import annotations

import pytest

from easytouch.cli import build_parser, resolve_heat_mode


def test_resolve_heat_mode_names_and_ints():
    assert resolve_heat_mode("off") == 0
    assert resolve_heat_mode("heater") == 1
    assert resolve_heat_mode("solar pref") == 2
    assert resolve_heat_mode("solar-only") == 3
    assert resolve_heat_mode("solar_only") == 3
    assert resolve_heat_mode("2") == 2
    assert resolve_heat_mode(3) == 3


def test_resolve_heat_mode_rejects_garbage():
    with pytest.raises(ValueError):
        resolve_heat_mode("toasty")


def test_parser_serve_defaults():
    args = build_parser().parse_args(["serve"])
    assert args.command == "serve"
    assert args.http_host == "0.0.0.0"
    assert args.http_port == 8080


def test_parser_serve_overrides():
    args = build_parser().parse_args(
        ["--port", "socket://192.168.4.70:4000", "serve", "--http-port", "9000"])
    assert args.port == "socket://192.168.4.70:4000"
    assert args.http_port == 9000


def test_parser_heat():
    args = build_parser().parse_args(["heat"])
    assert args.command == "heat"


def test_parser_set_heat():
    args = build_parser().parse_args(
        ["set-heat", "--pool", "85", "--spa-mode", "heater"])
    assert args.command == "set-heat"
    assert args.pool == 85
    assert args.spa is None
    assert args.spa_mode == "heater"
