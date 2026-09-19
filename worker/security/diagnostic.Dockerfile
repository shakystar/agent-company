FROM agent-company-worker:0.1.0
USER root
RUN apt-get update && apt-get install -y --no-install-recommends strace \
    && rm -rf /var/lib/apt/lists/*
USER node
ENTRYPOINT ["strace"]
