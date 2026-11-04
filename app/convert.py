"""Import any document to PDF, export PDF to other formats, OCR, compression, compare."""
import difflib
import io
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

import pymupdf as fitz
from PIL import Image

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".gif", ".webp", ".jp2", ".pnm", ".heic"}
NATIVE_EXT = {".xps", ".oxps", ".epub", ".mobi", ".fb2", ".cbz", ".svg"}
OFFICE_EXT = {".doc", ".docx", ".odt", ".rtf", ".txt", ".md", ".html", ".htm", ".xls", ".xlsx", ".ods",
              ".csv", ".ppt", ".pptx", ".odp", ".pages", ".key", ".numbers", ".wpd", ".vsd", ".pub"}
SUPPORTED = {".pdf", ".psd", ".psb"} | IMAGE_EXT | NATIVE_EXT | OFFICE_EXT


def to_pdf(src: Path, workdir: Path) -> Path:
    """Convert any supported input file into a PDF in workdir. Returns the PDF path."""
    ext = src.suffix.lower()
    out = workdir / (src.stem + ".pdf")
    if ext == ".pdf":
        if src != out:
            shutil.copyfile(src, out)
        return out
    if ext in (".psd", ".psb"):
        from psd_tools import PSDImage
        im = PSDImage.open(src).composite()
        return _images_to_pdf([im], out)
    if ext in IMAGE_EXT:
        im = Image.open(src)
        frames = []
        try:
            i = 0
            while True:
                im.seek(i)
                frames.append(im.copy())
                i += 1
        except EOFError:
            pass
        return _images_to_pdf(frames or [im], out)
    if ext in NATIVE_EXT:
        d = fitz.open(src)
        pdf = fitz.open("pdf", d.convert_to_pdf())
        pdf.save(out)
        return out
    if ext in OFFICE_EXT:
        r = subprocess.run(["soffice", "--headless", "--norestore", "--convert-to", "pdf", "--outdir", str(workdir), str(src)],
                           capture_output=True, text=True, timeout=300,
                           env={"HOME": str(workdir), "PATH": "/usr/local/bin:/usr/bin:/bin"})
        if not out.exists():
            raise RuntimeError(f"LibreOffice conversion failed: {r.stderr[-400:]}")
        return out
    raise ValueError(f"Unsupported file type: {ext}")


def _images_to_pdf(images, out: Path) -> Path:
    doc = fitz.open()
    for im in images:
        if im.mode not in ("RGB", "L"):
            bg = Image.new("RGB", im.size, "white")
            im = im.convert("RGBA")
            bg.paste(im, mask=im.split()[-1])
            im = bg
        buf = io.BytesIO()
        im.save(buf, "PNG")
        dpi = im.info.get("dpi", (150, 150))[0] or 150
        w, h = im.size[0] * 72 / dpi, im.size[1] * 72 / dpi
        page = doc.new_page(width=w, height=h)
        page.insert_image(page.rect, stream=buf.getvalue())
    doc.save(out, garbage=3, deflate=True)
    return out


# ---------------------------------------------------------------- exports

def export(pdf: Path, fmt: str, workdir: Path, stem: str, opts: dict) -> Path:
    fmt = fmt.lower()
    dpi = int(opts.get("dpi", 150))
    if fmt == "docx":
        from pdf2docx import Converter
        out = workdir / f"{stem}.docx"
        cv = Converter(str(pdf))
        cv.convert(str(out))
        cv.close()
        return out
    if fmt == "xlsx":
        return _to_xlsx(pdf, workdir / f"{stem}.xlsx")
    if fmt == "pptx":
        return _to_pptx(pdf, workdir / f"{stem}.pptx", dpi)
    if fmt in ("png", "jpg", "tiff"):
        doc = fitz.open(pdf)
        files = []
        for i, page in enumerate(doc):
            pix = page.get_pixmap(dpi=dpi)
            f = workdir / f"{stem}_p{i + 1:03d}.{fmt}"
            if fmt == "jpg":
                pix.pil_save(f, "JPEG", quality=int(opts.get("quality", 90)))
            elif fmt == "tiff":
                pix.pil_save(f, "TIFF", compression="tiff_lzw")
            else:
                pix.save(f)
            files.append(f)
        return files[0] if len(files) == 1 else _zip(files, workdir / f"{stem}_{fmt}.zip")
    if fmt == "psd":
        from .psd_export import psd_zip
        return psd_zip(pdf, workdir, dpi, stem)
    if fmt == "txt":
        doc = fitz.open(pdf)
        out = workdir / f"{stem}.txt"
        out.write_text("\n\f".join(p.get_text() for p in doc))
        return out
    if fmt == "md":
        out = workdir / f"{stem}.md"
        try:
            import pymupdf4llm
            out.write_text(pymupdf4llm.to_markdown(str(pdf)))
        except Exception:
            doc = fitz.open(pdf)
            out.write_text("\n\n---\n\n".join(p.get_text() for p in doc))
        return out
    if fmt == "html":
        doc = fitz.open(pdf)
        out = workdir / f"{stem}.html"
        body = "\n<hr>\n".join(p.get_text("xhtml") for p in doc)
        out.write_text(f"<!doctype html><meta charset=utf-8><title>{stem}</title><body style='max-width:900px;margin:auto;font-family:sans-serif'>{body}</body>")
        return out
    if fmt == "pdfa":
        out = workdir / f"{stem}_PDFA.pdf"
        _ocrmypdf(pdf, out, ["--skip-text", "--output-type", "pdfa-2"])
        return out
    if fmt == "svg":
        doc = fitz.open(pdf)
        files = []
        for i, page in enumerate(doc):
            f = workdir / f"{stem}_p{i + 1:03d}.svg"
            f.write_text(page.get_svg_image(text_as_path=False))
            files.append(f)
        return files[0] if len(files) == 1 else _zip(files, workdir / f"{stem}_svg.zip")
    raise ValueError(f"Unknown export format: {fmt}")


def _zip(files, out):
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in files:
            zf.write(f, f.name)
    return out


def _to_xlsx(pdf, out):
    from openpyxl import Workbook
    from openpyxl.styles import Font
    doc = fitz.open(pdf)
    wb = Workbook()
    wb.remove(wb.active)
    found = 0
    for pno, page in enumerate(doc):
        try:
            tabs = page.find_tables()
        except Exception:
            continue
        for k, t in enumerate(tabs.tables):
            rows = t.extract()
            if not rows:
                continue
            ws = wb.create_sheet(f"p{pno + 1}_table{k + 1}"[:31])
            for r, row in enumerate(rows, 1):
                for c, val in enumerate(row, 1):
                    v = (val or "").replace("\n", " ").strip()
                    num = v.replace(",", "").replace("$", "").replace("%", "")
                    if num.startswith("(") and num.endswith(")"):
                        num = "-" + num[1:-1]
                    try:
                        cell = ws.cell(r, c, float(num) if num and num not in ("-",) else v)
                    except ValueError:
                        cell = ws.cell(r, c, v)
                    if r == 1:
                        cell.font = Font(bold=True)
            found += 1
    if not found:  # no tables: dump text lines, splitting on runs of spaces
        import re
        ws = wb.create_sheet("Text")
        r = 1
        for pno, page in enumerate(doc):
            for line in page.get_text().splitlines():
                cells = re.split(r"\s{2,}|\t", line.strip())
                for c, v in enumerate(cells, 1):
                    ws.cell(r, c, v)
                r += 1
    wb.save(out)
    return out


def _to_pptx(pdf, out, dpi):
    from pptx import Presentation
    from pptx.util import Emu
    doc = fitz.open(pdf)
    prs = Presentation()
    r0 = doc[0].rect
    prs.slide_width, prs.slide_height = Emu(int(r0.width * 12700)), Emu(int(r0.height * 12700))
    for page in doc:
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        img = io.BytesIO(page.get_pixmap(dpi=max(dpi, 150)).tobytes("png"))
        slide.shapes.add_picture(img, 0, 0, prs.slide_width, prs.slide_height)
        notes = page.get_text().strip()
        if notes:
            slide.notes_slide.notes_text_frame.text = notes[:5000]
    prs.save(out)
    return out


# ---------------------------------------------------------------- OCR / compress

def _ocrmypdf(src, out, args):
    r = subprocess.run(["ocrmypdf", *args, str(src), str(out)], capture_output=True, text=True, timeout=1800)
    if r.returncode not in (0, 6) or not Path(out).exists():  # 6 = already has text
        if r.returncode == 6:
            shutil.copyfile(src, out)
            return
        raise RuntimeError("OCR failed: " + r.stderr[-600:])


def ocr(src: Path, out: Path, lang: str = "eng", force: bool = False, deskew: bool = True):
    args = ["-l", lang, "--force-ocr" if force else "--skip-text", "--output-type", "pdf", "--optimize", "1"]
    if deskew and force:
        args.append("--deskew")
    _ocrmypdf(src, out, args)


def compress(src: Path, out: Path, level: str = "medium") -> dict:
    doc = fitz.open(src)
    before = src.stat().st_size
    presets = {"low": None, "medium": (220, 150, 75), "high": (150, 110, 55), "extreme": (100, 72, 40)}
    pr = presets.get(level, presets["medium"])
    if pr:
        th, target, q = pr
        try:
            doc.rewrite_images(dpi_threshold=th, dpi_target=target, quality=q, lossy=True, lossless=True)
        except Exception:
            pass
    try:
        doc.subset_fonts()
    except Exception:
        pass
    doc.save(out, garbage=4, deflate=True, deflate_images=True, deflate_fonts=True, clean=True, use_objstms=1)
    after = out.stat().st_size
    if after >= before:  # never make it bigger
        shutil.copyfile(src, out)
        after = before
    return {"before": before, "after": after}


def encrypt_copy(src: Path, out: Path, protect: dict):
    doc = fitz.open(src)
    perm = fitz.PDF_PERM_ACCESSIBILITY
    if protect.get("print", True):
        perm |= fitz.PDF_PERM_PRINT | fitz.PDF_PERM_PRINT_HQ
    if protect.get("copy", True):
        perm |= fitz.PDF_PERM_COPY
    if protect.get("edit", False):
        perm |= fitz.PDF_PERM_MODIFY | fitz.PDF_PERM_ANNOTATE | fitz.PDF_PERM_FORM | fitz.PDF_PERM_ASSEMBLE
    owner = protect.get("owner_pw") or protect.get("user_pw") or "owner"
    doc.save(out, encryption=fitz.PDF_ENCRYPT_AES_256, user_pw=protect.get("user_pw") or "",
             owner_pw=owner, permissions=perm, garbage=3, deflate=True)


def compare(a: Path, b: Path) -> dict:
    da, db = fitz.open(a), fitz.open(b)
    la, lb = [], []
    for i, p in enumerate(da):
        la += [(i, ln) for ln in p.get_text().splitlines() if ln.strip()]
    for i, p in enumerate(db):
        lb += [(i, ln) for ln in p.get_text().splitlines() if ln.strip()]
    sm = difflib.SequenceMatcher(a=[x[1] for x in la], b=[x[1] for x in lb], autojunk=False)
    chunks = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        chunks.append({"type": tag,
                       "a": [{"page": la[k][0], "text": la[k][1]} for k in range(i1, i2)],
                       "b": [{"page": lb[k][0], "text": lb[k][1]} for k in range(j1, j2)]})
    return {"similarity": round(sm.ratio() * 100, 1), "changes": chunks,
            "pages": [len(da), len(db)]}
