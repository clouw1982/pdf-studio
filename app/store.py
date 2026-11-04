"""Document library with versioned history (undo/redo)."""
import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

DATA = Path(os.environ.get("DATA_DIR", "/data"))
LIB = DATA / "library"
INBOX = DATA / "inbox"
OUTPUT = DATA / "output"
TMP = DATA / "tmp"
MAX_VERSIONS = 60

for _d in (LIB, INBOX, OUTPUT, TMP, INBOX / "processed", INBOX / "failed"):
    _d.mkdir(parents=True, exist_ok=True)

_locks: dict[str, threading.RLock] = {}
_glock = threading.Lock()


def lock(doc_id: str) -> threading.RLock:
    with _glock:
        return _locks.setdefault(doc_id, threading.RLock())


def _dir(doc_id: str) -> Path:
    if not doc_id or "/" in doc_id or ".." in doc_id:
        raise KeyError(doc_id)
    d = LIB / doc_id
    if not d.exists():
        raise KeyError(doc_id)
    return d


def meta(doc_id: str) -> dict:
    return json.loads((_dir(doc_id) / "meta.json").read_text())


def save_meta(doc_id: str, m: dict):
    p = _dir(doc_id) / "meta.json"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(m, indent=1))
    tmp.replace(p)


def create(name: str, pdf_path: Path, source: str = "upload", locked: bool = False) -> str:
    doc_id = uuid.uuid4().hex[:12]
    d = LIB / doc_id
    d.mkdir(parents=True)
    shutil.copyfile(pdf_path, d / "v0001.pdf")
    m = {
        "id": doc_id,
        "name": name,
        "created": time.time(),
        "modified": time.time(),
        "source": source,
        "versions": [{"file": "v0001.pdf", "label": "Original", "t": time.time()}],
        "cur": 0,
        "protect": None,
        "locked": locked,
    }
    (d / "meta.json").write_text(json.dumps(m, indent=1))
    return doc_id


def path(doc_id: str) -> Path:
    m = meta(doc_id)
    return _dir(doc_id) / m["versions"][m["cur"]]["file"]


def new_version_path(doc_id: str) -> Path:
    m = meta(doc_id)
    n = max(int(v["file"][1:5]) for v in m["versions"]) + 1
    return _dir(doc_id) / f"v{n:04d}.pdf"


def commit_file(doc_id: str, file: Path, label: str):
    """Register an already-written file as the next version (drops redo history)."""
    m = meta(doc_id)
    d = _dir(doc_id)
    for v in m["versions"][m["cur"] + 1:]:
        (d / v["file"]).unlink(missing_ok=True)
    m["versions"] = m["versions"][: m["cur"] + 1]
    m["versions"].append({"file": file.name, "label": label, "t": time.time()})
    while len(m["versions"]) > MAX_VERSIONS:
        old = m["versions"].pop(1)  # keep the original
        (d / old["file"]).unlink(missing_ok=True)
    m["cur"] = len(m["versions"]) - 1
    m["modified"] = time.time()
    save_meta(doc_id, m)


def commit_doc(doc_id: str, doc, label: str):
    out = new_version_path(doc_id)
    doc.save(out, garbage=3, deflate=True)
    commit_file(doc_id, out, label)


def undo(doc_id: str) -> bool:
    m = meta(doc_id)
    if m["cur"] == 0:
        return False
    m["cur"] -= 1
    save_meta(doc_id, m)
    return True


def redo(doc_id: str) -> bool:
    m = meta(doc_id)
    if m["cur"] >= len(m["versions"]) - 1:
        return False
    m["cur"] += 1
    save_meta(doc_id, m)
    return True


def restore(doc_id: str, idx: int):
    m = meta(doc_id)
    if 0 <= idx < len(m["versions"]):
        m["cur"] = idx
        save_meta(doc_id, m)


def rename(doc_id: str, name: str):
    m = meta(doc_id)
    m["name"] = name
    save_meta(doc_id, m)


def delete(doc_id: str):
    shutil.rmtree(_dir(doc_id))


def list_docs() -> list[dict]:
    out = []
    for d in LIB.iterdir():
        try:
            m = json.loads((d / "meta.json").read_text())
            out.append({k: m[k] for k in ("id", "name", "created", "modified", "source", "locked")} | {
                "size": (d / m["versions"][m["cur"]]["file"]).stat().st_size})
        except Exception:
            continue
    return sorted(out, key=lambda x: -x["modified"])
