FROM mcr.microsoft.com/devcontainers/base:3-ubuntu22.04

RUN sed --in-place \
        --expression='s|http://archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' \
        --expression='s|http://security.ubuntu.com/ubuntu|https://security.ubuntu.com/ubuntu|g' \
        --expression='s|http://ports.ubuntu.com/ubuntu-ports|https://ports.ubuntu.com/ubuntu-ports|g' \
        /etc/apt/sources.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        build-essential \
        curl \
        file \
        libappindicator3-dev \
        librsvg2-dev \
        libssl-dev \
        libwebkit2gtk-4.1-dev \
        libxdo-dev \
        patchelf \
        pkg-config \
        wget \
    && rm -rf /var/lib/apt/lists/*
