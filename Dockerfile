# The flasher's server (flasher/): the page, its settings (config/flasher.json), the firmware list
# and the checked packages, on 8080. Python's standard library only: no packages to install.
#
# Python 3.15.2 on Debian 13, read from Docker Hub on 10 November 2026 (the tag rebuilt on 7
# November).
FROM docker.io/library/python:3.15.2-slim-trixie@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    FLASHER_HOST=0.0.0.0 FLASHER_PORT=8080 \
    FLASHER_CONFIG=/opt/flasher/config/flasher.json \
    FLASHER_CACHE_DIR=/var/cache/flasher

# Folders made first with their modes, then the files copied in, readable by all. The cache is
# nobody's: downloaded packages, kept by digest, lost with the pod and fetched again.
RUN install -d -m 0755 /opt/flasher /opt/flasher/config \
 && install -d -m 0755 -o 65534 -g 65534 /var/cache/flasher
COPY flasher/ /opt/flasher/flasher/
COPY config/flasher.json /opt/flasher/config/flasher.json
RUN chmod -R a+rX /opt/flasher

USER 65534:65534
WORKDIR /opt/flasher
EXPOSE 8080
ENTRYPOINT ["python3", "-m", "flasher"]
