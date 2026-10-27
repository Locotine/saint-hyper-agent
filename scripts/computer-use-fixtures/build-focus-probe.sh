#!/bin/sh
# Build the focus-probe sampler used by fixtures and certification runs to
# prove zero focus theft. Read-only tool; see focus_probe.m for the interface.
set -eu
cd "$(dirname "$0")/../.."
mkdir -p /private/tmp/saint-cua-implementation
/usr/bin/clang -fobjc-arc -O2 -o /private/tmp/saint-cua-implementation/focus-probe \
  scripts/computer-use-fixtures/focus_probe.m \
  -framework AppKit -framework ApplicationServices -framework CoreGraphics
echo "focus-probe build ok"
