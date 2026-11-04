FROM python:3.13-slim

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    DATA_DIR=/data HOME=/tmp

# OCR (tesseract + common languages), PDF/A (ghostscript), Office import (LibreOffice), fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-spa tesseract-ocr-fra tesseract-ocr-deu \
      tesseract-ocr-ita tesseract-ocr-por ghostscript pngquant unpaper qpdf \
      libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui \
      fonts-dejavu fonts-liberation fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core \
      curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app ./app

RUN useradd -u 1000 -m studio && mkdir -p /data && chown studio /data
USER studio
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fs http://localhost:8080/healthz || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*", "--timeout-keep-alive", "120"]
