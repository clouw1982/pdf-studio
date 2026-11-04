"""Watches the inbox folder. Every document dropped there is converted to PDF,
added to the library (so it opens in the web editor) and exported as layered
PSD files into output/<name>/."""
import json
import os
import shutil
import tempfile
import threading
import time
import traceback
from pathlib import Path

import pymupdf as fitz

from . import store
from .convert import SUPPORTED, to_pdf
from .psd_export import pdf_to_psds

PSD_DPI = int(os.environ.get("PSD_DPI", "150"))
MAKE_PDF_COPY = os.environ.get("INBOX_PDF_COPY", "1") == "1"
JOBS_FILE = store.DATA / "jobs.json"
_jobs_lock = threading.Lock()
IGNORE_SUFFIX = (".part", ".crdownload", ".tmp", ".download", ".icloud")


def _load_jobs():
    try:
        return json.loads(JOBS_FILE.read_text())
    except Exception:
        return []


def _save_job(job):
    with _jobs_lock:
        jobs = [j for j in _load_jobs() if j["id"] != job["id"]]
        jobs.insert(0, job)
        JOBS_FILE.write_text(json.dumps(jobs[:300], indent=1))


def jobs():
    return _load_jobs()


def _unique(dirpath: Path, name: str) -> Path:
    p = dirpath / name
    i = 2
    while p.exists():
        p = dirpath / f"{Path(name).stem} ({i}){Path(name).suffix}"
        i += 1
    return p


def process(f: Path, make_psd: bool = True) -> dict:
    job = {"id": f"{int(time.time()*1000)}-{f.name}", "file": f.name, "status": "processing",
           "started": time.time(), "outputs": [], "doc_id": None, "error": None}
    _save_job(job)
    try:
        if f.suffix.lower() not in SUPPORTED:
            raise ValueError(f"Unsupported file type {f.suffix}")
        with tempfile.TemporaryDirectory(dir=store.TMP) as td:
            td = Path(td)
            local = td / f.name
            shutil.copyfile(f, local)
            pdf = to_pdf(local, td)
            d = fitz.open(pdf)
            locked = d.needs_pass
            d.close()
            doc_id = store.create(f.stem, pdf, source="inbox", locked=locked)
            job["doc_id"] = doc_id
            outdir = store.OUTPUT / f.stem
            outdir.mkdir(parents=True, exist_ok=True)
            if locked:
                job["error"] = "PDF is password protected - open it in the editor and unlock to make PSDs."
            elif make_psd:
                for p in pdf_to_psds(store.path(doc_id), outdir, PSD_DPI, f.stem):
                    job["outputs"].append(str(p.relative_to(store.OUTPUT)))
            if MAKE_PDF_COPY and f.suffix.lower() != ".pdf":
                shutil.copyfile(pdf, outdir / pdf.name)
                job["outputs"].append(str((outdir / pdf.name).relative_to(store.OUTPUT)))
        shutil.move(str(f), _unique(store.INBOX / "processed", f.name))
        job["status"] = "done"
    except Exception as e:
        job["status"] = "failed"
        job["error"] = f"{type(e).__name__}: {e}"
        traceback.print_exc()
        try:
            dest = _unique(store.INBOX / "failed", f.name)
            shutil.move(str(f), dest)
            dest.with_suffix(dest.suffix + ".log").write_text(traceback.format_exc())
        except Exception:
            pass
    job["finished"] = time.time()
    _save_job(job)
    return job


def _loop(interval=3.0):
    seen: dict[str, tuple] = {}
    while True:
        try:
            for f in sorted(store.INBOX.iterdir()):
                if not f.is_file() or f.name.startswith(".") or f.name.lower().endswith(IGNORE_SUFFIX):
                    continue
                st = f.stat()
                sig = (st.st_size, st.st_mtime)
                if seen.get(str(f)) == sig and st.st_size > 0:  # unchanged for one interval: done copying
                    seen.pop(str(f), None)
                    process(f)
                else:
                    seen[str(f)] = sig
        except Exception:
            traceback.print_exc()
        time.sleep(interval)


def start():
    t = threading.Thread(target=_loop, daemon=True, name="inbox-watcher")
    t.start()
    return t
