#!/usr/bin/env bash
#
# Regenerates the Linux visual baselines, in the same container CI compares against.
#
# Font rasterisation is what makes a screenshot baseline platform-specific, and it
# depends on the fonts and the freetype build available to the browser — not on the
# operating system's name. So "generate on Linux" is not specific enough: the only
# way a maintainer on a Mac can produce baselines a CI runner will agree with is to
# use the *same image*, pinned, on both sides. That image is `PLAYWRIGHT_IMAGE`
# below, and `test/visual-ci.test.ts` fails if it drifts from the Playwright version
# in the lockfile.
#
# The repository is copied into the container rather than mounted, because
# `node_modules` here holds macOS binaries — rollup and esbuild ship per-platform —
# and a Linux Chromium cannot run a build that resolves those. Only the generated
# screenshots come back out.
#
# Usage:  ./scripts/visual-linux.sh
set -euo pipefail

PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.62.1-noble"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running; the Linux baselines can only be generated in the pinned image" >&2
  exit 1
fi

echo "→ generating Linux baselines in ${PLAYWRIGHT_IMAGE}"

docker run --rm \
  -v "${REPO}:/host:ro" \
  -v "${REPO}/apps/web/visual/__screenshots__:/out" \
  -e CI=true \
  -e AF_VISUAL_BROWSER=chromium \
  "${PLAYWRIGHT_IMAGE}" \
  bash -euo pipefail -c '
    mkdir -p /work && cd /work
    tar -C /host --exclude=./node_modules --exclude=./.git --exclude=./dist \
      --exclude=./apps/web/node_modules --exclude=./apps/web/dist \
      --exclude=./coverage -cf - . | tar -xf -

    npm ci --no-audit --no-fund

    cd apps/web
    # The build runs inside the webServer command, so this is the current source by
    # construction. `--update-snapshots` writes only the `-linux` directories: the
    # platform is part of the snapshot path.
    npx playwright test --update-snapshots

    # Back out to the host. Only Linux baselines: touching the darwin ones from
    # here would overwrite them with images this container never rendered.
    for dir in visual/__screenshots__/*-linux; do
      [ -d "${dir}" ] || continue
      name="$(basename "${dir}")"
      rm -rf "/out/${name}"
      cp -r "${dir}" "/out/${name}"
    done
  '

echo "→ done. Baselines written to apps/web/visual/__screenshots__/*-linux"
git -C "${REPO}" status --short apps/web/visual/__screenshots__
