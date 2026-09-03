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

set +e
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
    #
    # **The exit code is captured rather than allowed to abort**, and the reason is
    # measured: one failing spec out of 202 used to take the whole run down under
    # `set -e`, so the copy below never ran and two hundred correctly generated
    # baselines were thrown away with the container. The maintainer then saw
    # "nothing was generated" and had no way to tell that from "the container could
    # not start".
    #
    # A failure is still a failure — it is reported and re-raised after the copy, so
    # the run exits non-zero and nobody mistakes this for green. What changes is that
    # the artifacts survive the signal.
    set +e
    npx playwright test --update-snapshots
    suite=$?
    set -e

    # Back out to the host. Only Linux baselines: touching the darwin ones from
    # here would overwrite them with images this container never rendered.
    for dir in visual/__screenshots__/*-linux; do
      [ -d "${dir}" ] || continue
      name="$(basename "${dir}")"
      rm -rf "/out/${name}"
      cp -r "${dir}" "/out/${name}"
    done

    if [ "${suite}" -ne 0 ]; then
      echo "→ the suite exited ${suite}; baselines were still copied out" >&2
      exit "${suite}"
    fi
  '

status=$?

# The same rule one level out: `set -e` would skip the summary below on a failing
# suite, leaving a maintainer with a wall of Playwright output and no statement of
# what landed on disk.
if [ "${status}" -ne 0 ]; then
  echo "→ the suite failed (${status}). Baselines that were generated are still below." >&2
else
  echo "→ done. Baselines written to apps/web/visual/__screenshots__/*-linux"
fi

git -C "${REPO}" status --short apps/web/visual/__screenshots__
exit "${status}"
