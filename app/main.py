import hmac
import os
import secrets
import shutil
import tempfile
import threading
from pathlib import Path

import pymupdf as fitz
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, URLSafeTimedSerializer
from starlette.background import BackgroundTask

from . import convert, engine, store, watcher
from .psd_export import pdf_to_psds

APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
SECRET = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
SESSION_DAYS = 30
signer = URLSafeTimedSerializer(SECRET, salt="pdfstudio")
STATIC = Path(__file__).parent / "static"

app = FastAPI(title="PDF Studio")
fitz.TOOLS.mupdf_display_errors(False)


# ---------------------------------------------------------------- auth

OPEN_PATHS = ("/login", "/api/login", "/static/login.css", "/static/favicon.svg", "/healthz")


@app.middleware("http")
async def auth(request: Request, call_next):
    if APP_PASSWORD and not request.url.path.startswith(OPEN_PATHS):
        tok = request.cookies.get("pdfstudio")
        try:
            signer.loads(tok or "", max_age=SESSION_DAYS * 86400)
        except BadSignature:
            if request.url.path.startswith("/api/"):
                return JSONResponse({"error": "login required"}, status_code=401)
            return RedirectResponse("/login")
    return await call_next(request)


@app.get("/login")
def login_page():
    return FileResponse(STATIC / "login.html")


@app.post("/api/login")
def login(password: str = Form(...)):
    if not APP_PASSWORD or hmac.compare_digest(password, APP_PASSWORD):
        r = RedirectResponse("/", status_code=303)
        r.set_cookie("pdfstudio", signer.dumps("ok"), max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax")
        return r
    return RedirectResponse("/login?bad=1", status_code=303)


@app.get("/logout")
def logout():
    r = RedirectResponse("/login")
    r.delete_cookie("pdfstudio")
    return r


@app.get("/healthz")
def health():
    return {"ok": True}


# ---------------------------------------------------------------- helpers

def _open(doc_id):
    try:
        d = fitz.open(store.path(doc_id))
    except KeyError:
        raise HTTPException(404, "Document not found")
    if d.needs_pass:
        raise HTTPException(423, "Document is password protected - unlock it first")
    return d


def _tmpdir():
    return Path(tempfile.mkdtemp(dir=store.TMP))


def _cleanup(path):
    return BackgroundTask(shutil.rmtree, path, ignore_errors=True)


def _summary(doc_id):
    m = store.meta(doc_id)
    out = {"id": doc_id, "name": m["name"], "locked": m.get("locked", False),
           "versions": [{"label": v["label"], "t": v["t"]} for v in m["versions"]], "cur": m["cur"],
           "protect": bool(m.get("protect")), "size": store.path(doc_id).stat().st_size}
    if m.get("locked"):
        return out
    d = _open(doc_id)
    out |= {"pages": engine.page_info(d), "toc": d.get_toc(), "metadata": d.metadata,
            "fields": len(engine.doc_fields(d)), "attachments": d.embfile_names()}
    return out


def _import_upload(up: UploadFile, td: Path) -> Path:
    name = Path(up.filename or "upload").name
    raw = td / name
    with raw.open("wb") as fh:
        shutil.copyfileobj(up.file, fh)
    return convert.to_pdf(raw, td)


# ---------------------------------------------------------------- library

@app.get("/api/docs")
def list_docs():
    return store.list_docs()


@app.post("/api/upload")
def upload(files: list[UploadFile] = File(...), psd: bool = Form(False)):
    created, errors = [], []
    for up in files:
        td = _tmpdir()
        try:
            pdf = _import_upload(up, td)
            d = fitz.open(pdf)
            locked = d.needs_pass
            d.close()
            doc_id = store.create(Path(up.filename).stem, pdf, "upload", locked)
            created.append(doc_id)
            if psd and not locked:
                threading.Thread(target=pdf_to_psds, args=(store.path(doc_id), store.OUTPUT / Path(up.filename).stem,
                                                           watcher.PSD_DPI, Path(up.filename).stem), daemon=True).start()
        except Exception as e:
            errors.append(f"{up.filename}: {e}")
        finally:
            shutil.rmtree(td, ignore_errors=True)
    return {"created": created, "errors": errors}


@app.post("/api/blank")
def blank(name: str = Body("Untitled"), size: str = Body("letter"), pages: int = Body(1)):
    td = _tmpdir()
    d = fitz.open()
    r = fitz.paper_rect(size)
    for _ in range(max(1, pages)):
        d.new_page(width=r.width, height=r.height)
    d.save(td / "blank.pdf")
    doc_id = store.create(name, td / "blank.pdf", "new")
    shutil.rmtree(td, ignore_errors=True)
    return {"id": doc_id}


@app.post("/api/merge")
def merge(ids: list[str] = Body(...), name: str = Body("Merged")):
    out = fitz.open()
    for i in ids:
        out.insert_pdf(_open(i))
    td = _tmpdir()
    out.save(td / "m.pdf", garbage=3, deflate=True)
    doc_id = store.create(name, td / "m.pdf", "merge")
    shutil.rmtree(td, ignore_errors=True)
    return {"id": doc_id}


@app.post("/api/compare")
def compare(a: str = Body(...), b: str = Body(...)):
    return convert.compare(store.path(a), store.path(b))


@app.get("/api/docs/{doc_id}")
def doc_info(doc_id: str):
    try:
        return _summary(doc_id)
    except KeyError:
        raise HTTPException(404)


@app.delete("/api/docs/{doc_id}")
def doc_delete(doc_id: str):
    store.delete(doc_id)
    return {"ok": True}


@app.get("/api/docs/{doc_id}/page/{pno}.png")
def render(doc_id: str, pno: int, scale: float = 1.5, v: int = 0, annots: int = 1):
    d = _open(doc_id)
    if not 0 <= pno < len(d):
        raise HTTPException(404)
    scale = max(0.1, min(scale, 6))
    pix = d[pno].get_pixmap(matrix=fitz.Matrix(scale, scale), annots=bool(annots))
    return Response(pix.tobytes("png"), media_type="image/png",
                    headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/docs/{doc_id}/page/{pno}/objects")
def objects(doc_id: str, pno: int):
    d = _open(doc_id)
    page = d[pno]
    links = [{"rect": engine.r_out(page, l["from"]), "uri": l.get("uri"), "page": l.get("page")}
             for l in page.get_links()]
    return {"lines": engine.page_lines(page), "images": engine.page_images(page),
            "annots": engine.page_annots(page), "links": links,
            "fields": [f for f in engine.doc_fields(d) if f["page"] == pno]}


@app.get("/api/docs/{doc_id}/fields")
def fields(doc_id: str):
    return engine.doc_fields(_open(doc_id))


@app.get("/api/docs/{doc_id}/search")
def search(doc_id: str, q: str):
    return engine.search(_open(doc_id), q)


@app.get("/api/docs/{doc_id}/text")
def text(doc_id: str):
    d = _open(doc_id)
    return {"pages": [p.get_text() for p in d]}


@app.post("/api/docs/{doc_id}/op")
def run_op(doc_id: str, p: dict = Body(...)):
    name = p.get("op")
    m = store.meta(doc_id)
    with store.lock(doc_id):
        try:
            # ops that produce whole new files or new documents
            if name == "unlock":
                d = fitz.open(store.path(doc_id))
                if not d.authenticate(p.get("password", "")):
                    raise HTTPException(403, "Wrong password")
                out = store.new_version_path(doc_id)
                d.save(out, encryption=fitz.PDF_ENCRYPT_NONE, garbage=3, deflate=True)
                store.commit_file(doc_id, out, "Unlocked")
                m = store.meta(doc_id)
                m["locked"] = False
                store.save_meta(doc_id, m)
                return {"ok": True, "doc": _summary(doc_id)}
            if name == "ocr":
                out = store.new_version_path(doc_id)
                convert.ocr(store.path(doc_id), out, p.get("lang", "eng"), bool(p.get("force")))
                store.commit_file(doc_id, out, "OCR")
                return {"ok": True, "doc": _summary(doc_id)}
            if name == "compress":
                out = store.new_version_path(doc_id)
                res = convert.compress(store.path(doc_id), out, p.get("level", "medium"))
                store.commit_file(doc_id, out, f"Compressed ({p.get('level', 'medium')})")
                return {"ok": True, "result": res, "doc": _summary(doc_id)}
            if name == "protect":
                m["protect"] = {k: p.get(k) for k in ("user_pw", "owner_pw", "print", "copy", "edit")}
                store.save_meta(doc_id, m)
                return {"ok": True, "doc": _summary(doc_id)}
            if name == "unprotect":
                m["protect"] = None
                store.save_meta(doc_id, m)
                return {"ok": True, "doc": _summary(doc_id)}
            if name == "rename":
                store.rename(doc_id, p["name"])
                return {"ok": True, "doc": _summary(doc_id)}
            if name in ("extract", "split"):
                src = _open(doc_id)
                groups = []
                if name == "extract":
                    groups = [engine._pages(src, p["pages"])]
                elif p.get("every"):
                    n = int(p["every"])
                    groups = [list(range(i, min(i + n, len(src)))) for i in range(0, len(src), n)]
                else:
                    groups = [engine._pages(src, part) for part in str(p["ranges"]).split(";") if part.strip()]
                ids = []
                for k, g in enumerate(groups):
                    if not g:
                        continue
                    nd = fitz.open()
                    for i in g:
                        nd.insert_pdf(src, from_page=i, to_page=i)
                    td = _tmpdir()
                    nd.save(td / "x.pdf", garbage=3, deflate=True)
                    ids.append(store.create(f"{m['name']} (pages {g[0] + 1}-{g[-1] + 1})", td / "x.pdf", name))
                    shutil.rmtree(td, ignore_errors=True)
                if p.get("delete_from_source") and name == "extract":
                    engine.OPS["delete_pages"](src, {"pages": groups[0]}, {})
                    store.commit_doc(doc_id, src, "Extracted pages")
                return {"ok": True, "created": ids, "doc": _summary(doc_id)}

            fn = engine.OPS.get(name)
            if not fn:
                raise HTTPException(400, f"Unknown operation {name}")
            d = _open(doc_id)
            ctx = {"open_doc": _open, "name": m["name"]}
            res = fn(d, p, ctx)
            store.commit_doc(doc_id, d, p.get("label") or name.replace("_", " ").capitalize())
            return {"ok": True, "result": res, "doc": _summary(doc_id)}
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(400, f"{type(e).__name__}: {e}")


@app.post("/api/docs/{doc_id}/insert-file")
def insert_file(doc_id: str, file: UploadFile = File(...), at: int = Form(-1)):
    td = _tmpdir()
    try:
        pdf = _import_upload(file, td)
        with store.lock(doc_id):
            d = _open(doc_id)
            engine.OPS["insert_file"](d, {"_path": str(pdf), "at": at if at >= 0 else len(d)}, {})
            store.commit_doc(doc_id, d, f"Inserted {file.filename}")
        return {"ok": True, "doc": _summary(doc_id)}
    finally:
        shutil.rmtree(td, ignore_errors=True)


@app.post("/api/docs/{doc_id}/undo")
def undo(doc_id: str):
    store.undo(doc_id)
    return _summary(doc_id)


@app.post("/api/docs/{doc_id}/redo")
def redo(doc_id: str):
    store.redo(doc_id)
    return _summary(doc_id)


@app.post("/api/docs/{doc_id}/restore/{idx}")
def restore(doc_id: str, idx: int):
    store.restore(doc_id, idx)
    return _summary(doc_id)


@app.get("/api/docs/{doc_id}/download")
def download(doc_id: str, fmt: str = "pdf", dpi: int = 150, quality: int = 90):
    m = store.meta(doc_id)
    stem = "".join(c for c in m["name"] if c not in '/\\:*?"<>|') or "document"
    src = store.path(doc_id)
    td = _tmpdir()
    try:
        if fmt == "pdf":
            out = td / f"{stem}.pdf"
            if m.get("protect"):
                convert.encrypt_copy(src, out, m["protect"])
            else:
                shutil.copyfile(src, out)
        else:
            out = convert.export(src, fmt, td, stem, {"dpi": dpi, "quality": quality})
    except Exception as e:
        shutil.rmtree(td, ignore_errors=True)
        raise HTTPException(400, f"Export failed: {e}")
    return FileResponse(out, filename=out.name, background=_cleanup(td))


@app.get("/api/docs/{doc_id}/attachment/{name}")
def attachment(doc_id: str, name: str):
    d = _open(doc_id)
    return Response(d.embfile_get(name), media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ---------------------------------------------------------------- inbox / outputs

@app.get("/api/inbox")
def inbox():
    outputs = []
    for f in sorted(store.OUTPUT.rglob("*")):
        if f.is_file():
            outputs.append({"path": str(f.relative_to(store.OUTPUT)), "size": f.stat().st_size, "t": f.stat().st_mtime})
    pending = [f.name for f in store.INBOX.iterdir() if f.is_file() and not f.name.startswith(".")]
    return {"jobs": watcher.jobs()[:100], "outputs": sorted(outputs, key=lambda x: -x["t"])[:500],
            "pending": pending, "inbox_path": str(store.INBOX), "output_path": str(store.OUTPUT)}


@app.post("/api/inbox/upload")
def inbox_upload(files: list[UploadFile] = File(...)):
    for up in files:
        name = Path(up.filename or "upload").name
        tmp = store.INBOX / (name + ".part")
        with tmp.open("wb") as fh:
            shutil.copyfileobj(up.file, fh)
        tmp.rename(watcher._unique(store.INBOX, name))
    return {"ok": True}


@app.get("/api/output/{path:path}")
def output_file(path: str):
    f = (store.OUTPUT / path).resolve()
    if not str(f).startswith(str(store.OUTPUT.resolve())) or not f.is_file():
        raise HTTPException(404)
    return FileResponse(f, filename=f.name)


@app.delete("/api/output/{path:path}")
def output_delete(path: str):
    f = (store.OUTPUT / path).resolve()
    if not str(f).startswith(str(store.OUTPUT.resolve())) or not f.exists():
        raise HTTPException(404)
    if f.is_dir():
        shutil.rmtree(f)
    else:
        f.unlink()
    return {"ok": True}


# ---------------------------------------------------------------- static

@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.on_event("startup")
def _startup():
    if os.environ.get("DISABLE_WATCHER") != "1":
        watcher.start()
    if not APP_PASSWORD:
        print("WARNING: APP_PASSWORD is not set - the editor is open to anyone who can reach it.")
