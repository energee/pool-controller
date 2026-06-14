"""Tests for frame encode/decode and the streaming reader.

The hex blobs here are real frames captured from the live bus on /tmp/vserial,
so these tests double as a regression guard against protocol drift.
"""
from __future__ import annotations

import pytest

from easytouch.protocol import ChecksumError, Packet, checksum, decode
from easytouch.reader import PacketReader

# A real controller-status (CFI 2) frame captured from the bus, including the
# 00 FF preamble and the trailing 2-byte checksum (03d0).
REAL_STATUS = bytes.fromhex(
    "00ffa5270f10021d0b0120000000000000200c000004535320005200000005000097a6030d03d0"
)


def test_checksum_matches_trailing_bytes():
    body = REAL_STATUS[2:-2]          # 0xA5 .. last data byte
    trailing = (REAL_STATUS[-2] << 8) | REAL_STATUS[-1]
    assert checksum(body) == trailing == 0x03D0


def test_decode_real_frame_header():
    pkt = decode(REAL_STATUS)
    assert pkt.sub == 0x27
    assert pkt.dst == 0x0F            # broadcast
    assert pkt.src == 0x10            # main controller
    assert pkt.cfi == 2              # controller status
    assert pkt.length == 0x1D == len(pkt.data)


def test_roundtrip_to_bytes():
    pkt = decode(REAL_STATUS)
    # Re-encode with the same 00FF start and 0 leading idles; body+checksum must match.
    reencoded = pkt.to_bytes(idle=0)
    assert reencoded == REAL_STATUS


def test_decode_rejects_bad_checksum():
    corrupt = bytearray(REAL_STATUS)
    corrupt[-1] ^= 0xFF
    with pytest.raises(ChecksumError):
        decode(bytes(corrupt))


def test_set_circuit_frame_checksum_is_valid():
    pkt = Packet(sub=0x01, dst=0x10, src=0x20, cfi=134, data=bytes([6, 1]))
    frame = pkt.to_bytes(idle=2)
    # Round-trips cleanly through the decoder => checksum is correct.
    again = decode(frame)
    assert again.cfi == 134
    assert again.data == bytes([6, 1])


def test_reader_extracts_packet_across_chunks():
    reader = PacketReader()
    # Split the frame mid-payload to exercise buffering/resync.
    split = 10
    assert reader.feed(REAL_STATUS[:split]) == []
    pkts = reader.feed(REAL_STATUS[split:])
    assert len(pkts) == 1
    assert pkts[0].cfi == 2
    assert pkts[0].src == 0x10


def test_reader_skips_leading_garbage_and_back_to_back_frames():
    reader = PacketReader()
    stream = bytes([0x12, 0x34, 0xFF, 0xFF]) + REAL_STATUS + REAL_STATUS
    pkts = reader.feed(stream)
    assert len(pkts) == 2
    assert all(p.cfi == 2 for p in pkts)


def test_reader_resyncs_after_corrupt_frame():
    reader = PacketReader()
    bad = bytearray(REAL_STATUS)
    bad[-1] ^= 0xFF                   # break the checksum of the first frame
    pkts = reader.feed(bytes(bad) + REAL_STATUS)
    # The corrupt frame is dropped; the following good frame is still found.
    assert len(pkts) == 1
    assert pkts[0].cfi == 2
