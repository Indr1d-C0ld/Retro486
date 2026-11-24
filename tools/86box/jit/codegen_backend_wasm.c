/*
 * codegen_backend_wasm.c - WebAssembly backend for 86Box's dynamic
 * recompiler: block lifecycle.
 *
 * Model (after PCem-WebAssembly's wasm/jit/codegen_backend_wasm.c, GPLv2)
 * -----
 * Each code block is compiled into ONE runtime generated wasm module holding
 * a single function "f" of type ()->(), which imports the main instance's
 * shared memory and this thread's indirect function table (wasm-emit.c).
 * cpu_state and every C global are addressed with absolute i32.const; any C
 * function pointer value is call_indirect-able. exec386_dynarec_dyn() calls
 * the block through its table index as if it were a C function pointer.
 *
 * The table index of a block lives in the first word of the block's code
 * memory (block->data, handed out by codegen_allocator.c). 86Box keeps
 * earlier versions of a block by keeping their code memory, so the index
 * follows them for free, and the allocator's free path releases the slot.
 *
 * Control flow
 * ------------
 * The IR's jumps are forward only and patched when the destination uop is
 * reached (codegen_set_jump_dest). Handlers emit br/br_if with a fixed width
 * depth placeholder; at epilogue time the body is rewritten once: every label
 * becomes a block/end pair (all blocks open at function entry, the ends at
 * the label positions) and each placeholder gets its real relative depth.
 * Block exits (codegen_exit_rout and the fault routines) are inlined returns:
 * at every exit site the register allocator has already written dirty state
 * back.
 *
 * Threading
 * ---------
 * Blocks compile and run on the emulation ("cpu") pthread only: a function
 * installed in a table is callable only on the thread that installed it. The
 * free list of table slots is in C behind a mutex, so that code memory freed
 * from another thread only recycles a slot number.
 *
 * Licensed under GPLv2 or later, as 86Box itself.
 */
#ifdef __EMSCRIPTEN__

#    include <stdio.h>
#    include <stdlib.h>
#    include <stdint.h>
#    include <string.h>
#    include <math.h>
#    include <pthread.h>
#    include <emscripten.h>
#    include <86box/86box.h>
#    include "cpu.h"
#    include <86box/mem.h>
#    include <86box/plat.h>

#    include "codegen.h"
#    include "codegen_allocator.h"
#    include "codegen_backend.h"
#    include "codegen_ir_defs.h"
#    include "codegen_reg.h"
#    include "x86.h"
#    include "x86seg_common.h"
#    include "x86seg.h"
#    include "x87_sf.h"
#    include "x87.h"

#    include "wasm-emit.h"

/* ---- sentinels the IR hands around as "shared routine" addresses -------- */
static char exit_rout_sentinel;
static char gpf_rout_sentinel;
static char ss_rout_sentinel;
void       *codegen_exit_rout = &exit_rout_sentinel;
void       *codegen_gpf_rout  = &gpf_rout_sentinel;
void       *codegen_ss_rout   = &ss_rout_sentinel;

host_reg_def_t codegen_host_reg_list[CODEGEN_HOST_REGS] = {
    { 0, 0 }, { 1, 0 }, { 2, 0 }, { 3, 0 }, { 4, 0 }, { 5, 0 }, { 6, 0 }, { 7, 0 }, { 8, 0 }, { 9, 0 }
};

host_reg_def_t codegen_host_fp_reg_list[CODEGEN_HOST_FP_REGS] = {
    { 0, 0 }, { 1, 0 }, { 2, 0 }, { 3, 0 }, { 4, 0 }, { 5, 0 }, { 6, 0 }, { 7, 0 }
};

/* ---- emission state ------------------------------------------------------ */

#    define WJIT_BODY_CAP    (1024 * 1024)
#    define WJIT_FINAL_CAP   (WJIT_BODY_CAP + 64 * 1024)
#    define WJIT_MODULE_CAP  (WJIT_FINAL_CAP + 4096)
#    define WJIT_MAX_LABELS  (UOP_NR_MAX + 16)
#    define WJIT_MAX_PATCHES (UOP_NR_MAX * 2 + 32)

typedef struct wjit_patch_t {
    int operand_pos; /* body offset of the 5-byte depth placeholder */
    int label;       /* label index, -1 until bound                 */
    int extra_depth; /* handler-added nesting at the br site        */
} wjit_patch_t;

static wasm_emit_t body_emit;
static uint8_t    *body_buf;
static uint8_t    *final_buf;
static uint8_t    *module_buf;

static int          label_pos[WJIT_MAX_LABELS];
static int          n_labels;
static wjit_patch_t patches[WJIT_MAX_PATCHES];
static int          n_patches;
static int          args_pending;
static int          emit_failed;
static int          block_rejected;
static const char  *reject_reason;

/* table-slot free list */
#    define WJIT_FREE_MAX (MEM_BLOCK_NR + 16)
static uint32_t        free_slots[WJIT_FREE_MAX];
static int             n_free_slots;
static pthread_mutex_t free_slots_mutex = PTHREAD_MUTEX_INITIALIZER;

int      wjit_compile_threshold = 16;
int      wjit_min_ins           = 6;
int      wjit_max_callouts      = 0;
int      wjit_call_insns        = 0;
uint32_t wjit_stat_compiled;
uint32_t wjit_stat_rejected;
uint32_t wjit_stat_failed;
uint32_t wjit_stat_cold_runs;
uint32_t wjit_stat_freed;
uint64_t wjit_stat_runs;
static uint32_t wjit_stat_rej_short;
static uint32_t wjit_stat_rej_callout;
static uint32_t wjit_stat_rej_uop;
static uint64_t wjit_stat_module_bytes;
static double   wjit_stat_compile_ms;

/* Diagnostics for the page (Module._wjit_stats() -> UTF8ToString). */
EMSCRIPTEN_KEEPALIVE const char *
wjit_stats(void)
{
    static char buf[512];

    snprintf(buf, sizeof(buf),
             "{\"dynarec\":%d,\"compiled\":%u,\"rejected\":%u,\"rej_short\":%u,\"rej_callout\":%u,\"rej_uop\":%u,"
             "\"failed\":%u,\"cold_runs\":%u,\"freed\":%u,\"runs\":%.0f,\"module_bytes\":%.0f,\"compile_ms\":%.1f,"
             "\"threshold\":%d,\"min_ins\":%d,\"max_callouts\":%d}",
             cpu_use_dynarec, wjit_stat_compiled, wjit_stat_rejected, wjit_stat_rej_short, wjit_stat_rej_callout,
             wjit_stat_rej_uop, wjit_stat_failed, wjit_stat_cold_runs, wjit_stat_freed, (double) wjit_stat_runs,
             (double) wjit_stat_module_bytes, wjit_stat_compile_ms, wjit_compile_threshold, wjit_min_ins,
             wjit_max_callouts);
    return buf;
}

/* Tuning hook for measurements; a negative value leaves a parameter alone. */
EMSCRIPTEN_KEEPALIVE void
wjit_set_params(int threshold, int min_ins, int max_callouts)
{
    if (threshold > 0)
        wjit_compile_threshold = threshold;
    if (min_ins >= 0)
        wjit_min_ins = min_ins;
    if (max_callouts >= 0)
        wjit_max_callouts = max_callouts;
}

struct wasm_emit_t *
wjit_body(void)
{
    return &body_emit;
}

void
wjit_reject(const char *why)
{
    if (!block_rejected)
        reject_reason = why;
    block_rejected = 1;
}

void
wjit_note_func_arg(int n)
{
    if (n + 1 > args_pending)
        args_pending = n + 1;
}

int
wjit_take_func_args(void)
{
    int n = args_pending;

    args_pending = 0;
    return n;
}

void
wjit_call_c(void *fn, int type_id)
{
    wemit_call_indirect(&body_emit, type_id, (uint32_t) (uintptr_t) fn);
}

/* Emit br (or br_if, condition already on the stack) with a fixed-width
   placeholder depth; returns the handle stored into uop->p. */
void *
wjit_emit_br_patch(int is_conditional)
{
    wjit_patch_t *p;

    if (n_patches >= WJIT_MAX_PATCHES) {
        emit_failed = 1;
        return (void *) 1;
    }
    p = &patches[n_patches];

    wemit_byte(&body_emit, is_conditional ? WOP_BR_IF : WOP_BR);
    p->operand_pos = body_emit.pos;
    p->label       = -1;
    p->extra_depth = body_emit.depth;
    wemit_byte(&body_emit, 0x80);
    wemit_byte(&body_emit, 0x80);
    wemit_byte(&body_emit, 0x80);
    wemit_byte(&body_emit, 0x80);
    wemit_byte(&body_emit, 0x00);

    n_patches++;
    return (void *) (uintptr_t) n_patches; /* index + 1, so 0 stays "no handle" */
}

void
codegen_set_jump_dest(UNUSED(codeblock_t *block), void *p)
{
    int patch_idx = (int) (uintptr_t) p - 1;

    if (patch_idx < 0 || patch_idx >= n_patches || body_emit.depth != 0) {
        emit_failed = 1;
        return;
    }
    /* reuse a label already at this exact position (several jumps here) */
    if (!n_labels || label_pos[n_labels - 1] != body_emit.pos) {
        if (n_labels >= WJIT_MAX_LABELS) {
            emit_failed = 1;
            return;
        }
        label_pos[n_labels++] = body_emit.pos;
    }
    patches[patch_idx].label = n_labels - 1;
}

/* ---- table slots ---------------------------------------------------------- */

void
codegen_wasm_mem_alloc(uint8_t *data)
{
    *(uint32_t *) data = 0;
}

void
codegen_wasm_mem_free(uint8_t *data)
{
    uint32_t idx = *(uint32_t *) data;

    if (!idx)
        return;
    *(uint32_t *) data = 0;
    pthread_mutex_lock(&free_slots_mutex);
    if (n_free_slots < WJIT_FREE_MAX)
        free_slots[n_free_slots++] = idx;
    wjit_stat_freed++;
    pthread_mutex_unlock(&free_slots_mutex);
}

/* ---- prologue / epilogue -------------------------------------------------- */

void
codegen_backend_prologue(codeblock_t *block)
{
    wasm_emit_init(&body_emit, body_buf, WJIT_BODY_CAP);
    n_labels       = 0;
    n_patches      = 0;
    args_pending   = 0;
    emit_failed    = 0;
    block_rejected = 0;
    reject_reason  = NULL;

    block_pos = 0;

    /* TOPDIFF = cpu_state.TOP - block->TOP, for registers addressed
       relative to a top of stack only known when the block runs */
    if (block->flags & CODEBLOCK_HAS_FPU) {
        wemit_read_abs(&body_emit, WOP_I32_LOAD, &cpu_state.TOP);
        wemit_i32_const(&body_emit, block->TOP);
        wemit_op(&body_emit, WOP_I32_SUB);
        wemit_local_set(&body_emit, WLOC_TOPDIFF);
    }
}

static void
block_not_compiled(codeblock_t *block, int permanent)
{
    if (block->data)
        codegen_wasm_mem_free(block->data);
    block->flags &= ~CODEBLOCK_WAS_RECOMPILED;
    if (permanent)
        block->flags |= CODEBLOCK_WASM_NOJIT;
}

void
codegen_backend_epilogue(codeblock_t *block)
{
    int      final_len;
    int      module_len;
    uint32_t idx;
    uint32_t reuse;
    double   t0;

    /* a recompile into memory that still names a slot: release it */
    if (block->data)
        codegen_wasm_mem_free(block->data);

    if (block_rejected) {
        static int logged;

        if (logged < 20) {
            logged++;
            pclog("wasm JIT: block %08x not compiled: %s\n", block->pc, reject_reason ? reject_reason : "?");
        }
        wjit_stat_rejected++;
        wjit_stat_rej_uop++;
        block_not_compiled(block, 1);
        return;
    }

    /* Cost model (PCem-WebAssembly, measured there): a block that leaves
       instructions to the interpreter's handlers, or is only a few
       instructions long, does not win over interpreting it once the call
       through the table, the prologue and the module compile are paid.
       It is interpreted for good. */
    if (wjit_call_insns > wjit_max_callouts) {
        wjit_stat_rejected++;
        wjit_stat_rej_callout++;
        block_not_compiled(block, 1);
        return;
    }
    if (block->ins < wjit_min_ins) {
        wjit_stat_rejected++;
        wjit_stat_rej_short++;
        block_not_compiled(block, 1);
        return;
    }

    if (emit_failed || body_emit.failed || body_emit.depth != 0)
        goto fail;

    for (int pi = 0; pi < n_patches; pi++) {
        if (patches[pi].label < 0)
            goto fail;
    }
    for (int li = 1; li < n_labels; li++) {
        if (label_pos[li] <= label_pos[li - 1])
            goto fail;
    }

    /* depth = (labels ending strictly between the br and its target)
             + nesting recorded at the br site */
    for (int pi = 0; pi < n_patches; pi++) {
        wjit_patch_t *p          = &patches[pi];
        int           target_pos = label_pos[p->label];
        int           depth      = p->extra_depth;
        uint8_t      *leb        = &body_buf[p->operand_pos];

        if (target_pos <= p->operand_pos)
            goto fail; /* forward jumps only */
        for (int li = 0; li < p->label; li++) {
            if (label_pos[li] > p->operand_pos)
                depth++;
        }

        leb[0] = 0x80 | (depth & 0x7f);
        leb[1] = 0x80 | ((depth >> 7) & 0x7f);
        leb[2] = 0x80 | ((depth >> 14) & 0x7f);
        leb[3] = 0x80 | ((depth >> 21) & 0x7f);
        leb[4] = (depth >> 28) & 0x7f;
    }

    /* rebuild: open all label blocks up front, insert an end at each label */
    {
        wasm_emit_t F;
        int         src = 0;

        wasm_emit_init(&F, final_buf, WJIT_FINAL_CAP);
        for (int li = 0; li < n_labels; li++)
            wemit_block(&F);
        for (int li = 0; li < n_labels; li++) {
            wemit_bytes(&F, body_buf + src, label_pos[li] - src);
            src = label_pos[li];
            wemit_end(&F);
        }
        wemit_bytes(&F, body_buf + src, body_emit.pos - src);
        if (F.failed)
            goto fail;
        final_len = F.pos;
    }

    module_len = wasm_emit_wrap_module(final_buf, final_len, WTYPE_V_V, WJIT_N_I64, WJIT_N_F64, WJIT_N_I32,
                                       module_buf, WJIT_MODULE_CAP);
    if (module_len < 0)
        goto fail;

    reuse = 0;
    pthread_mutex_lock(&free_slots_mutex);
    if (n_free_slots)
        reuse = free_slots[--n_free_slots];
    pthread_mutex_unlock(&free_slots_mutex);

    t0  = emscripten_get_now();
    idx = wasm_jit_install_at(module_buf, module_len, reuse);
    wjit_stat_compile_ms += emscripten_get_now() - t0;
    if (!idx) {
        if (reuse) {
            pthread_mutex_lock(&free_slots_mutex);
            if (n_free_slots < WJIT_FREE_MAX)
                free_slots[n_free_slots++] = reuse;
            pthread_mutex_unlock(&free_slots_mutex);
        }
        goto fail;
    }

    *(uint32_t *) block->data = idx;
    wjit_stat_compiled++;
    wjit_stat_module_bytes += module_len;
    return;

fail:
    /* Not runnable and not tried again: correct, just not accelerated. */
    wjit_stat_failed++;
    block_not_compiled(block, 1);
}

/* ---- backend init --------------------------------------------------------- */

void
codegen_backend_init(void)
{
    codeblock      = plat_mmap(BLOCK_SIZE * sizeof(codeblock_t), 0, NULL);
    codeblock_hash = plat_mmap(HASH_SIZE * sizeof(uint32_t), 0, NULL);

    for (int c = 0; c < BLOCK_SIZE; c++)
        codeblock[c].valid = 0;

    if (!body_buf)
        body_buf = malloc(WJIT_BODY_CAP);
    if (!final_buf)
        final_buf = malloc(WJIT_FINAL_CAP);
    if (!module_buf)
        module_buf = malloc(WJIT_MODULE_CAP);
    if (!codeblock || !codeblock_hash || !body_buf || !final_buf || !module_buf)
        fatal("codegen_backend_init: out of memory\n");

    block_current = 0;
    block_pos     = 0;
}

void
codegen_set_rounding_mode(int mode)
{
    if (mode < 0 || mode > 3)
        fatal("codegen_set_rounding_mode - invalid mode\n");
    cpu_state.new_fp_control = mode;
}

/* ---- x87 rounding helpers --------------------------------------------------
   The arm64 backend's conversions (FCVTNS/PS/MS/ZS) saturate and turn a NaN
   into 0; these do the same. */

static double
wjit_fp_round_common(double d)
{
    switch (cpu_state.new_fp_control & 3) {
        default:
        case X87_ROUNDING_NEAREST:
            return nearbyint(d); /* default FE mode: round to nearest even */
        case X87_ROUNDING_UP:
            return ceil(d);
        case X87_ROUNDING_DOWN:
            return floor(d);
        case X87_ROUNDING_CHOP:
            return trunc(d);
    }
}

int32_t
wjit_fp_round(double d)
{
    double r;

    if (d != d)
        return 0;
    r = wjit_fp_round_common(d);
    if (r >= 2147483648.0)
        return INT32_MAX;
    if (r < -2147483648.0)
        return INT32_MIN;
    return (int32_t) r;
}

/* FIST m16: the integer indefinite for a NaN or a value that doesn't fit */
int32_t
wjit_fp_round_w(double d)
{
    int32_t r;

    if (d != d)
        return 0x8000;
    r = wjit_fp_round(d);
    if (r != (int16_t) r)
        return 0x8000;
    return r & 0xffff;
}

int64_t
wjit_fp_round_quad(double d)
{
    double r;

    if (d != d)
        return 0;
    r = wjit_fp_round_common(d);
    if (r >= 9223372036854775808.0)
        return INT64_MAX;
    if (r < -9223372036854775808.0)
        return INT64_MIN;
    return (int64_t) r;
}

#endif /* __EMSCRIPTEN__ */
