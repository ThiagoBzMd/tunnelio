#!/bin/sh
# Writes packaging/linux/copyright, the .deb's /usr/share/doc/tunnelio/copyright: the project's
# copyright line, then the licence's full text. A GoReleaser hook (.goreleaser.yaml), run from tray/.
set -eu
{
  printf 'Tunnelio\nCopyright (c) 2026 Thiago Bezerra Matias\nLicense: AGPL-3.0-only (the full text follows)\nSource: https://github.com/ThiagoBzMd/tunnelio\n\n'
  cat LICENSE
} > packaging/linux/copyright
