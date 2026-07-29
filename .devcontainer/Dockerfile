FROM mcr.microsoft.com/devcontainers/base:3.0.4-ubuntu22.04

RUN apt-get update \
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
