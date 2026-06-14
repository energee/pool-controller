#!/usr/bin/env python3
"""
examples/monitor.py — minimal live monitor using the easytouch library.

Prints a one-line summary every time the controller broadcasts its status.

Usage:
    python examples/monitor.py [PORT]
    # PORT defaults to /tmp/vserial
"""
from __future__ import annotations

import sys

from easytouch import EasyTouch, constants
from easytouch.decode import decode

PORT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/vserial"


def main() -> None:
    print(f"Listening on {PORT} ... (Ctrl-C to quit)")
    with EasyTouch(PORT) as et:
        for pkt in et.packets():
            obj = decode(pkt)
            if pkt.cfi == constants.Action.CONTROLLER_STATUS:
                circuits = ", ".join(obj.circuit_names) or "all off"
                print(
                    f"{obj.clock}  pool={obj.pool_temp}°{obj.unit} "
                    f"spa={obj.spa_temp}°{obj.unit} air={obj.air_temp}°{obj.unit}  "
                    f"on=[{circuits}]  heater={'on' if obj.heater_on else 'off'}"
                )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print()
