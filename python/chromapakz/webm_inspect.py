"""Pure-Python EBML/WebM inspector — per-track byte/frame breakdown, no native deps.

Just enough Matroska parsing to report where the bytes go (RGB vs depth-hi vs depth-lo),
so ingestion can print real bits-per-pixel without round-tripping through the codec.
"""

_EBML_HEADER, _SEGMENT = 0x1A45DFA3, 0x18538067
_SEEKHEAD, _INFO, _TRACKS = 0x114D9B74, 0x1549A966, 0x1654AE6B
_CUES, _TAGS, _CHAPTERS, _ATTACHMENTS = 0x1C53BB6B, 0x1254C367, 0x1043A770, 0x1941A469
_TRACKENTRY = 0xAE
_TRACKNUMBER, _NAME = 0xD7, 0x536E
_CLUSTER, _SIMPLEBLOCK, _BLOCKGROUP, _BLOCK = 0x1F43B675, 0xA3, 0xA0, 0xA1

# An unknown-size master ends where an element that cannot be its child begins.
_LEVEL0 = frozenset((_EBML_HEADER, _SEGMENT))
_LEVEL1 = _LEVEL0 | {_SEEKHEAD, _INFO, _TRACKS, _CUES, _TAGS, _CHAPTERS, _ATTACHMENTS, _CLUSTER}


class EbmlError(ValueError):
    """Raised when the buffer cannot be parsed as EBML."""


def _vlen(b, p, maxL, what):
    """Length and marker mask of the VINT at b[p]; raises rather than returning nonsense."""
    if p >= len(b):
        raise EbmlError(f"not valid EBML: truncated {what} at {p}")
    first, mask, L = b[p], 0x80, 1
    while L <= maxL and not (first & mask):
        mask >>= 1
        L += 1
    if L > maxL:
        raise EbmlError(f"not valid EBML: bad {what} marker {first:#04x} at {p}")
    if p + L > len(b):
        raise EbmlError(f"not valid EBML: truncated {what} at {p}")
    return L, mask


def _read_id(b, p):
    L, _ = _vlen(b, p, 4, "element id")
    return int.from_bytes(b[p:p + L], "big"), L


def _read_size(b, p):
    """(value, length, unknown) — an all-ones VINT_DATA marks an unknown (streamed) size."""
    L, mask = _vlen(b, p, 8, "element size")
    v = b[p] & (mask - 1)
    for k in range(1, L):
        v = (v << 8) | b[p + k]
    return v, L, v == (1 << (7 * L)) - 1


def _stop_ids(eid):
    """IDs that terminate an unknown-size element of type `eid`."""
    return _LEVEL1 if eid == _CLUSTER else _LEVEL0


def _unknown_end(b, start, end, stop):
    """Walk children of an unknown-size master until a non-child ID (or the parent end)."""
    p = start
    while p < end:
        eid, la = _read_id(b, p)
        if eid in stop:
            return p
        size, lb, unknown = _read_size(b, p + la)
        ds = p + la + lb
        p = _unknown_end(b, ds, end, _stop_ids(eid)) if unknown else min(ds + size, end)
    return end


def _children(b, start, end):
    p = start
    while p < end:
        eid, la = _read_id(b, p)
        size, lb, unknown = _read_size(b, p + la)
        ds = p + la + lb
        # A declared size overrunning the parent means truncated input; clamp instead of walking off.
        de = _unknown_end(b, ds, end, _stop_ids(eid)) if unknown else min(ds + size, end)
        yield eid, ds, de
        p = de


def _block(b, s, e):
    """(track, payload bytes, frame count) for a SimpleBlock/Block body."""
    track, lt, _ = _read_size(b, s)
    p = s + lt + 3                       # track vint + int16 timecode + flags
    if p > e:
        raise EbmlError(f"not valid EBML: truncated block header at {s}")
    lacing = (b[p - 1] >> 1) & 0x03
    frames = 1
    if lacing:
        if p >= e:
            raise EbmlError(f"not valid EBML: truncated lacing header at {p}")
        frames, p = b[p] + 1, p + 1
        if lacing == 1:                  # Xiph: frames-1 sizes as 0xFF-continued byte runs
            for _ in range(frames - 1):
                while p < e and b[p] == 0xFF:
                    p += 1
                p += 1
        elif lacing == 3:                # EBML: first size a vint, the rest signed deltas
            for _ in range(frames - 1):
                p += _vlen(b, p, 8, "lace size")[0]
        # lacing == 2 (fixed-size): per-frame sizes are implicit, no header to skip
        if p > e:
            raise EbmlError(f"not valid EBML: truncated lacing header at {s}")
    return track, e - p, frames


def track_sizes(data):
    """Return {track_number: {'name': str, 'bytes': int, 'frames': int}}."""
    b = memoryview(data)
    names, sizes, counts = {}, {}, {}

    def tally(s, e):
        track, payload, frames = _block(b, s, e)
        sizes[track] = sizes.get(track, 0) + payload
        counts[track] = counts.get(track, 0) + frames

    for eid, ds, de in _children(b, 0, len(b)):
        if eid != _SEGMENT:
            continue
        for cid, cs, ce in _children(b, ds, de):
            if cid == _TRACKS:
                for tid, ts, te in _children(b, cs, ce):
                    if tid != _TRACKENTRY:
                        continue
                    num, name = None, ""
                    for fid, fs, fe in _children(b, ts, te):
                        if fid == _TRACKNUMBER:
                            num = int.from_bytes(b[fs:fe], "big")
                        elif fid == _NAME:
                            name = bytes(b[fs:fe]).decode()
                    if num is not None:
                        names[num] = name
            elif cid == _CLUSTER:
                for bid, bs, be in _children(b, cs, ce):
                    if bid == _SIMPLEBLOCK:
                        tally(bs, be)
                    elif bid == _BLOCKGROUP:       # ffmpeg-remuxed WebM wraps Blocks in these
                        for gid, gs, ge in _children(b, bs, be):
                            if gid == _BLOCK:
                                tally(gs, ge)
    return {n: {"name": names.get(n, ""), "bytes": sizes[n], "frames": counts.get(n, 0)}
            for n in sorted(sizes)}
