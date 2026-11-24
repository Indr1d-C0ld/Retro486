/*
 * codegen_backend_wasm.h - WebAssembly backend for 86Box's dynamic recompiler.
 *
 * The backend turns the IR uop stream of a code block into one runtime
 * generated WebAssembly module (see wasm-emit.{h,c} for the module template
 * and codegen_backend_wasm.c for the block lifecycle). The technique comes
 * from PCem-WebAssembly (wasm/jit/, GPLv2); the uop semantics follow 86Box's
 * own arm64 backend.
 *
 * "Host registers" are wasm locals of the per-block function:
 *
 *   local index                 role
 *   ---------------------------------------------------------------
 *   i64   0..1                  scratch
 *   f64   2..9                  FP host regs 0..7 (x87 ST as double; a Q
 *                               sized value is kept bit-for-bit in the same
 *                               local and reinterpreted on use)
 *         10..12                stack slots 40/48/56 (IREG_temp0d..temp2d)
 *         13..14                scratch
 *   i32   15..24                integer host regs 0..9
 *         25..28                stack slots 16/20/24/28 (IREG_temp0..3)
 *         29                    stack slot 32 (FPU TOP difference)
 *         30..33                function arguments ARG0..ARG3
 *         34..39                scratch
 *
 * Licensed under GPLv2 or later, as 86Box itself.
 */
#ifndef _CODEGEN_BACKEND_WASM_H_
#define _CODEGEN_BACKEND_WASM_H_

#define BLOCK_SIZE  0x4000
#define BLOCK_MASK  0x3fff
#define BLOCK_START 0

#define HASH_SIZE   0x20000
#define HASH_MASK   0x1ffff

#define HASH(l)     ((l) &0x1ffff)

#define BLOCK_MAX   0x3c0

#define CODEGEN_HOST_REGS    10
#define CODEGEN_HOST_FP_REGS 8

/* Generic uop emitters may store an immediate straight to memory. */
#define CODEGEN_BACKEND_HAS_MOV_IMM
/* CMP_SET, TEST_SET, BSF, BSR, BSWAP, IMUL, IMUL_HI, IMUL_OV and MUL_HI. */
#define CODEGEN_BACKEND_HAS_INT_UOPS

/* ---- wasm local layout (must match the counts given to the module) ---- */
#define WJIT_N_I64 2
#define WJIT_N_F64 13
#define WJIT_N_I32 25

#define WLOC_SCRATCH_I64_0 0
#define WLOC_SCRATCH_I64_1 1
#define WLOC_FP(hr)        (2 + (hr))
#define WLOC_STACK_F64_40  10
#define WLOC_STACK_F64_48  11
#define WLOC_STACK_F64_56  12
#define WLOC_SCRATCH_F64_0 13
#define WLOC_SCRATCH_F64_1 14
#define WLOC_INT(hr)       (15 + (hr))
#define WLOC_STACK_I32_16  25
#define WLOC_STACK_I32_20  26
#define WLOC_STACK_I32_24  27
#define WLOC_STACK_I32_28  28
#define WLOC_TOPDIFF       29
#define WLOC_ARG(n)        (30 + (n))
#define WLOC_SCRATCH_I32_0 34
#define WLOC_SCRATCH_I32_1 35
#define WLOC_SCRATCH_I32_2 36
#define WLOC_SCRATCH_I32_3 37
#define WLOC_SCRATCH_I32_4 38
#define WLOC_SCRATCH_I32_5 39

/* Sentinel "shared routine" addresses handed to the IR layer; the backend
   recognises them at emit time and inlines the exit / fault path. */
extern void *codegen_exit_rout;
extern void *codegen_gpf_rout;
extern void *codegen_ss_rout;

struct codeblock_t;
struct wasm_emit_t;

/* emit-side surface shared between codegen_backend_wasm.c and *_uops.c */
struct wasm_emit_t *wjit_body(void);
void               *wjit_emit_br_patch(int is_conditional); /* returns the handle stored in uop->p */
void                wjit_call_c(void *fn, int type_id);     /* call_indirect through the table */
void                wjit_note_func_arg(int n);
int                 wjit_take_func_args(void);
void                wjit_reject(const char *why); /* the block being compiled is not kept */
/* pclog() says nothing in release builds: this goes to stderr (the page console) */
void                wjit_log(const char *fmt, ...);

/* The table slot of a compiled block is kept in the first word of its code
   memory (block->data), so that it follows the block's kept versions. */
static inline uint32_t
codegen_wasm_block_fn(const uint8_t *data)
{
    return data ? *(const uint32_t *) data : 0;
}
/* The second word: how many of the block's instructions are calls to the
   interpreter's handlers (a block with any is not replayable by the oracle). */
static inline uint32_t
codegen_wasm_block_callouts(const uint8_t *data)
{
    return data ? ((const uint32_t *) data)[1] : 0;
}
/* Called by the allocator when a block's code memory is handed out/freed. */
void codegen_wasm_mem_alloc(uint8_t *data);
void codegen_wasm_mem_free(uint8_t *data);

/* Hot-block policy (386_dynarec.c): a block is interpreted until it has been
   visited this many times, because a runtime WebAssembly.Module compile costs
   far more than a native block emit. */
extern int      wjit_compile_threshold;
extern int      wjit_min_ins;       /* blocks shorter than this are never compiled */
extern int      wjit_max_callouts;  /* more interpreter call-outs than this: never compiled */
extern int      wjit_call_insns;    /* per-block count of instructions left to the interpreter */
extern int      wjit_max_live;      /* compiled blocks alive at once: each is a wasm module in the browser */
/* statistics */
extern uint32_t wjit_stat_compiled;
extern uint32_t wjit_stat_rejected;
extern uint32_t wjit_stat_failed;
extern uint32_t wjit_stat_cold_runs;
extern uint32_t wjit_stat_freed;
extern uint64_t wjit_stat_runs;

#endif /* _CODEGEN_BACKEND_WASM_H_ */
