FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data \
    PORT=8080

RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 tracker \
 && mkdir -p /data && chown tracker:tracker /data

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY tracker ./tracker
# history recorded by GitHub Actions so far (copied into an empty volume on first
# start) and the routing graph (data/osm, built by .github/workflows/graph.yml)
COPY data ./seed

USER tracker
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8080\")}/latest.json', timeout=4)" || exit 1

CMD ["python", "-m", "tracker", "serve"]
