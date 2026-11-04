"""Image Studio: a layered image editor backed by the PDF library.

A project is a folder  data/studio/<id>/  holding project.json plus one PNG per
raster layer. Text layers stay live (text, font, size, colour) so they remain
editable, and become real PDF text again when a page is placed back."""
import base64
import io
import json
import math
import os
import shutil
import time
import uuid
from pathlib import Path

import numpy as np
import pymupdf as fitz
from PIL import Image

from . import engine, store
from .psd_export import _clip, _render, _single

ROOT = store.DATA / "studio"
ROOT.mkdir(parents=True, exist_ok=True)
FAM_CSS = {"sans": "sans", "serif": "serif", "mono": "mono"}


# ---------------------------------------------------------------- utils

def _pid_dir(pid: str) -> Path:
    if not pid or "/" in pid or ".." in pid:
        raise KeyError(pid)
    d = ROOT / pid
    if not d.exists():
        raise KeyError(pid)
    return d


def _new_id():
    return uuid.uuid4().hex[:12]


def _lid():
    return "L" + uuid.uuid4().hex[:8]


def data_url_to_image(s: str) -> Image.Image:
    if s.startswith("data:"):
        s = s.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(s)))


def image_to_data_url(im: Image.Image) -> str:
    b = io.BytesIO()
    im.save(b, "PNG")
    return "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()


def _save_png(d: Path, lid: str, arr_or_img):
    im = arr_or_img if isinstance(arr_or_img, Image.Image) else Image.fromarray(arr_or_img)
    im.save(d / f"{lid}.png", "PNG", compress_level=3)


def _create(name, w, h, layers_with_pixels, source=None):
    """layers_with_pixels: list of (layer_meta, pixels|None)."""
    pid = _new_id()
    d = ROOT / pid
    d.mkdir(parents=True)
    layers = []
    for meta, px in layers_with_pixels:
        meta.setdefault("id", _lid())
        meta.setdefault("visible", True)
        meta.setdefault("opacity", 1.0)
        meta.setdefault("blend", "source-over")
        meta.setdefault("locked", False)
        if px is not None:
            _save_png(d, meta["id"], px)
        layers.append(meta)
    proj = {"id": pid, "name": name, "w": int(w), "h": int(h), "layers": layers, "source": source,
            "created": time.time(), "modified": time.time()}
    (d / "project.json").write_text(json.dumps(proj))
    return proj


# ---------------------------------------------------------------- open

def from_page(doc_id: str, pno: int, dpi: int = 150) -> dict:
    src = fitz.open(store.path(doc_id))
    page = src[pno]
    s = dpi / 72.0
    M = fitz.Matrix(s, s)
    rot = page.rotation_matrix * M
    A_ann = _render(page, M, annots=True)
    A = _render(page, M, annots=False)
    H, W, _ = A.shape

    dB = _single(src, pno)
    pB = dB[0]
    full = pB.rect * pB.derotation_matrix
    pB.add_redact_annot(full, fill=False)
    pB.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                        text=fitz.PDF_REDACT_TEXT_REMOVE)
    B = _render(pB, M)
    pB.add_redact_annot(full, fill=False)
    pB.apply_redactions(images=fitz.PDF_REDACT_IMAGE_REMOVE, graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                        text=fitz.PDF_REDACT_TEXT_NONE)
    C = _render(pB, M)

    out = [({"type": "raster", "name": "Background", "x": 0, "y": 0, "w": W, "h": H, "locked": False}, C)]
    for k, info in enumerate(i for i in page.get_image_info(xrefs=True) if not fitz.Rect(i["bbox"]).is_empty):
        x0, y0, x1, y1 = _clip(fitz.Rect(info["bbox"]) * rot, W, H)
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        crop = B[y0:y1, x0:x1]
        if np.abs(crop.astype(np.int16) - C[y0:y1, x0:x1].astype(np.int16)).max() < 4:
            continue
        out.append(({"type": "raster", "name": f"Image {k + 1}", "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}, crop))

    # live text: one layer per line, positioned on its baseline
    for ln in engine.page_lines(page):
        d = ln["dir"]
        if abs(d[1]) > 0.05 and page.rotation == 0:
            continue  # vertical text in an upright page: leave baked in the background? keep simple
        ox, oy = ln["origin"]
        bx0, by0, bx1, by1 = ln["bbox"]
        out.append(({
            "type": "text", "name": ln["text"][:48], "text": ln["text"],
            "x": ox * s, "y": oy * s, "size": ln["size"] * s, "color": ln["color"],
            "family": ln["family"], "bold": ln["bold"], "italic": ln["italic"],
            "fitWidth": (bx1 - bx0) * s, "sx": None,
        }, None))

    diff = np.abs(A_ann.astype(np.int16) - A.astype(np.int16)).max(axis=2)
    if diff.max() > 6:
        mask = (diff > 6).astype(np.uint8) * 255
        out.append(({"type": "raster", "name": "Annotations", "x": 0, "y": 0, "w": W, "h": H}, np.dstack([A_ann, mask])))
    out.append(({"type": "raster", "name": "Original page (reference)", "x": 0, "y": 0, "w": W, "h": H,
                 "visible": False, "locked": True}, A_ann))
    name = f"{store.meta(doc_id)['name']} — p{pno + 1}"
    return _create(name, W, H, out, {"doc_id": doc_id, "page": pno, "dpi": dpi,
                                     "pt_w": page.rect.width, "pt_h": page.rect.height})


def from_file(path: Path, name: str) -> dict:
    ext = path.suffix.lower()
    if ext in (".psd", ".psb"):
        from psd_tools import PSDImage
        psd = PSDImage.open(path)
        W, H = psd.width, psd.height
        out = []
        for layer in psd.descendants():
            if layer.is_group():
                continue
            try:
                im = layer.topil()
            except Exception:
                im = None
            if im is None or layer.width == 0 or layer.height == 0:
                continue
            im = im.convert("RGBA")
            out.append(({"type": "raster", "name": layer.name or "Layer", "x": layer.left, "y": layer.top,
                         "w": im.width, "h": im.height, "visible": bool(layer.visible),
                         "opacity": round(layer.opacity / 255, 3)}, im))
        if not out:
            out.append(({"type": "raster", "name": "Background", "x": 0, "y": 0, "w": W, "h": H}, psd.composite().convert("RGBA")))
        return _create(name, W, H, out)
    if ext == ".pdf":
        doc_id = store.create(name, path, "studio")
        return from_page(doc_id, 0)
    im = Image.open(path)
    im = im.convert("RGBA")
    return _create(name, im.width, im.height, [({"type": "raster", "name": "Background", "x": 0, "y": 0,
                                                 "w": im.width, "h": im.height}, im)])


def blank(name, w, h, bg="#ffffff"):
    w, h = max(1, min(int(w), 12000)), max(1, min(int(h), 12000))
    if bg == "transparent":
        im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    else:
        im = Image.new("RGBA", (w, h), bg)
    return _create(name, w, h, [({"type": "raster", "name": "Background", "x": 0, "y": 0, "w": w, "h": h}, im)])


# ---------------------------------------------------------------- persist

def get(pid):
    return json.loads((_pid_dir(pid) / "project.json").read_text())


def layer_path(pid, lid):
    if "/" in lid or ".." in lid:
        raise KeyError(lid)
    return _pid_dir(pid) / f"{lid}.png"


def save(pid, body: dict) -> dict:
    """body: {name, w, h, layers:[meta + optional data (dataURL) + optional raster (text render)], thumb}."""
    d = _pid_dir(pid)
    old = get(pid)
    keep = set()
    layers = []
    for L in body["layers"]:
        L = dict(L)
        lid = L.get("id") or _lid()
        L["id"] = lid
        data = L.pop("data", None)
        raster = L.pop("raster", None)
        if data:
            data_url_to_image(data).save(d / f"{lid}.png", "PNG", compress_level=3)
        if raster:  # rasterised text, used for PSD export / thumbnails
            data_url_to_image(raster).save(d / f"{lid}.text.png", "PNG", compress_level=3)
        keep.add(f"{lid}.png")
        keep.add(f"{lid}.text.png")
        layers.append(L)
    for f in d.glob("*.png"):
        if f.name not in keep and f.name != "thumb.png":
            f.unlink(missing_ok=True)
    if body.get("thumb"):
        data_url_to_image(body["thumb"]).convert("RGB").save(d / "thumb.png", "PNG")
    proj = old | {"name": body.get("name", old["name"]), "w": int(body.get("w", old["w"])),
                  "h": int(body.get("h", old["h"])), "layers": layers, "modified": time.time()}
    (d / "project.json").write_text(json.dumps(proj))
    return proj


def list_projects():
    out = []
    for d in ROOT.iterdir():
        try:
            p = json.loads((d / "project.json").read_text())
            out.append({"id": p["id"], "name": p["name"], "w": p["w"], "h": p["h"], "modified": p["modified"],
                        "layers": len(p["layers"]), "source": p.get("source")})
        except Exception:
            continue
    return sorted(out, key=lambda x: -x["modified"])


def delete(pid):
    shutil.rmtree(_pid_dir(pid))


def duplicate(pid):
    src = _pid_dir(pid)
    nid = _new_id()
    shutil.copytree(src, ROOT / nid)
    p = get(nid)
    p["id"], p["name"], p["modified"] = nid, p["name"] + " copy", time.time()
    (ROOT / nid / "project.json").write_text(json.dumps(p))
    return p


# ---------------------------------------------------------------- export

def _layer_image(pid, L):
    d = _pid_dir(pid)
    f = d / (f"{L['id']}.text.png" if L["type"] == "text" else f"{L['id']}.png")
    if not f.exists():
        return None
    return Image.open(f).convert("RGBA")


def to_psd(pid, out: Path):
    from psd_tools import PSDImage
    from psd_tools.constants import BlendMode
    blend = {"source-over": BlendMode.NORMAL, "multiply": BlendMode.MULTIPLY, "screen": BlendMode.SCREEN,
             "overlay": BlendMode.OVERLAY, "darken": BlendMode.DARKEN, "lighten": BlendMode.LIGHTEN,
             "color-dodge": BlendMode.COLOR_DODGE, "color-burn": BlendMode.COLOR_BURN,
             "hard-light": BlendMode.HARD_LIGHT, "soft-light": BlendMode.SOFT_LIGHT,
             "difference": BlendMode.DIFFERENCE, "exclusion": BlendMode.EXCLUSION, "hue": BlendMode.HUE,
             "saturation": BlendMode.SATURATION, "color": BlendMode.COLOR, "luminosity": BlendMode.LUMINOSITY}
    p = get(pid)
    psd = PSDImage.new("RGB", (p["w"], p["h"]), color=(255, 255, 255))
    for L in p["layers"]:
        im = _layer_image(pid, L)
        if im is None:
            continue
        x, y = int(round(L.get("rx", L["x"]))), int(round(L.get("ry", L["y"])))
        if L["type"] == "raster":
            x, y = int(round(L["x"])), int(round(L["y"]))
            sw, sh = int(round(L.get("w", im.width))), int(round(L.get("h", im.height)))
            if (sw, sh) != im.size and sw > 0 and sh > 0:
                im = im.resize((sw, sh), Image.LANCZOS)
        lay = psd.create_pixel_layer(im, name=L.get("name", "Layer")[:250], top=y, left=x,
                                     opacity=int(255 * float(L.get("opacity", 1))),
                                     blend_mode=blend.get(L.get("blend"), BlendMode.NORMAL))
        lay.visible = bool(L.get("visible", True))
    psd.save(str(out))
    return out


def place_into_pdf(pid, body: dict) -> dict:
    """Put an edited page back into a PDF. body: {raster (dataURL of all non-text visible layers),
    texts:[text layers], doc_id, page, mode: replace|insert|new}."""
    p = get(pid)
    src = p.get("source") or {}
    doc_id = body.get("doc_id") or src.get("doc_id")
    mode = body.get("mode", "replace" if doc_id else "new")
    img = data_url_to_image(body["raster"]).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=int(body.get("quality", 92)), subsampling=0)
    W, H = p["w"], p["h"]
    pt_w = src.get("pt_w") or W * 72 / 150
    pt_h = src.get("pt_h") or H * 72 / 150
    k = pt_w / W  # px -> pt

    def build(page):
        page.insert_image(page.rect, stream=buf.getvalue())
        for t in body.get("texts", []):
            if not t.get("visible", True) or not t.get("text", "").strip():
                continue
            fontname, *_ = engine.pick_font("", 0, t.get("family", "sans"), t.get("bold"), t.get("italic"))
            size = float(t["size"]) * k
            sx = float(t.get("sx") or 1)
            op = float(t.get("opacity", 1))
            col = engine.color(t.get("color"))
            for i, line in enumerate(t["text"].split("\n")):
                origin = fitz.Point(float(t["x"]) * k, (float(t["y"]) + i * float(t["size"]) * 1.2) * k)
                kw = {"morph": (origin, fitz.Matrix(sx, 1))} if abs(sx - 1) > 0.01 else {}
                page.insert_text(origin, line, fontsize=size, fontname=fontname, color=col,
                                 fill_opacity=op, **kw)

    if mode == "new":
        d = fitz.open()
        build(d.new_page(width=pt_w, height=pt_h))
        tmp = store.TMP / f"{pid}.pdf"
        d.save(tmp, garbage=3, deflate=True)
        nid = store.create(p["name"], tmp, "studio")
        tmp.unlink(missing_ok=True)
        return {"doc_id": nid, "page": 0}
    with store.lock(doc_id):
        d = fitz.open(store.path(doc_id))
        pno = int(body.get("page", src.get("page", 0)))
        if mode == "replace":
            newp = d.new_page(pno=pno, width=pt_w, height=pt_h)
            build(newp)
            d.delete_page(pno + 1)
        else:  # insert after
            pno = pno + 1
            build(d.new_page(pno=pno, width=pt_w, height=pt_h))
        store.commit_doc(doc_id, d, "Image Studio edit")
    return {"doc_id": doc_id, "page": pno}


# ---------------------------------------------------------------- AI background removal

_sessions = {}


def remove_background(data_url: str) -> str:
    from rembg import new_session, remove
    model = os.environ.get("REMBG_MODEL", "isnet-general-use")
    if model not in _sessions:
        try:
            _sessions[model] = new_session(model)
        except Exception:
            model = "u2netp"
            _sessions.setdefault(model, new_session(model))
    im = data_url_to_image(data_url).convert("RGBA")
    out = remove(im, session=_sessions[model], post_process_mask=True)
    return image_to_data_url(out)
