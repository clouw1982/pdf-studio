"""Turn PDF pages into layered Photoshop files.

Layer stack (bottom -> top):
  Background          vector art, fills and page colour (text + images removed)
  Images/             one layer per placed image, positioned where it sits on the page
  Text/               one transparent layer per text block, named after its content
  Annotations         highlights, ink, stamps, comments (if any)
  Original (ref)      hidden flattened copy of the page, for comparison
"""
import io
import zipfile
from pathlib import Path

import numpy as np
import pymupdf as fitz
from PIL import Image
from psd_tools import PSDImage


def _render(page, M, annots=False):
    pix = page.get_pixmap(matrix=M, annots=annots, alpha=False, colorspace=fitz.csRGB)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3).copy()


def _single(src, pno):
    d = fitz.open()
    d.insert_pdf(src, from_page=pno, to_page=pno)
    return d


def _clip(box, W, H, pad=0):
    x0, y0, x1, y1 = box
    return (max(0, int(x0) - pad), max(0, int(y0) - pad), min(W, int(np.ceil(x1)) + pad), min(H, int(np.ceil(y1)) + pad))


def _hex2rgb(v):
    return np.array([(v >> 16) & 255, (v >> 8) & 255, v & 255], dtype=np.float32)


def page_to_psd(src: fitz.Document, pno: int, out: Path, dpi: int = 150) -> dict:
    page = src[pno]
    s = dpi / 72.0
    M = fitz.Matrix(s, s)
    rot = page.rotation_matrix * M  # unrotated PDF coords -> display pixels

    A_ann = _render(page, M, annots=True)
    A = _render(page, M, annots=False)
    H, W, _ = A.shape

    # B: page without text
    dB = _single(src, pno)
    pB = dB[0]
    full = pB.rect * pB.derotation_matrix
    pB.add_redact_annot(full, fill=False)
    pB.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                        text=fitz.PDF_REDACT_TEXT_REMOVE)
    B = _render(pB, M)
    # C: page without text and images
    pB.add_redact_annot(full, fill=False)
    pB.apply_redactions(images=fitz.PDF_REDACT_IMAGE_REMOVE, graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                        text=fitz.PDF_REDACT_TEXT_NONE)
    C = _render(pB, M)

    psd = PSDImage.new("RGB", (W, H), color=(255, 255, 255))
    psd.create_pixel_layer(Image.fromarray(C), name="Background")
    n_img = n_txt = 0

    # ---- images
    infos = [i for i in page.get_image_info(xrefs=True) if not fitz.Rect(i["bbox"]).is_empty]
    if infos:
        g = psd.create_group(name="Images")
        for k, info in enumerate(infos):
            box = fitz.Rect(info["bbox"]) * rot
            x0, y0, x1, y1 = _clip(box, W, H)
            if x1 - x0 < 2 or y1 - y0 < 2:
                continue
            crop = B[y0:y1, x0:x1]
            diff = np.abs(crop.astype(np.int16) - C[y0:y1, x0:x1].astype(np.int16)).max(axis=2)
            if diff.max() < 4:
                continue  # fully hidden / white image
            rgba = np.dstack([crop, np.full(diff.shape, 255, np.uint8)])
            g.create_pixel_layer(Image.fromarray(rgba, "RGBA"),
                                 name=f"Image {k + 1} ({info.get('width')}x{info.get('height')})", top=y0, left=x0)
            n_img += 1

    # ---- text: un-blend each block against the text-free render using the known text colour
    blocks = [b for b in page.get_text("dict")["blocks"] if b.get("type") == 0]
    if blocks:
        g = psd.create_group(name="Text")
        Af, Bf = A.astype(np.float32), B.astype(np.float32)
        for b in blocks:
            text = " ".join("".join(sp["text"] for sp in l["spans"]) for l in b["lines"]).strip()
            if not text:
                continue
            x0, y0, x1, y1 = _clip(fitz.Rect(b["bbox"]) * rot, W, H, pad=2)
            if x1 <= x0 or y1 <= y0:
                continue
            a_c, b_c = Af[y0:y1, x0:x1], Bf[y0:y1, x0:x1]
            # colour map: dominant span colour per line
            spans = [sp for l in b["lines"] for sp in l["spans"] if sp["text"].strip()]
            main = max(spans, key=lambda sp: len(sp["text"])) if spans else None
            T = np.empty_like(a_c)
            T[:] = _hex2rgb(main["color"]) if main else 0
            for sp in spans:
                sx0, sy0, sx1, sy1 = _clip(fitz.Rect(sp["bbox"]) * rot, W, H, pad=1)
                T[max(0, sy0 - y0):max(0, sy1 - y0), max(0, sx0 - x0):max(0, sx1 - x0)] = _hex2rgb(sp["color"])
            denom = T - b_c
            num = a_c - b_c
            ch = np.argmax(np.abs(denom), axis=2)[..., None]
            d_sel = np.take_along_axis(denom, ch, 2)[..., 0]
            n_sel = np.take_along_axis(num, ch, 2)[..., 0]
            with np.errstate(divide="ignore", invalid="ignore"):
                alpha = np.where(np.abs(d_sel) > 25, n_sel / d_sel, 0)
            # fallback when text colour ~ background: use raw difference
            raw = np.abs(num).max(axis=2) / 255.0
            alpha = np.where(np.abs(d_sel) > 25, alpha, raw * 3)
            alpha = (np.clip(alpha, 0, 1) * 255).astype(np.uint8)
            if alpha.max() < 10:
                continue
            rgb = np.clip(T, 0, 255).astype(np.uint8)
            # where colour guess is poor (fallback pixels), use the actual rendered pixel
            weak = (np.abs(d_sel) <= 25)
            rgb[weak] = A[y0:y1, x0:x1][weak]
            name = text[:60].replace("\n", " ") or "Text"
            g.create_pixel_layer(Image.fromarray(np.dstack([rgb, alpha]), "RGBA"), name=name, top=y0, left=x0)
            n_txt += 1

    # ---- annotations
    diff = np.abs(A_ann.astype(np.int16) - A.astype(np.int16)).max(axis=2)
    if diff.max() > 6:
        mask = (diff > 6).astype(np.uint8) * 255
        psd.create_pixel_layer(Image.fromarray(np.dstack([A_ann, mask]), "RGBA"), name="Annotations")

    ref = psd.create_pixel_layer(Image.fromarray(A_ann), name="Original page (reference)")
    ref.visible = False
    psd.save(str(out))
    return {"file": out.name, "images": n_img, "text": n_txt, "w": W, "h": H}


def pdf_to_psds(pdf_path: Path, out_dir: Path, dpi: int = 150, stem: str | None = None) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    src = fitz.open(pdf_path)
    stem = stem or Path(pdf_path).stem
    files = []
    for pno in range(len(src)):
        out = out_dir / (f"{stem}.psd" if len(src) == 1 else f"{stem}_p{pno + 1:03d}.psd")
        page_to_psd(src, pno, out, dpi)
        files.append(out)
    return files


def psd_zip(pdf_path: Path, tmp_dir: Path, dpi: int, stem: str) -> Path:
    files = pdf_to_psds(pdf_path, tmp_dir, dpi, stem)
    if len(files) == 1:
        return files[0]
    z = tmp_dir / f"{stem}_psd.zip"
    with zipfile.ZipFile(z, "w", zipfile.ZIP_STORED) as zf:
        for f in files:
            zf.write(f, f.name)
    return z
