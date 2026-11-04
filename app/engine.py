"""PDF operations. The UI works in *display* coordinates (PDF points, top-left
origin, page rotation applied). These helpers convert to PyMuPDF's unrotated
page space for every write, and back for every read."""
import base64
import datetime as _dt
import io
import re

import pymupdf as fitz

# ---------------------------------------------------------------- coordinates

def r_in(page, r):
    return fitz.Rect(r) * page.derotation_matrix


def p_in(page, p):
    return fitz.Point(p) * page.derotation_matrix


def r_out(page, r):
    return list(fitz.Rect(r) * page.rotation_matrix)


def p_out(page, p):
    q = fitz.Point(p) * page.rotation_matrix
    return [q.x, q.y]


def color(c, default=(0, 0, 0)):
    """'#rrggbb' or [r,g,b] (0-1) -> tuple."""
    if c is None:
        return default
    if isinstance(c, str):
        c = c.lstrip("#")
        if len(c) == 3:
            c = "".join(ch * 2 for ch in c)
        return tuple(int(c[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return tuple(c)


def int2hex(v: int) -> str:
    return "#%06x" % (v & 0xFFFFFF)


def decode_data_url(s: str) -> bytes:
    if "," in s and s.startswith("data:"):
        s = s.split(",", 1)[1]
    return base64.b64decode(s)


# ---------------------------------------------------------------- fonts

def pick_font(fontname: str = "", flags: int = 0, family: str | None = None, bold=None, italic=None):
    n = (fontname or "").lower()
    b = bool(flags & 16) or "bold" in n or "black" in n or "heavy" in n or "semibold" in n
    i = bool(flags & 2) or "italic" in n or "oblique" in n
    if bold is not None:
        b = bold
    if italic is not None:
        i = italic
    fam = family
    if not fam:
        if bool(flags & 8) or any(k in n for k in ("courier", "mono", "consol")):
            fam = "mono"
        elif bool(flags & 4) or any(k in n for k in ("times", "serif", "georgia", "garamond", "roman", "cambria")) and "sans" not in n:
            fam = "serif"
        else:
            fam = "sans"
    table = {
        "sans": ("helv", "hebo", "heit", "hebi"),
        "serif": ("tiro", "tibo", "tiit", "tibi"),
        "mono": ("cour", "cobo", "coit", "cobi"),
    }[fam if fam in ("sans", "serif", "mono") else "sans"]
    return table[(1 if b else 0) + (2 if i else 0)], fam, b, i


# ---------------------------------------------------------------- reading

def page_info(doc):
    return [{"w": p.rect.width, "h": p.rect.height, "rotation": p.rotation} for p in doc]


def page_lines(page):
    out = []
    d = page.get_text("dict", flags=fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_MEDIABOX_CLIP)
    for bi, b in enumerate(d["blocks"]):
        if b.get("type") != 0:
            continue
        for li, l in enumerate(b["lines"]):
            spans = [s for s in l["spans"] if s["text"].strip()]
            if not spans:
                continue
            text = "".join(s["text"] for s in l["spans"]).strip()
            main = max(spans, key=lambda s: len(s["text"]))
            fname, fam, bold, ital = pick_font(main["font"], main["flags"])
            out.append({
                "id": f"{bi}-{li}",
                "block": bi,
                "text": text,
                "bbox": r_out(page, l["bbox"]),
                "size": round(main["size"], 2),
                "font": main["font"],
                "family": fam, "bold": bold, "italic": ital,
                "color": int2hex(main["color"]),
                "origin": p_out(page, spans[0]["origin"]),
                "dir": l["dir"],
            })
    return out


def page_images(page):
    out = []
    for info in page.get_image_info(xrefs=True):
        bb = fitz.Rect(info["bbox"])
        if bb.is_empty or bb.width < 2 or bb.height < 2:
            continue
        out.append({"xref": info.get("xref", 0), "bbox": r_out(page, bb),
                    "w": info.get("width"), "h": info.get("height")})
    return out


def page_annots(page):
    out = []
    for a in page.annots() or []:
        c = a.colors.get("stroke") or a.colors.get("fill")
        out.append({"xref": a.xref, "type": a.type[1], "rect": r_out(page, a.rect),
                    "content": a.info.get("content", ""),
                    "color": "#%02x%02x%02x" % tuple(int(v * 255) for v in c) if c else None})
    return out


def doc_fields(doc):
    out = []
    for pno, page in enumerate(doc):
        for w in page.widgets() or []:
            out.append({"xref": w.xref, "page": pno, "name": w.field_name, "type": w.field_type_string,
                        "value": w.field_value, "rect": r_out(page, w.rect),
                        "options": w.choice_values or [],
                        "on": (w.on_state() if w.field_type in (fitz.PDF_WIDGET_TYPE_CHECKBOX, fitz.PDF_WIDGET_TYPE_RADIOBUTTON) else None)})
    return out


def search(doc, q, case=False):
    res = []
    if not q:
        return res
    for pno, page in enumerate(doc):
        for r in page.search_for(q):
            res.append({"page": pno, "rect": r_out(page, r)})
    return res


# ---------------------------------------------------------------- helpers

def _redact_text_only(page, rect):
    page.add_redact_annot(rect, fill=False)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                          graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                          text=fitz.PDF_REDACT_TEXT_REMOVE)


def _redact_image_only(page, rect):
    page.add_redact_annot(rect, fill=False)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_REMOVE,
                          graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                          text=fitz.PDF_REDACT_TEXT_NONE)


def _shrink(r, fx=0.0, fy=0.25):
    r = fitz.Rect(r)
    dx, dy = r.width * fx, r.height * fy
    return fitz.Rect(r.x0 + dx + 0.3, r.y0 + dy, r.x1 - dx - 0.3, r.y1 - dy)


def _pages(doc, spec):
    """spec: 'all' | list[int] | '1-3,5' (1-based)."""
    n = len(doc)
    if spec in (None, "all", ""):
        return list(range(n))
    if isinstance(spec, list):
        return [p for p in spec if 0 <= p < n]
    out = []
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            a = int(a) if a else 1
            b = int(b) if b else n
            out += list(range(a - 1, min(b, n)))
        else:
            out.append(int(part) - 1)
    return [p for p in out if 0 <= p < n]


def _insert_lines(page, origin_disp, text, size, fontname, col, direction=None, line_h=1.2):
    """Insert lines at the original baseline, keeping the original writing direction."""
    import math
    o = p_in(page, origin_disp)  # unrotated space
    dx, dy = direction or (1.0, 0.0)
    ang = int(round(math.degrees(math.atan2(-dy, dx)) / 90.0)) * 90 % 360
    rad = math.radians(ang)
    dx, dy = math.cos(rad), -math.sin(rad)
    step = fitz.Point(-dy, dx) * (size * line_h)
    for k, line in enumerate(text.split("\n")):
        page.insert_text(o + step * k, line, fontsize=size, fontname=fontname, color=col, rotate=ang)


def _pixmap_from_xref(doc, xref):
    pix = fitz.Pixmap(doc, xref)
    info = doc.extract_image(xref) if xref else None
    if info and info.get("smask"):
        try:
            mask = fitz.Pixmap(doc, info["smask"])
            pix = fitz.Pixmap(pix, mask)
        except Exception:
            pass
    if pix.colorspace and pix.colorspace.n > 3:
        pix = fitz.Pixmap(fitz.csRGB, pix)
    return pix


def stamp_text(page, text, position, size=10, col=(0, 0, 0), margin=24, fontname="helv"):
    W, H = page.rect.width, page.rect.height
    tl = fitz.get_text_length(text, fontname=fontname, fontsize=size)
    vert, horiz = (position.split("-") + ["center"])[:2]
    x = {"left": margin, "center": (W - tl) / 2, "right": W - margin - tl}[horiz]
    y = margin + size if vert == "top" else H - margin
    page.insert_text(p_in(page, (x, y)), text, fontsize=size, fontname=fontname, color=col, rotate=page.rotation)


# ---------------------------------------------------------------- ops
# Each op: fn(doc, params, ctx) -> optional dict result. ctx has open_doc(id).

OPS = {}


def op(name):
    def deco(fn):
        OPS[name] = fn
        return fn
    return deco


@op("edit_text")
def edit_text(doc, p, ctx):
    page = doc[p["page"]]
    bbox = r_in(page, p["bbox"])
    _redact_text_only(page, _shrink(bbox))
    text = p.get("text", "")
    if text.strip():
        fontname, *_ = pick_font(p.get("font", ""), 0, p.get("family"), p.get("bold"), p.get("italic"))
        _insert_lines(page, p["origin"], text, float(p.get("size", 11)), fontname, color(p.get("color")),
                      p.get("dir"))


@op("delete_text")
def delete_text(doc, p, ctx):
    page = doc[p["page"]]
    _redact_text_only(page, _shrink(r_in(page, p["bbox"]), 0, 0.1))


@op("add_text")
def add_text(doc, p, ctx):
    page = doc[p["page"]]
    rect = r_in(page, p["rect"])
    fontname, *_ = pick_font("", 0, p.get("family", "sans"), p.get("bold", False), p.get("italic", False))
    size = float(p.get("size", 12))
    align = {"left": 0, "center": 1, "right": 2, "justify": 3}.get(p.get("align", "left"), 0)
    for _ in range(20):
        rc = page.insert_textbox(rect, p["text"], fontsize=size, fontname=fontname,
                                 color=color(p.get("color")), align=align, rotate=page.rotation)
        if rc >= 0:
            break
        # grow the box downward (in display space) until the text fits
        d = fitz.Rect(p["rect"])
        d.y1 += max(size * 1.5, -rc + 2)
        p["rect"] = list(d)
        rect = r_in(page, d)


@op("add_image")
def add_image(doc, p, ctx):
    page = doc[p["page"]]
    data = decode_data_url(p["data"])
    page.insert_image(r_in(page, p["rect"]), stream=data, keep_proportion=p.get("keep", True),
                      rotate=page.rotation, overlay=True)


@op("delete_image")
def delete_image(doc, p, ctx):
    page = doc[p["page"]]
    _redact_image_only(page, _shrink(r_in(page, p["bbox"]), 0.1, 0.1))


@op("replace_image")
def replace_image(doc, p, ctx):
    page = doc[p["page"]]
    bbox = r_in(page, p["bbox"])
    _redact_image_only(page, _shrink(bbox, 0.1, 0.1))
    page.insert_image(bbox, stream=decode_data_url(p["data"]), keep_proportion=False, rotate=page.rotation)


@op("move_image")
def move_image(doc, p, ctx):
    """Move and/or resize an existing image: bbox -> rect (display coords)."""
    page = doc[p["page"]]
    xref = int(p.get("xref") or 0)
    old = r_in(page, p["bbox"])
    pix = None
    if xref:
        try:
            pix = _pixmap_from_xref(doc, xref)
        except Exception:
            pix = None
    if pix is None:  # inline image or stale xref: grab its pixels from a render
        pix = page.get_pixmap(clip=old, dpi=200, annots=False)
    _redact_image_only(page, _shrink(old, 0.1, 0.1))
    page.insert_image(r_in(page, p["rect"]), pixmap=pix, keep_proportion=False)


@op("markup")
def markup(doc, p, ctx):
    """Highlight / underline / strikeout / squiggly the text inside a drag rect."""
    page = doc[p["page"]]
    sel = r_in(page, p["rect"])
    words = [w for w in page.get_text("words") if fitz.Rect(w[:4]).intersects(sel)]
    if not words:
        raise ValueError("No text found in the selection")
    lines = {}
    for w in words:
        lines.setdefault((w[5], w[6]), fitz.Rect(w[:4]))
        lines[(w[5], w[6])] |= fitz.Rect(w[:4])
    quads = [r.quad for r in lines.values()]
    fn = {"highlight": page.add_highlight_annot, "underline": page.add_underline_annot,
          "strikeout": page.add_strikeout_annot, "squiggly": page.add_squiggly_annot}[p.get("kind", "highlight")]
    a = fn(quads)
    a.set_colors(stroke=color(p.get("color"), (1, 0.85, 0)))
    if p.get("comment"):
        a.set_info(content=p["comment"])
    a.update()


@op("note")
def note(doc, p, ctx):
    page = doc[p["page"]]
    a = page.add_text_annot(p_in(page, p["point"]), p.get("text", ""), icon=p.get("icon", "Note"))
    a.set_colors(stroke=color(p.get("color"), (1, 0.8, 0)))
    a.update()


@op("freetext")
def freetext(doc, p, ctx):
    page = doc[p["page"]]
    a = page.add_freetext_annot(r_in(page, p["rect"]), p.get("text", ""), fontsize=float(p.get("size", 12)),
                                text_color=color(p.get("color")),
                                fill_color=color(p["fill"]) if p.get("fill") else None,
                                rotate=page.rotation)
    a.update()


@op("ink")
def ink(doc, p, ctx):
    page = doc[p["page"]]
    paths = [[tuple(p_in(page, pt)) for pt in path] for path in p["paths"] if len(path) > 1]
    if not paths:
        return
    a = page.add_ink_annot(paths)
    a.set_border(width=float(p.get("width", 2)))
    a.set_colors(stroke=color(p.get("color"), (0, 0, 1)))
    if p.get("opacity"):
        a.set_opacity(float(p["opacity"]))
    a.update()


@op("shape")
def shape(doc, p, ctx):
    page = doc[p["page"]]
    kind = p.get("kind", "rect")
    stroke = color(p.get("color"), (1, 0, 0))
    if kind in ("line", "arrow"):
        a = page.add_line_annot(p_in(page, p["p1"]), p_in(page, p["p2"]))
        if kind == "arrow":
            a.set_line_ends(fitz.PDF_ANNOT_LE_NONE, fitz.PDF_ANNOT_LE_CLOSED_ARROW)
    else:
        r = r_in(page, p["rect"])
        a = page.add_rect_annot(r) if kind == "rect" else page.add_circle_annot(r)
    a.set_border(width=float(p.get("width", 2)))
    a.set_colors(stroke=stroke, fill=color(p["fill"]) if p.get("fill") else None)
    if kind == "arrow":
        a.set_colors(stroke=stroke, fill=stroke)
    a.update()


@op("delete_annot")
def delete_annot(doc, p, ctx):
    page = doc[p["page"]]
    for a in page.annots() or []:
        if a.xref == int(p["xref"]):
            page.delete_annot(a)
            return
    raise ValueError("Annotation not found")


@op("edit_annot")
def edit_annot(doc, p, ctx):
    page = doc[p["page"]]
    for a in page.annots() or []:
        if a.xref == int(p["xref"]):
            if "content" in p:
                a.set_info(content=p["content"])
            if p.get("rect"):
                a.set_rect(r_in(page, p["rect"]))
            if p.get("color"):
                a.set_colors(stroke=color(p["color"]))
            a.update()
            return


@op("redact")
def redact(doc, p, ctx):
    """True redaction: removes text, image pixels and vector art under each rect."""
    fill = color(p.get("fill"), (0, 0, 0))
    targets = {}
    for item in p.get("areas", []):
        targets.setdefault(item["page"], []).append(r_in(doc[item["page"]], item["rect"]))
    if p.get("query"):
        for pno, page in enumerate(doc):
            for r in page.search_for(p["query"]):
                targets.setdefault(pno, []).append(r)
    if p.get("pattern"):
        rx = re.compile(p["pattern"])
        for pno, page in enumerate(doc):
            text = page.get_text()
            for m in set(rx.findall(text)):
                m = m if isinstance(m, str) else m[0]
                for r in page.search_for(m):
                    targets.setdefault(pno, []).append(r)
    count = 0
    for pno, rects in targets.items():
        page = doc[pno]
        for r in rects:
            page.add_redact_annot(r, fill=fill, text=p.get("label") or None)
            count += 1
        page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS)
    return {"redacted": count}


# ---- forms

@op("fill_form")
def fill_form(doc, p, ctx):
    vals = {int(k): v for k, v in p["values"].items()}
    for page in doc:
        for w in page.widgets() or []:
            if w.xref in vals:
                v = vals[w.xref]
                if w.field_type in (fitz.PDF_WIDGET_TYPE_CHECKBOX, fitz.PDF_WIDGET_TYPE_RADIOBUTTON):
                    w.field_value = w.on_state() if v in (True, "true", "on", "Yes", 1) else "Off"
                else:
                    w.field_value = str(v)
                w.update()


@op("add_field")
def add_field(doc, p, ctx):
    page = doc[p["page"]]
    w = fitz.Widget()
    t = p.get("type", "text")
    w.field_type = {"text": fitz.PDF_WIDGET_TYPE_TEXT, "checkbox": fitz.PDF_WIDGET_TYPE_CHECKBOX,
                    "combobox": fitz.PDF_WIDGET_TYPE_COMBOBOX, "listbox": fitz.PDF_WIDGET_TYPE_LISTBOX,
                    "signature": fitz.PDF_WIDGET_TYPE_SIGNATURE}.get(t, fitz.PDF_WIDGET_TYPE_TEXT)
    w.rect = r_in(page, p["rect"])
    w.field_name = p.get("name") or f"{t}_{len(list(page.widgets() or []))+1}_{p['page']+1}"
    if t in ("combobox", "listbox"):
        w.choice_values = p.get("options") or ["Option 1", "Option 2"]
    w.text_fontsize = float(p.get("size", 0))
    w.border_color = (0.3, 0.3, 0.6)
    w.border_width = 1
    page.add_widget(w)


@op("delete_field")
def delete_field(doc, p, ctx):
    for page in doc:
        for w in page.widgets() or []:
            if w.xref == int(p["xref"]):
                page.delete_widget(w)
                return


@op("flatten")
def flatten(doc, p, ctx):
    doc.bake(annots=p.get("annots", True), widgets=p.get("widgets", True))


# ---- organize

@op("rotate")
def rotate(doc, p, ctx):
    for pno in _pages(doc, p.get("pages")):
        pg = doc[pno]
        pg.set_rotation((pg.rotation + int(p.get("angle", 90))) % 360)


@op("delete_pages")
def delete_pages(doc, p, ctx):
    pages = sorted(set(_pages(doc, p["pages"])))
    if len(pages) >= len(doc):
        raise ValueError("Can't delete every page")
    doc.delete_pages(pages)


@op("reorder")
def reorder(doc, p, ctx):
    order = [int(i) for i in p["order"]]
    doc.select(order)


@op("move_page")
def move_page(doc, p, ctx):
    order = list(range(len(doc)))
    src = order.pop(int(p["from"]))
    order.insert(int(p["to"]), src)
    doc.select(order)


@op("duplicate_page")
def duplicate_page(doc, p, ctx):
    doc.fullcopy_page(int(p["page"]), int(p["page"]) + 1)


@op("insert_blank")
def insert_blank(doc, p, ctx):
    at = int(p.get("at", len(doc)))
    ref = doc[min(max(at - 1, 0), len(doc) - 1)].rect if len(doc) else fitz.paper_rect("letter")
    doc.new_page(pno=at, width=float(p.get("w", ref.width)), height=float(p.get("h", ref.height)))


@op("insert_doc")
def insert_doc(doc, p, ctx):
    src = ctx["open_doc"](p["source"])
    pages = _pages(src, p.get("pages"))
    at = int(p.get("at", len(doc)))
    tmp = fitz.open()
    for i in pages:
        tmp.insert_pdf(src, from_page=i, to_page=i)
    doc.insert_pdf(tmp, start_at=at)


@op("insert_file")
def insert_file(doc, p, ctx):
    """Insert an uploaded file (any supported format, converted already) at position."""
    src = fitz.open(p["_path"])
    doc.insert_pdf(src, start_at=int(p.get("at", len(doc))))


@op("crop")
def crop(doc, p, ctx):
    for pno in _pages(doc, p.get("pages")):
        page = doc[pno]
        if p.get("margins") is not None:  # [top,right,bottom,left] in points
            t, r_, b, l = [float(x) for x in p["margins"]]
            disp = fitz.Rect(l, t, page.rect.width - r_, page.rect.height - b)
        else:
            disp = fitz.Rect(p["rect"])
        rect = r_in(page, disp) + (page.cropbox.x0, page.cropbox.y0, page.cropbox.x0, page.cropbox.y0)
        page.set_cropbox(rect & page.mediabox)


@op("resize_pages")
def resize_pages(doc, p, ctx):
    """Scale every page to a paper size (letter, a4, legal...)."""
    target = fitz.paper_rect(p.get("size", "letter"))
    src = fitz.open()
    src.insert_pdf(doc)
    pages = _pages(doc, p.get("pages"))
    for pno in pages:
        page = doc[pno]
        landscape = page.rect.width > page.rect.height
        t = fitz.Rect(0, 0, target.height, target.width) if landscape else target
        newp = doc.new_page(pno=pno, width=t.width, height=t.height)
        newp.show_pdf_page(newp.rect, src, pno)
        doc.delete_page(pno + 1)


# ---- page decorations

@op("watermark")
def watermark(doc, p, ctx):
    text = p.get("text", "CONFIDENTIAL")
    size = float(p.get("size", 60))
    col = color(p.get("color"), (0.8, 0.1, 0.1))
    opacity = float(p.get("opacity", 0.2))
    angle = float(p.get("angle", 45))
    image = decode_data_url(p["image"]) if p.get("image") else None
    for pno in _pages(doc, p.get("pages")):
        page = doc[pno]
        c = fitz.Point((page.rect.x0 + page.rect.x1) / 2, (page.rect.y0 + page.rect.y1) / 2)
        if image:
            w = page.rect.width * float(p.get("scale", 0.5))
            disp = fitz.Rect(c.x - w / 2, c.y - w / 2, c.x + w / 2, c.y + w / 2)
            page.insert_image(r_in(page, disp), stream=image, overlay=p.get("front", True), rotate=page.rotation)
            continue
        tl = fitz.get_text_length(text, fontname="hebo", fontsize=size)
        pivot = p_in(page, c)
        origin = fitz.Point(pivot.x - tl / 2, pivot.y + size / 3)
        page.insert_text(origin, text, fontsize=size, fontname="hebo", color=col, fill_opacity=opacity,
                         stroke_opacity=opacity, overlay=p.get("front", True),
                         morph=(pivot, fitz.Matrix(angle + page.rotation)))


@op("page_numbers")
def page_numbers(doc, p, ctx):
    fmt = p.get("format", "Page {n} of {total}")
    start = int(p.get("start", 1))
    pages = _pages(doc, p.get("pages"))
    for k, pno in enumerate(pages):
        s = fmt.format(n=k + start, total=len(pages) + start - 1)
        stamp_text(doc[pno], s, p.get("position", "bottom-center"), float(p.get("size", 10)),
                   color(p.get("color")), float(p.get("margin", 24)))


@op("header_footer")
def header_footer(doc, p, ctx):
    total = len(doc)
    today = _dt.date.today().isoformat()
    for k, pno in enumerate(_pages(doc, p.get("pages"))):
        for slot in ("top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"):
            t = p.get(slot)
            if t:
                t = t.replace("{n}", str(pno + 1)).replace("{total}", str(total)).replace("{date}", today) \
                     .replace("{name}", ctx.get("name", ""))
                stamp_text(doc[pno], t, slot, float(p.get("size", 9)), color(p.get("color")), float(p.get("margin", 20)))


@op("bates")
def bates(doc, p, ctx):
    prefix = p.get("prefix", "")
    start = int(p.get("start", 1))
    digits = int(p.get("digits", 6))
    for k, pno in enumerate(_pages(doc, p.get("pages"))):
        stamp_text(doc[pno], f"{prefix}{start + k:0{digits}d}{p.get('suffix', '')}",
                   p.get("position", "bottom-right"), float(p.get("size", 9)), color(p.get("color")), 18)
    return {"last": f"{prefix}{start + len(doc) - 1:0{digits}d}"}


@op("background")
def background(doc, p, ctx):
    col = color(p.get("color"), (1, 1, 0.9))
    for pno in _pages(doc, p.get("pages")):
        page = doc[pno]
        page.draw_rect(page.mediabox, color=None, fill=col, overlay=False)


# ---- document level

@op("metadata")
def metadata(doc, p, ctx):
    m = doc.metadata or {}
    for k in ("title", "author", "subject", "keywords", "creator", "producer"):
        if k in p:
            m[k] = p[k]
    doc.set_metadata(m)


@op("set_toc")
def set_toc(doc, p, ctx):
    doc.set_toc([[int(a), str(t), int(pg)] for a, t, pg in p["toc"]])


@op("add_bookmark")
def add_bookmark(doc, p, ctx):
    toc = doc.get_toc()
    toc.append([int(p.get("level", 1)), p["title"], int(p["page"]) + 1])
    toc.sort(key=lambda e: e[2])
    # levels must not jump; normalise
    fixed, prev = [], 0
    for lvl, t, pg in toc:
        lvl = min(lvl, prev + 1)
        fixed.append([lvl, t, pg])
        prev = lvl
    doc.set_toc(fixed)


@op("add_link")
def add_link(doc, p, ctx):
    page = doc[p["page"]]
    link = {"from": r_in(page, p["rect"])}
    if p.get("uri"):
        link |= {"kind": fitz.LINK_URI, "uri": p["uri"]}
    else:
        link |= {"kind": fitz.LINK_GOTO, "page": int(p["target"]), "to": fitz.Point(0, 0)}
    page.insert_link(link)


@op("sanitize")
def sanitize(doc, p, ctx):
    doc.scrub()
    doc.set_metadata({})
    doc.del_xml_metadata()


@op("attach_file")
def attach_file(doc, p, ctx):
    doc.embfile_add(p["filename"], decode_data_url(p["data"]), filename=p["filename"])


@op("grayscale")
def grayscale(doc, p, ctx):
    """Rasterise pages to grayscale (useful for print-ready / size reduction)."""
    dpi = int(p.get("dpi", 150))
    src = fitz.open()
    src.insert_pdf(doc)
    for pno in range(len(doc)):
        r = doc[pno].rect
        pix = src[pno].get_pixmap(dpi=dpi, colorspace=fitz.csGRAY)
        newp = doc.new_page(pno=pno, width=r.width, height=r.height)
        newp.insert_image(newp.rect, pixmap=pix)
        doc.delete_page(pno + 1)
