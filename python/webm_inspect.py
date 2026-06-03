"""Pure-Python EBML/WebM inspector — per-track byte/frame breakdown, no native deps.

Just enough Matroska parsing to report where the bytes go (RGB vs depth-hi vs depth-lo),
so ingestion can print real bits-per-pixel without round-tripping through the codec.
"""

_SEGMENT, _TRACKS, _TRACKENTRY = 0x18538067, 0x1654AE6B, 0xAE
_TRACKNUMBER, _NAME = 0xD7, 0x536E
_CLUSTER, _SIMPLEBLOCK = 0x1F43B675, 0xA3


def _vlen(first, maxL):
    mask, L = 0x80, 1
    while L <= maxL and not (first & mask):
        mask >>= 1
        L += 1
    return L, mask


def _read_id(b, p):
    L, _ = _vlen(b[p], 4)
    return int.from_bytes(b[p:p + L], "big"), L


def _read_size(b, p):
    L, mask = _vlen(b[p], 8)
    v = b[p] & (mask - 1)
    for k in range(1, L):
        v = (v << 8) | b[p + k]
    return v, L


def _children(b, start, end):
    p = start
    while p < end:
        eid, la = _read_id(b, p)
        size, lb = _read_size(b, p + la)
        ds = p + la + lb
        yield eid, ds, ds + size
        p = ds + size


def track_sizes(data):
    """Return {track_number: {'name': str, 'bytes': int, 'frames': int}}."""
    b = memoryview(data)
    names, sizes, counts = {}, {}, {}
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
                    if bid != _SIMPLEBLOCK:
                        continue
                    _, lt = _read_size(b, bs)        # track number (vint)
                    track = b[bs] & 0x7F
                    payload = (be - bs) - (lt + 3)   # minus track-vint + int16 tc + flags
                    sizes[track] = sizes.get(track, 0) + payload
                    counts[track] = counts.get(track, 0) + 1
    return {n: {"name": names.get(n, ""), "bytes": sizes[n], "frames": counts.get(n, 0)}
            for n in sorted(sizes)}
