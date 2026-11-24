#!/usr/bin/env bash
# Retro486 - assembla PROVAJIT.COM (GNU as, nessun altro strumento).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
as --32 provajit.S -o "$T/p.o"
ld -m elf_i386 -Ttext 0x100 --oformat binary -o PROVAJIT.COM "$T/p.o"
ls -l PROVAJIT.COM
