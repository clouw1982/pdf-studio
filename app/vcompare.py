"""Visual (pixel) comparison of two PDF pages."""
import io
from collections import deque

import numpy as np
import pymupdf as fitz
from PIL import Image

from . import store


def _render(doc_id, pno, scale, size=None):
    d = fitz.open(store.path(doc_id))
    if not 0 <= pno < len(d):
        return None, None
    page = d[pno]
    if size:  # render B at A's pixel size so pages of different sizes still line up
        sx = size[0] / page.rect.width
        sy = size[1] / page.rect.height
        pix = page.get_pixmap(matrix=fitz.Matrix(sx, sy), colorspace=fitz.csRGB)
    else:
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB)
    arr = np.frombuffer(pix.samples, np.uint8).reshape(pix.height, pix.width, 3)
    return arr, page.rect


def _boxes(mask, cell=8, pad=1):
    """Group changed pixels into rectangles via a coarse grid + flood fill."""
    H, W = mask.shape
    gh, gw = (H + cell - 1) // cell, (W + cell - 1) // cell
    pm = np.zeros((gh * cell, gw * cell), bool)
    pm[:H, :W] = mask
    grid = pm.reshape(gh, cell, gw, cell).any(axis=(1, 3))
    if pad:  # dilate so nearby edits merge
        g2 = grid.copy()
        for dy in range(-pad, pad + 1):
            for dx in range(-pad, pad + 1):
                g2 |= np.roll(np.roll(grid, dy, 0), dx, 1)
        grid = g2
    seen = np.zeros_like(grid)
    boxes = []
    for y in range(gh):
        for x in range(gw):
            if grid[y, x] and not seen[y, x]:
                q = deque([(y, x)])
                seen[y, x] = True
                y0 = y1 = y
                x0 = x1 = x
                n = 0
                while q:
                    cy, cx = q.popleft()
                    n += 1
                    y0, y1, x0, x1 = min(y0, cy), max(y1, cy), min(x0, cx), max(x1, cx)
                    for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                        if 0 <= ny < gh and 0 <= nx < gw and grid[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            q.append((ny, nx))
                boxes.append([x0 * cell, y0 * cell, min(W, (x1 + 1) * cell), min(H, (y1 + 1) * cell), n])
    boxes.sort(key=lambda b: (b[1], b[0]))
    return boxes


def compare_pages(a, pa, b, pb, scale=1.5, threshold=40):
    A, ra = _render(a, pa, scale)
    if A is None:
        raise ValueError("Page not in first document")
    B, rb = _render(b, pb, scale)
    if B is None:
        raise ValueError("Page not in second document")
    if B.shape != A.shape:
        B = np.asarray(Image.fromarray(B).resize((A.shape[1], A.shape[0]), Image.LANCZOS))
    ga = A.astype(np.int16).mean(axis=2)
    gb = B.astype(np.int16).mean(axis=2)
    diff = np.abs(A.astype(np.int16) - B.astype(np.int16)).max(axis=2) > threshold
    removed = diff & (ga < gb)   # darker in A -> ink removed
    added = diff & (gb <= ga)    # darker in B -> ink added
    # overlay: faded B as base, red = removed (from A), green = added (in B)
    base = (255 - (255 - B.astype(np.float32)) * 0.35).astype(np.uint8)
    out = base.copy()
    out[removed] = (220, 38, 38)
    out[added] = (22, 163, 74)
    boxes = _boxes(diff)
    H, W = diff.shape
    k = ra.width / W  # px -> pt of page A
    return {
        "png": _png(out),
        "w": ra.width, "h": ra.height,
        "changed_pct": round(float(diff.mean()) * 100, 3),
        "boxes": [{"rect": [b[0] * k, b[1] * k, b[2] * k, b[3] * k],
                   "kind": "removed" if removed[b[1]:b[3], b[0]:b[2]].sum() > added[b[1]:b[3], b[0]:b[2]].sum() * 2
                   else "added" if added[b[1]:b[3], b[0]:b[2]].sum() > removed[b[1]:b[3], b[0]:b[2]].sum() * 2 else "changed"}
                  for b in boxes if b[4] >= 1][:300],
    }


def _png(arr):
    b = io.BytesIO()
    Image.fromarray(arr).save(b, "PNG", optimize=False, compress_level=3)
    return b.getvalue()


def summary(a, b, scale=0.5):
    """Quick per-page change ratio for the page list."""
    da, db = fitz.open(store.path(a)), fitz.open(store.path(b))
    out = []
    for i in range(max(len(da), len(db))):
        if i >= len(da) or i >= len(db):
            out.append({"page": i, "pct": None, "missing": "a" if i >= len(da) else "b"})
            continue
        pa = da[i].get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY)
        A = np.frombuffer(pa.samples, np.uint8).reshape(pa.height, pa.width)
        pb = db[i].get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csGRAY)
        B = np.frombuffer(pb.samples, np.uint8).reshape(pb.height, pb.width)
        if B.shape != A.shape:
            B = np.asarray(Image.fromarray(B).resize((A.shape[1], A.shape[0])))
        out.append({"page": i, "pct": round(float((np.abs(A.astype(np.int16) - B) > 40).mean()) * 100, 3)})
    return out
