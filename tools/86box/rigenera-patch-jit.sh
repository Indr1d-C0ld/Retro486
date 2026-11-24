#!/usr/bin/env bash
# Retro486: rigenera tools/86box/patch/0002-wasm-jit.patch dalle modifiche fatte nel sottomodulo 86Box
# (vendor/ non è sotto controllo di versione). I sorgenti nuovi del backend stanno in tools/86box/jit/.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")/../.."
git -C vendor/Web86Box/86Box diff -- \
  src/codegen/CMakeLists.txt src/codegen/codegen.c src/codegen/codegen.h \
  src/codegen/codegen_allocator.c src/codegen/codegen_allocator.h src/codegen/codegen_backend.h \
  src/codegen/codegen_block.c src/codegen/codegen_ir_defs.h src/codegen/codegen_ops_helpers.c \
  src/codegen/codegen_ops_helpers.h src/codegen/codegen_ops_jit_wrappers.h src/codegen/codegen_ops_misc.c \
  src/codegen/codegen_ops_arith.c src/codegen/codegen_ops_rep.c src/cpu/386_dynarec.c src/mem/mem.c \
  > tools/86box/patch/0002-wasm-jit.patch
wc -l tools/86box/patch/0002-wasm-jit.patch
