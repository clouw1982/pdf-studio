# PDF Studio

A self-hosted replacement for Adobe Acrobat that runs on your own server, plus a drop folder that turns any document into layered Photoshop files.

## Install on your Google Cloud VM (Debian or Ubuntu)

```bash
# from your Mac
gcloud compute scp pdfstudio.tar.gz <vm-name>:~ --zone <zone>
gcloud compute ssh <vm-name> --zone <zone>

# on the VM
tar xzf pdfstudio.tar.gz && cd pdfstudio
bash install.sh              # or: bash install.sh --tailscale
```

The installer sets up Docker if it's missing, generates a password, builds the image (the first build takes about 5 minutes), starts the editor, and prints the URL and password. It restarts automatically after a reboot.

**Recommended VM size:** e2-medium (2 vCPU, 4 GB) or larger. OCR and PSD export on long documents run faster with more CPU.

### Reaching it

- **Privately over Tailscale (recommended).** Run `bash install.sh --tailscale` and then open `http://<vm-tailscale-ip>:8080` from any of your devices. To stop it listening publicly, set `BIND_ADDR=<tailscale-ip>` in `.env` and run `docker compose up -d`.
- **Publicly.** Open port 8080 with the firewall commands the installer prints. A password always protects the editor.
- **HTTPS on your own domain.** Point the domain's DNS at the VM, set `DOMAIN=pdf.example.com` in `.env`, open ports 80 and 443, then run `docker compose --profile https up -d`.

## The drop folder → PSD

```
pdfstudio/data/inbox/     ← drop documents here
pdfstudio/data/output/    → <name>/<name>_p001.psd, _p002.psd …
```

You can drop documents in three ways:
1. In the editor, open the **Inbox** tab and drag files onto it (this works from your phone too).
2. From your Mac: `gcloud compute scp *.pdf <vm>:~/pdfstudio/data/inbox/`
3. Over SFTP with any client (Cyberduck, Transmit, Finder via `sshfs`).

The watcher picks up a file once it has finished copying. It converts the file to PDF if needed, adds it to the library so it opens in the editor, and writes one layered PSD per page. Originals move to `inbox/processed/`. Failures go to `inbox/failed/` with a `.log` file explaining why.

**Accepted formats:** PDF, Word, Excel, PowerPoint, OpenDocument, RTF, TXT, Markdown, HTML, CSV, PNG/JPG/TIFF/GIF/WebP/BMP, PSD, ePub, XPS, CBZ and SVG.

**PSD layer structure** (bottom to top):

| Layer | Contents |
|---|---|
| Background | Page colour, fills, lines and vector art, with text and images removed |
| Images / | One layer per placed image, at its exact position |
| Text / | One transparent layer per text block, named after its first words |
| Annotations | Highlights, ink, stamps and comments, if the page has any |
| Original page (reference) | Hidden flattened copy of the page, for checking alignment |

Text layers are pixel layers that separate cleanly from the background, so you can move, recolour or delete them. They are not live Photoshop type layers, because no open-source tool can write those reliably. To change the wording itself, use **Edit text** in the editor first and then export the PSD. Set `PSD_DPI=300` in `.env` for print resolution.

## What the editor does

**Edit**
- Edit existing text in place, including font, size, colour, bold and italic, and multi-line replacements
- Delete lines of text
- Add new text
- Move, resize, replace or delete images
- Add images

**Comment and markup**
- Highlight, underline and strikethrough
- Sticky notes and text boxes
- Freehand drawing, rectangles, ellipses, lines and arrows
- Edit, delete or flatten comments

**Sign and forms**
- Draw, type or upload a signature; up to 6 saved signatures are reused automatically
- Fill existing forms: text fields, checkboxes and dropdowns
- Create new fields: text, checkbox, dropdown, list and signature
- Flatten forms

**Organize pages**
- Drag thumbnails to reorder pages, with multi-select
- Rotate, duplicate, delete and insert blank pages
- Insert another file at any position
- Extract pages to a new file
- Split every N pages or by custom ranges
- Merge files and crop margins
- Resize pages to Letter, A4 or Legal

**Protect**
- AES-256 password protection with print, copy and edit permissions
- Open password-protected PDFs
- True redaction, which removes the text, image pixels and vector art underneath
- Find and redact by exact text, SSNs, emails, phone numbers, card numbers or a custom regex
- Remove hidden information: metadata, JavaScript, hidden text and thumbnails

**Optimize and scan**
- OCR in English, Spanish, French, German, Italian and Portuguese
- Compress at 4 levels
- Convert to grayscale
- PDF/A archival export

**Page design**
- Text or image watermarks
- Page numbers and headers/footers with `{n}`, `{total}`, `{date}` and `{name}`
- Bates numbering
- Background colour

**Convert (Export menu)**
- Layered PSD, Word, Excel (with real table detection), PowerPoint
- PNG, JPEG, TIFF, SVG
- Text, Markdown, HTML, PDF/A

**Everything else**
- Full version history: undo and redo, or restore any earlier version
- Search
- Bookmarks, links and file attachments
- Document properties
- Compare two documents (text diff)
- Read aloud and word count
- Works on a phone
- Keyboard shortcuts: V select, T edit text, I edit image, A add text, S sign, U highlight, N note, D draw, R rectangle, X redact, H pan, Ctrl+Z / Ctrl+Shift+Z, Ctrl+F, Ctrl+± zoom

## Day-to-day

```bash
cd ~/pdfstudio
docker compose logs -f          # watch activity
docker compose restart          # restart
docker compose up -d --build    # after updating the code
docker compose down             # stop
```

All data lives in `pdfstudio/data/`, so back up that folder. The library keeps up to 60 versions per document.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `APP_PASSWORD` | random | Login password |
| `SECRET_KEY` | random | Signs login cookies |
| `PSD_DPI` | 150 | Resolution of inbox PSDs |
| `PORT` / `BIND_ADDR` | 8080 / 0.0.0.0 | Where the editor listens |
| `DOMAIN` | — | For the HTTPS profile |
| `INBOX_PDF_COPY` | 1 | Also put a PDF copy of non-PDF inputs in `output/` |
