FROM python:3.12-slim-bookworm AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng python3-pil \
    && rm -rf /var/lib/apt/lists/*
# Debian's Pillow is used by /usr/bin/python3. xlrd is pure Python, pinned with a wheel hash.
WORKDIR /worker
COPY requirements-parser.txt ./
RUN python -m pip install --no-cache-dir --require-hashes --no-deps --only-binary=:all: --target /opt/parser-deps -r requirements-parser.txt
ARG GIT_SHA
RUN test -n "$GIT_SHA" && echo "$GIT_SHA" | grep -Eq '^[0-9a-f]{40}$' \
    && printf '{"environment":"dev","revision":"%s"}\n' "$GIT_SHA" > manifest.json
COPY extract.py parser.py worker.py ./
USER 65534:65534
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/opt/parser-deps
CMD ["/usr/bin/python3","/worker/worker.py"]

FROM runtime AS qa
USER root
COPY requirements-test.txt ./
RUN python -m pip install --no-cache-dir --require-hashes --no-deps --only-binary=:all: --target /opt/parser-deps -r requirements-test.txt
USER 65534:65534

FROM runtime AS release
