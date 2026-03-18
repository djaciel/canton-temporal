FROM eclipse-temurin:17-jre

ARG CANTON_VERSION=3.4.11

RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Download and extract Canton open-source binaries
RUN curl -fsSL "https://github.com/digital-asset/daml/releases/download/v${CANTON_VERSION}/canton-open-source-${CANTON_VERSION}.tar.gz" \
    -o /tmp/canton.tar.gz && \
    tar -xzf /tmp/canton.tar.gz -C /opt/ && \
    mv /opt/canton-open-source-${CANTON_VERSION} /opt/canton && \
    rm /tmp/canton.tar.gz && \
    chmod +x /opt/canton/bin/canton

WORKDIR /opt/canton

ENTRYPOINT ["/opt/canton/bin/canton"]
