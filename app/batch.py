"""Batch actions: run a list of steps over many documents in the background."""
import shutil
import threading
import time
import traceback
import uuid
import zipfile
from pathlib import Path

import pymupdf as fitz

from . import convert, store

JOBS: dict[str, dict] = {}
_lock = threading.Lock()


def start(ids: list[str], steps: list[dict], export: str | None, apply_op, dpi: int = 150) -> dict:
    jid = uuid.uuid4().hex[:10]
    job = {"id": jid, "status": "running", "total": len(ids), "done": 0, "current": None,
           "steps": steps, "export": export, "results": [], "zip": None, "started": time.time(), "finished": None}
    with _lock:
        JOBS[jid] = job
    threading.Thread(target=_run, args=(job, ids, steps, export, apply_op, dpi), daemon=True).start()
    return job


def _run(job, ids, steps, export, apply_op, dpi):
    bates_next = None
    outdir = store.OUTPUT / f"batch-{time.strftime('%Y%m%d-%H%M%S')}"
    exported = []
    for doc_id in ids:
        try:
            name = store.meta(doc_id)["name"]
        except KeyError:
            job["results"].append({"id": doc_id, "name": "?", "ok": False, "error": "Document not found"})
            job["done"] += 1
            continue
        job["current"] = name
        res = {"id": doc_id, "name": name, "ok": True, "notes": []}
        try:
            for st in steps:
                st = dict(st)
                if st.get("op") == "bates":
                    if bates_next is None:
                        bates_next = int(st.get("start", 1))
                    st["start"] = bates_next
                    bates_next += fitz.open(store.path(doc_id)).page_count
                r = apply_op(doc_id, st)
                if st.get("op") == "compress" and r.get("result"):
                    b, a = r["result"]["before"], r["result"]["after"]
                    res["notes"].append(f"compressed {b // 1024}→{a // 1024} KB")
            if export:
                outdir.mkdir(parents=True, exist_ok=True)
                m = store.meta(doc_id)
                stem = "".join(c for c in m["name"] if c not in '/\\:*?"<>|') or doc_id
                src = store.path(doc_id)
                if export == "pdf":
                    f = outdir / f"{stem}.pdf"
                    if m.get("protect"):
                        convert.encrypt_copy(src, f, m["protect"])
                    else:
                        shutil.copyfile(src, f)
                else:
                    tmp = Path(store.TMP) / f"b{job['id']}{doc_id}"
                    tmp.mkdir(parents=True, exist_ok=True)
                    f0 = convert.export(src, export, tmp, stem, {"dpi": dpi})
                    f = outdir / f0.name
                    shutil.move(str(f0), f)
                    shutil.rmtree(tmp, ignore_errors=True)
                exported.append(f)
        except Exception as e:
            traceback.print_exc()
            res["ok"] = False
            res["error"] = getattr(e, "detail", None) or f"{type(e).__name__}: {e}"
        job["results"].append(res)
        job["done"] += 1
    if exported:
        z = outdir.with_suffix(".zip")
        with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in exported:
                zf.write(f, f.name)
        job["zip"] = str(z.relative_to(store.OUTPUT))
        job["folder"] = str(outdir.relative_to(store.OUTPUT))
    job["current"] = None
    job["status"] = "done" if all(r["ok"] for r in job["results"]) else "done_with_errors"
    job["finished"] = time.time()


def get(jid):
    return JOBS.get(jid)


def recent():
    return sorted(JOBS.values(), key=lambda j: -j["started"])[:20]
