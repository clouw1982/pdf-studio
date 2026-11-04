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

## Image Studio (Photoshop-style editor)

Open it from **🎨 Image Studio** in the header, from **Pages → Edit page in Image Studio**, or from the **Image Studio** button on any image in Edit image mode.

- **Opening a PDF page** splits it into layers: background, one layer per image, and a **live text layer per line**, so you can retype it and change font, size and colour. **Save to PDF** writes the page back with the text still real and searchable. Undo works in PDF Studio as usual.
- **Opens** PSD files (keeping their layers), PNG, JPG, WebP, TIFF, PDF, Word and PowerPoint. Projects are saved on the server.
- **Tools:** move/transform with auto-select and align, rectangle, ellipse and lasso selection, crop with aspect ratios, brush, pencil, eraser, paint bucket, gradient, clone stamp, text, shapes (rectangle, rounded, ellipse, line, arrow), eyedropper, hand and zoom.
- **Layers:** visibility, lock, opacity, 16 blend modes, drag to reorder, rename, duplicate, merge down, merge visible, flatten, rasterize text, flip and rotate.
- **Adjustments:** brightness/contrast, hue/saturation, levels, temperature/tint, exposure/vibrance, threshold, posterize, invert, black & white, sepia, auto levels. All have live previews and respect the selection.
- **Filters:** Gaussian blur, sharpen (unsharp mask), noise, pixelate, vignette, and **✨ AI background removal**, which runs on your own server.
- **Image:** canvas size, image size, crop to selection, trim, rotate and flip the canvas.
- **Export:** PNG, JPEG, WebP, layered PSD, a new PDF, or back into the original page.
- Up to 50 undo steps with a History panel, and Photoshop-style keyboard shortcuts (V M L C B N E G S T U I H Z, [ ], Ctrl+J/E/D/A, Space to pan).

## Batch actions

In **Files**, tick documents and press **Batch…**. Choose any steps — OCR, compress, redact SSNs/emails/phones/cards, watermark, header/footer, page numbers, Bates numbering (continuous across files), rotate, grayscale, flatten, remove hidden info, set author, password protect — and optionally export everything as PDF, Word, Excel, PNG, PSD, text or PDF/A. The results come as a ZIP, which is also saved in `output/batch-…/`. Each step is saved as a version on each file, so it can be undone.

## Send for signature

1. Open a document. Optionally place **signature fields** with *Signatures → Add signature field*, plus any text fields you want filled.
2. Press **Request signature…**, enter the signer's name and email, and send them the private link. It's emailed automatically if SMTP is set up.
3. The signer opens the link on any device. No account is needed. They're guided to each field, draw, type or upload a signature, fill fields, agree, and finish, or they can decline.
4. You get a new file, *“… (signed by Name)”*, in your library. It's flattened and has a **signature certificate page** showing the signer, time, IP address, browser, the original file's SHA-256 hash and an event history. It is also **sealed with a digital signature**, so any later edit shows as tampered in Acrobat and other PDF readers. The status appears in the Signatures panel.

The seal uses a self-signed certificate created on your server (`data/certs/`). It proves the file hasn't changed since signing. Readers will show it as *valid but not trusted* unless you add that certificate as trusted. That's the same as most self-hosted signing tools.

To send emails automatically, add these to `.env` and run `docker compose up -d`:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASSWORD=<app password>
SMTP_FROM=you@gmail.com
NOTIFY_EMAIL=you@gmail.com      # where "signed/declined" notices go
SENDER_NAME=Chris               # default name shown to signers
PUBLIC_URL=https://pdf.example.com   # optional: base URL used in signing links
```

## Visual compare

Tick two files in **Files** and press **Compare 2**. The older file is treated as "before". There are four views:
- **Differences:** a pixel diff, with removed content in red, added content in green, and a box around each changed area that you can click.
- **Side by side**
- **Overlay:** a slider blends one version into the other.
- **Text changes:** a text diff of the whole document.

The page list shows how much each page changed. Sensitivity can be set to high, normal or low.

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
