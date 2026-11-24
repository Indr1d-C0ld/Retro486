#!/usr/bin/env bash
# Retro486 - assembla MIDITEST.COM (GNU as, nessun altro strumento).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
as --32 miditest.S -o "$T/m.o"
ld -m elf_i386 -Ttext 0x100 --oformat binary -o MIDITEST.COM "$T/m.o"
ls -l MIDITEST.COM
