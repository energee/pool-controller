"""Tests for the IntelliChlor (salt chlorinator) native-protocol framer/decoder.

Salt level does **not** ride the A5 protocol: the chlorinator uses its own
DLE-framed messages — ``10 02 <dest> <cmd> <data...> <chk> 10 03`` — which the A5
:class:`~easytouch.reader.PacketReader` drops as garbage. The frames below were
captured live from the controller at ``socket://192.168.4.70:4000``; the checksum
rule (sum of ``0x10`` through the last data byte, mod 256) was confirmed against
the real Set-Output frame.
"""
from __future__ import annotations

from easytouch.intellichlor import (
    ChlorinatorReader,
    ChlorinatorSetOutput,
    ChlorinatorStatus,
    decode_ic,
    ic_checksum,
)

# Real, checksum-valid Set-Output frame captured from the bus: chlorinator (0x50),
# cmd 0x11, output 0x1e = 30%, checksum 0x91.
SET_OUTPUT = bytes.fromhex("100250111e911003")
# Salt status: real device bytes (salt 0x37 = 55 -> 2750 ppm, status 0x80) captured
# from the bus; checksum 0xdb is computed by the rule the Set-Output frame confirms.
SALT_STATUS = bytes.fromhex("100200123780db1003")


def test_ic_checksum_matches_real_frame():
    # 10 02 50 11 1e  ->  0x91, the byte the controller actually put on the wire.
    assert ic_checksum(bytes.fromhex("100250111e")) == 0x91


def test_reader_decodes_salt_status():
    frames = ChlorinatorReader().feed(SALT_STATUS)
    assert len(frames) == 1
    obj = decode_ic(frames[0])
    assert isinstance(obj, ChlorinatorStatus)
    assert obj.salt_ppm == 2750
    assert obj.status_flags == 0x80


def test_reader_decodes_set_output():
    obj = decode_ic(ChlorinatorReader().feed(SET_OUTPUT)[0])
    assert isinstance(obj, ChlorinatorSetOutput)
    assert obj.output_percent == 30


def test_reader_resyncs_past_garbage_and_idle():
    frames = ChlorinatorReader().feed(b"\xff\xff\xff" + SALT_STATUS + b"\xff\xff")
    assert [decode_ic(f).salt_ppm for f in frames] == [2750]


def test_reader_rejects_bad_checksum():
    bad = bytearray(SALT_STATUS)
    bad[-3] ^= 0xFF                       # corrupt the checksum byte
    assert ChlorinatorReader().feed(bytes(bad)) == []


def test_reader_ignores_non_ic_addresses_and_commands():
    # A5 traffic embeds the bytes 10 02 (src 0x10 MAIN + cfi 0x02), and such a run
    # can even carry a checksum that validates. Without an address/command check the
    # framer would emit a bogus ICFrame; dest 0x1d is not a real IC address, so it
    # must be rejected outright (sum 0x10+0x02+0x1d+0x11 = 0x40 = the chk byte).
    bogus = bytes.fromhex("10021d11401003")
    assert ChlorinatorReader().feed(bogus) == []


def test_reader_skips_a5_lookalike_but_keeps_following_salt_frame():
    from easytouch.protocol import Packet
    a5 = Packet(sub=0x27, dst=0x0F, src=0x10, cfi=0x02,
                data=bytes.fromhex("14370000000000000000008fa0030d03d6")).to_bytes(idle=2)
    assert b"\x10\x02" in a5                      # the A5 frame contains the IC start bytes
    frames = ChlorinatorReader().feed(a5 + SALT_STATUS)
    assert all(f.dest in (0x00, 0x50) and f.cmd in (0x11, 0x12) for f in frames)
    assert [decode_ic(f).salt_ppm for f in frames] == [2750]


def test_reader_reassembles_split_frame():
    r = ChlorinatorReader()
    assert r.feed(SALT_STATUS[:4]) == []          # first half: no complete frame yet
    frames = r.feed(SALT_STATUS[4:])              # remainder arrives
    assert len(frames) == 1 and decode_ic(frames[0]).salt_ppm == 2750


def test_build_set_output_matches_real_frame():
    from easytouch.intellichlor import build_set_output
    assert build_set_output(30) == SET_OUTPUT     # byte-for-byte the captured frame


def test_build_set_output_clamps_and_round_trips():
    from easytouch.intellichlor import build_set_output
    assert decode_ic(ChlorinatorReader().feed(build_set_output(45))[0]).output_percent == 45
    assert decode_ic(ChlorinatorReader().feed(build_set_output(150))[0]).output_percent == 100
    assert decode_ic(ChlorinatorReader().feed(build_set_output(-5))[0]).output_percent == 0
