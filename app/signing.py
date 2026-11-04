"""Send for signature: share a private link, the signer signs in the browser,
the result is flattened, given an audit-trail page and sealed with a
tamper-evident digital signature."""
import datetime as dt
import hashlib
import json
import os
import secrets
import shutil
import smtplib
import time
from email.message import EmailMessage
from pathlib import Path

import pymupdf as fitz

from . import engine, store

DIR = store.DATA / "sign"
DIR.mkdir(parents=True, exist_ok=True)
CERT_DIR = store.DATA / "certs"


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _f(token):
    if not token or not all(c.isalnum() or c in "-_" for c in token):
        raise KeyError(token)
    f = DIR / f"{token}.json"
    if not f.exists():
        raise KeyError(token)
    return f


def load(token):
    return json.loads(_f(token).read_text())


def _save(r):
    (DIR / f"{r['token']}.json").write_text(json.dumps(r, indent=1))


def _event(r, what, ip=None, ua=None):
    r["events"].append({"t": time.time(), "what": what, "ip": ip, "ua": (ua or "")[:200]})


# ---------------------------------------------------------------- email

def smtp_ready():
    return bool(os.environ.get("SMTP_HOST"))


def send_mail(to, subject, body, attachment: Path | None = None):
    if not smtp_ready() or not to:
        return False
    msg = EmailMessage()
    msg["From"] = os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER")
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    if attachment:
        msg.add_attachment(attachment.read_bytes(), maintype="application", subtype="pdf", filename=attachment.name)
    port = int(os.environ.get("SMTP_PORT", "587"))
    with (smtplib.SMTP_SSL if port == 465 else smtplib.SMTP)(os.environ["SMTP_HOST"], port, timeout=30) as s:
        if port != 465:
            s.starttls()
        if os.environ.get("SMTP_USER"):
            s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASSWORD", ""))
        s.send_message(msg)
    return True


# ---------------------------------------------------------------- sender side

def create(doc_id, signer_name, signer_email, message, expires_days, base_url, sender="PDF Studio"):
    token = secrets.token_urlsafe(24)
    src = store.path(doc_id)
    shutil.copyfile(src, DIR / f"{token}.pdf")
    m = store.meta(doc_id)
    r = {"token": token, "doc_id": doc_id, "doc_name": m["name"], "signer_name": signer_name.strip(),
         "signer_email": (signer_email or "").strip(), "message": message or "", "sender": sender,
         "created": time.time(), "expires": time.time() + 86400 * int(expires_days or 30),
         "status": "pending", "events": [], "signed_doc_id": None,
         "original_sha256": _sha(DIR / f"{token}.pdf"), "emailed": False}
    _event(r, "created")
    url = f"{base_url.rstrip('/')}/sign/{token}"
    r["url"] = url
    try:
        r["emailed"] = send_mail(r["signer_email"], f"Please sign: {m['name']}",
                                 f"Hi {signer_name},\n\n{sender} has asked you to sign “{m['name']}”.\n\n"
                                 f"{(message + chr(10) + chr(10)) if message else ''}Review and sign here:\n{url}\n\n"
                                 f"This link expires in {int(expires_days or 30)} days.")
    except Exception as e:
        r["email_error"] = str(e)
    _save(r)
    return r


def list_requests():
    out = []
    for f in DIR.glob("*.json"):
        try:
            r = json.loads(f.read_text())
            if r["status"] == "pending" and time.time() > r["expires"]:
                r["status"] = "expired"
            out.append({k: r.get(k) for k in ("token", "doc_id", "doc_name", "signer_name", "signer_email", "status",
                                               "created", "url", "signed_doc_id", "emailed")} |
                       {"last": r["events"][-1] if r["events"] else None})
        except Exception:
            continue
    return sorted(out, key=lambda r: -r["created"])


def cancel(token):
    r = load(token)
    if r["status"] in ("pending", "viewed"):
        r["status"] = "cancelled"
        _event(r, "cancelled by sender")
        _save(r)
    return r


# ---------------------------------------------------------------- signer side

def _check_open(r):
    if r["status"] in ("signed", "declined", "cancelled"):
        return r["status"]
    if time.time() > r["expires"]:
        return "expired"
    return None


def public_info(token, ip=None, ua=None):
    r = load(token)
    closed = _check_open(r)
    if not closed and r["status"] == "pending":
        r["status"] = "viewed"
        _event(r, "opened", ip, ua)
        _save(r)
    d = fitz.open(DIR / f"{token}.pdf")
    fields = [f for f in engine.doc_fields(d) if f["type"] in ("Signature", "Text", "CheckBox", "ComboBox")]
    return {"doc_name": r["doc_name"], "signer_name": r["signer_name"], "message": r["message"], "sender": r["sender"],
            "status": closed or r["status"], "pages": engine.page_info(d), "fields": fields,
            "expires": r["expires"]}


def render(token, pno, scale):
    load(token)
    d = fitz.open(DIR / f"{token}.pdf")
    pix = d[pno].get_pixmap(matrix=fitz.Matrix(scale, scale))
    return pix.tobytes("png")


def decline(token, reason, ip=None, ua=None):
    r = load(token)
    if _check_open(r):
        raise ValueError("This request is no longer open")
    r["status"] = "declined"
    r["decline_reason"] = reason
    _event(r, f"declined: {reason}"[:300], ip, ua)
    _save(r)
    send_mail(os.environ.get("NOTIFY_EMAIL"), f"Declined: {r['doc_name']}",
              f"{r['signer_name']} declined to sign “{r['doc_name']}”.\nReason: {reason}")
    return r


def complete(token, body, ip=None, ua=None):
    r = load(token)
    closed = _check_open(r)
    if closed:
        raise ValueError(f"This request is {closed}")
    if not body.get("agree"):
        raise ValueError("Please agree to sign electronically")
    typed = (body.get("typed_name") or "").strip()
    if not typed:
        raise ValueError("Please type your full name")
    sigs = body.get("signatures") or []
    if not sigs:
        raise ValueError("Add at least one signature")

    d = fitz.open(DIR / f"{token}.pdf")
    vals = {int(k): v for k, v in (body.get("values") or {}).items()}
    sig_xrefs = {int(s["xref"]) for s in sigs if s.get("xref")}
    # fill fields, remove signature widgets that are being signed
    for page in d:
        for w in list(page.widgets() or []):
            if w.xref in sig_xrefs:
                page.delete_widget(w)
            elif w.xref in vals:
                v = vals[w.xref]
                if w.field_type == fitz.PDF_WIDGET_TYPE_CHECKBOX:
                    w.field_value = w.on_state() if v in (True, "true", "on", 1) else "Off"
                else:
                    w.field_value = str(v)
                w.update()
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    for s in sigs:
        page = d[int(s["page"])]
        rect = engine.r_in(page, s["rect"])
        page.insert_image(rect, stream=engine.decode_data_url(s["data"]), keep_proportion=True, rotate=page.rotation)
        if body.get("stamp_date", True):
            fs = max(5, min(8, rect.height * 0.18))
            under = fitz.Rect(rect.x0, rect.y1 + 1, rect.x1 + 80, rect.y1 + fs + 3)
            page.insert_textbox(under, f"{typed} · {stamp}", fontsize=fs, fontname="helv", color=(0.25, 0.25, 0.35))
    d.bake()

    # audit trail page
    first = d[0].rect
    ap = d.new_page(width=first.width, height=first.height)
    y = 60
    ap.insert_text((50, y), "Signature certificate", fontsize=20, fontname="hebo", color=(0.1, 0.1, 0.15))
    y += 28
    ap.draw_line((50, y), (first.width - 50, y), color=(0.88, 0.32, 0.18), width=1.5)
    y += 26
    now = time.time()
    _event(r, "signed", ip, ua)
    rows = [("Document", r["doc_name"]), ("Request ID", token[:16]), ("Sent by", r["sender"]),
            ("Signer", f"{typed}" + (f"  <{r['signer_email']}>" if r["signer_email"] else "")),
            ("Signed at", dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")),
            ("Signer IP", ip or "—"), ("Browser", (ua or "—")[:90]),
            ("Original SHA-256", r["original_sha256"]),
            ("Consent", "Signer agreed to use electronic records and signatures.")]
    for k, v in rows:
        ap.insert_text((50, y), k, fontsize=9, fontname="hebo", color=(0.35, 0.37, 0.45))
        ap.insert_textbox(fitz.Rect(170, y - 9, first.width - 50, y + 30), str(v), fontsize=9, fontname="helv")
        y += 22 if len(str(v)) < 70 else 34
    y += 10
    ap.insert_text((50, y), "Signature", fontsize=9, fontname="hebo", color=(0.35, 0.37, 0.45))
    ap.insert_image(fitz.Rect(170, y - 12, 330, y + 50), stream=engine.decode_data_url(sigs[0]["data"]), keep_proportion=True)
    y += 76
    ap.insert_text((50, y), "History", fontsize=12, fontname="hebo")
    y += 18
    for e in r["events"]:
        t = dt.datetime.fromtimestamp(e["t"], dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        ap.insert_text((50, y), f"{t}   {e['what']}" + (f"   ({e['ip']})" if e.get("ip") else ""), fontsize=8.5, fontname="helv")
        y += 14
    ap.insert_textbox(fitz.Rect(50, first.height - 70, first.width - 50, first.height - 30),
                      "This document has been sealed with a digital signature. Any change made after signing "
                      "invalidates the seal, which PDF readers such as Adobe Acrobat will show.",
                      fontsize=8, fontname="heit", color=(0.4, 0.4, 0.45))
    flat = DIR / f"{token}.signed.pdf"
    d.save(flat, garbage=3, deflate=True)

    final = DIR / f"{token}.final.pdf"
    try:
        seal(flat, final, reason=f"Signed by {typed}")
        r["sealed"] = True
    except Exception as e:
        shutil.copyfile(flat, final)
        r["sealed"] = False
        r["seal_error"] = str(e)
    r["signed_sha256"] = _sha(final)
    r["status"] = "signed"
    r["typed_name"] = typed
    r["signed_at"] = now
    fname = f"{r['doc_name']} (signed by {typed})"
    nice = DIR / f"{''.join(c for c in fname if c not in chr(47) + chr(92) + ':*?<>|')}.pdf"
    shutil.copyfile(final, nice)
    r["signed_doc_id"] = store.create(fname, final, "signature")
    _save(r)
    try:
        if r["signer_email"]:
            send_mail(r["signer_email"], f"Signed: {r['doc_name']}", "Thanks for signing. Your copy is attached.", nice)
        send_mail(os.environ.get("NOTIFY_EMAIL"), f"Signed: {r['doc_name']}",
                  f"{typed} signed “{r['doc_name']}”. The signed copy is in your PDF Studio library and attached.", nice)
    except Exception:
        pass
    nice.unlink(missing_ok=True)
    return r


def signed_file(token):
    r = load(token)
    if r["status"] != "signed":
        raise KeyError(token)
    return DIR / f"{token}.final.pdf", f"{r['doc_name']} (signed).pdf"


# ---------------------------------------------------------------- digital seal

def _signer():
    from pyhanko.sign import signers
    CERT_DIR.mkdir(parents=True, exist_ok=True)
    key_f, cert_f = CERT_DIR / "seal.key.pem", CERT_DIR / "seal.cert.pem"
    if not key_f.exists():
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, os.environ.get("SEAL_NAME", "PDF Studio Signing Seal")),
                          x509.NameAttribute(NameOID.ORGANIZATION_NAME, os.environ.get("SEAL_ORG", "PDF Studio"))])
        now = dt.datetime.now(dt.timezone.utc)
        cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(days=1))
                .not_valid_after(now + dt.timedelta(days=3650))
                .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False,
                                             data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                             crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
                .sign(key, hashes.SHA256()))
        key_f.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                            serialization.NoEncryption()))
        key_f.chmod(0o600)
        cert_f.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return signers.SimpleSigner.load(str(key_f), str(cert_f))


def seal(src: Path, out: Path, reason="Signed"):
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
    from pyhanko.sign import signers
    signer = _signer()
    with open(src, "rb") as fh:
        w = IncrementalPdfFileWriter(fh)
        meta = signers.PdfSignatureMetadata(field_name="PDFStudioSeal", reason=reason, location="PDF Studio")
        with open(out, "wb") as fo:
            signers.sign_pdf(w, meta, signer=signer, output=fo)
