#!/usr/bin/env bash
# Retro486 - assembla JOYTEST.COM (GNU as, nessun altro strumento).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
as --32 joytest.S -o "$T/j.o"
ld -m elf_i386 -Ttext 0x100 --oformat binary -o JOYTEST.COM "$T/j.o"
ls -l JOYTEST.COM
