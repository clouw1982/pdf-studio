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

from . import batch, convert, engine, signing, store, studio, vcompare, watcher
from .psd_export import pdf_to_psds

APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
SECRET = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
SESSION_DAYS = 30
signer = URLSafeTimedSerializer(SECRET, salt="pdfstudio")
STATIC = Path(__file__).parent / "static"

app = FastAPI(title="PDF Studio")
fitz.TOOLS.mupdf_display_errors(False)


# ---------------------------------------------------------------- auth

OPEN_PATHS = ("/login", "/api/login", "/static/login.css", "/static/favicon.svg", "/healthz",
              "/sign/", "/api/sign/", "/static/sign.")


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


def apply_op(doc_id: str, p: dict) -> dict:
    """Run one operation on a document and commit a new version. Raises on error."""
    name = p.get("op")
    m = store.meta(doc_id)
    with store.lock(doc_id):
        if True:
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


@app.post("/api/docs/{doc_id}/op")
def run_op(doc_id: str, p: dict = Body(...)):
    try:
        return apply_op(doc_id, p)
    except HTTPException:
        raise
    except KeyError:
        raise HTTPException(404, "Document not found")
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



# ---------------------------------------------------------------- Image Studio

def _studio(fn, *a):
    try:
        return fn(*a)
    except KeyError:
        raise HTTPException(404, "Project not found")


@app.get("/studio")
def studio_page():
    return FileResponse(STATIC / "studio.html")


@app.get("/api/studio/projects")
def studio_list():
    return studio.list_projects()


@app.post("/api/studio/from-page")
def studio_from_page(doc_id: str = Body(...), page: int = Body(0), dpi: int = Body(150)):
    _open(doc_id)
    return studio.from_page(doc_id, page, max(50, min(dpi, 400)))


@app.post("/api/studio/from-file")
def studio_from_file(file: UploadFile = File(...)):
    td = _tmpdir()
    try:
        name = Path(file.filename or "image").name
        raw = td / name
        with raw.open("wb") as fh:
            shutil.copyfileobj(file.file, fh)
        ext = raw.suffix.lower()
        if ext not in (".psd", ".psb", ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"):
            pdf = convert.to_pdf(raw, td)
            return studio.from_file(pdf, Path(name).stem)
        return studio.from_file(raw, Path(name).stem)
    finally:
        shutil.rmtree(td, ignore_errors=True)


@app.post("/api/studio/new")
def studio_new(name: str = Body("Untitled"), w: int = Body(1920), h: int = Body(1080), bg: str = Body("#ffffff")):
    return studio.blank(name, w, h, bg)


@app.get("/api/studio/projects/{pid}")
def studio_get(pid: str):
    return _studio(studio.get, pid)


@app.put("/api/studio/projects/{pid}")
def studio_save(pid: str, body: dict = Body(...)):
    return _studio(studio.save, pid, body)


@app.delete("/api/studio/projects/{pid}")
def studio_delete(pid: str):
    _studio(studio.delete, pid)
    return {"ok": True}


@app.post("/api/studio/projects/{pid}/duplicate")
def studio_dup(pid: str):
    return _studio(studio.duplicate, pid)


@app.get("/api/studio/projects/{pid}/layer/{lid}.png")
def studio_layer(pid: str, lid: str):
    try:
        f = studio.layer_path(pid, lid)
    except KeyError:
        raise HTTPException(404)
    if not f.exists():
        raise HTTPException(404)
    return FileResponse(f, media_type="image/png", headers={"Cache-Control": "no-cache"})


@app.get("/api/studio/projects/{pid}/thumb.png")
def studio_thumb(pid: str):
    try:
        f = studio._pid_dir(pid) / "thumb.png"
    except KeyError:
        raise HTTPException(404)
    if not f.exists():
        f = studio._pid_dir(pid) / f"{studio.get(pid)['layers'][0]['id']}.png"
    return FileResponse(f, media_type="image/png", headers={"Cache-Control": "no-cache"})


@app.get("/api/studio/projects/{pid}/psd")
def studio_psd(pid: str):
    p = _studio(studio.get, pid)
    td = _tmpdir()
    out = td / (("".join(c for c in p["name"] if c not in '/\\:*?"<>|') or "image") + ".psd")
    studio.to_psd(pid, out)
    return FileResponse(out, filename=out.name, background=_cleanup(td))


@app.post("/api/studio/projects/{pid}/place")
def studio_place(pid: str, body: dict = Body(...)):
    try:
        return _studio(studio.place_into_pdf, pid, body)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"{type(e).__name__}: {e}")


@app.post("/api/studio/remove-bg")
def studio_remove_bg(data: str = Body(..., embed=True)):
    try:
        return {"data": studio.remove_background(data)}
    except Exception as e:
        raise HTTPException(500, f"Background removal failed: {e}")


# ---------------------------------------------------------------- batch

@app.post("/api/batch")
def batch_start(ids: list[str] = Body(...), steps: list[dict] = Body([]), export: str | None = Body(None),
                dpi: int = Body(150)):
    if not ids:
        raise HTTPException(400, "Choose at least one file")
    def runner(doc_id, p):
        return apply_op(doc_id, p)
    return batch.start(ids, steps, export or None, runner, dpi)


@app.get("/api/batch")
def batch_list():
    return batch.recent()


@app.get("/api/batch/{jid}")
def batch_get(jid: str):
    j = batch.get(jid)
    if not j:
        raise HTTPException(404)
    return j


# ---------------------------------------------------------------- visual compare

@app.get("/api/vcompare")
def vcompare_page(a: str, b: str, pa: int = 0, pb: int = 0, scale: float = 1.5, threshold: int = 40):
    try:
        res = vcompare.compare_pages(a, pa, b, pb, max(0.3, min(scale, 3)), threshold)
    except KeyError:
        raise HTTPException(404)
    except ValueError as e:
        raise HTTPException(400, str(e))
    png = res.pop("png")
    import base64
    res["image"] = "data:image/png;base64," + base64.b64encode(png).decode()
    return res


@app.get("/api/vcompare/summary")
def vcompare_summary(a: str, b: str):
    return vcompare.summary(a, b)


# ---------------------------------------------------------------- signatures (sender)

def _base_url(request: Request):
    return os.environ.get("PUBLIC_URL") or str(request.base_url).rstrip("/")


@app.post("/api/docs/{doc_id}/sign-request")
def sign_request(doc_id: str, request: Request, signer_name: str = Body(...), signer_email: str = Body(""),
                 message: str = Body(""), expires_days: int = Body(30), sender: str = Body("")):
    _open(doc_id)
    if not signer_name.strip():
        raise HTTPException(400, "Signer name is required")
    r = signing.create(doc_id, signer_name, signer_email, message, expires_days, _base_url(request),
                       sender.strip() or os.environ.get("SENDER_NAME", "PDF Studio"))
    return {k: r.get(k) for k in ("token", "url", "emailed", "email_error", "status")} | {"smtp": signing.smtp_ready()}


@app.get("/api/sign-requests")
def sign_requests():
    return {"requests": signing.list_requests(), "smtp": signing.smtp_ready()}


@app.delete("/api/sign-requests/{token}")
def sign_cancel(token: str):
    try:
        signing.cancel(token)
    except KeyError:
        raise HTTPException(404)
    return {"ok": True}


# ---------------------------------------------------------------- signatures (public signer)

def _client(request: Request):
    ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (request.client.host if request.client else None)
    return ip, request.headers.get("user-agent", "")


@app.get("/sign/{token}")
def sign_page(token: str):
    return FileResponse(STATIC / "sign.html")


@app.get("/api/sign/{token}")
def sign_info(token: str, request: Request):
    try:
        return signing.public_info(token, *_client(request))
    except KeyError:
        raise HTTPException(404, "This signing link is not valid")


@app.get("/api/sign/{token}/page/{pno}.png")
def sign_render(token: str, pno: int, scale: float = 1.5):
    try:
        return Response(signing.render(token, pno, max(0.2, min(scale, 4))), media_type="image/png")
    except (KeyError, IndexError):
        raise HTTPException(404)


@app.post("/api/sign/{token}/complete")
def sign_complete(token: str, request: Request, body: dict = Body(...)):
    try:
        r = signing.complete(token, body, *_client(request))
    except KeyError:
        raise HTTPException(404)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "download": f"/api/sign/{token}/download", "sealed": r.get("sealed")}


@app.post("/api/sign/{token}/decline")
def sign_decline(token: str, request: Request, reason: str = Body("", embed=True)):
    try:
        signing.decline(token, reason, *_client(request))
    except KeyError:
        raise HTTPException(404)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@app.get("/api/sign/{token}/download")
def sign_download(token: str):
    try:
        f, name = signing.signed_file(token)
    except KeyError:
        raise HTTPException(404)
    return FileResponse(f, filename=name, media_type="application/pdf")


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
