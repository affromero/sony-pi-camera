#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

for tool in git uv node npm cargo shellcheck; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        printf 'Missing %s. See the Development section in SETUP.md.\n' "$tool" >&2
        exit 1
    fi
done

if ! node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    process.exit((major === 22 && minor >= 13) || major >= 24 ? 0 : 1);
'; then
    printf 'Install Node.js 22.13+ (22.x) or 24+ for ESLint.\n' >&2
    exit 1
fi

if command -v rustup >/dev/null 2>&1; then
    rustup component add rustfmt clippy
fi
cargo fmt --version
cargo clippy --version

uv sync --locked --python 3.13 --extra ftps
npm ci --prefix camera/sidedoor
uv run --frozen --extra ftps pre-commit install --install-hooks
