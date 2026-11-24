/*
 * codegen_backend_wasm_uops.c - uop handlers of the WebAssembly backend for
 * 86Box's dynamic recompiler. Each handler emits wasm bytecode into the
 * per-block body buffer (codegen_backend_wasm.c).
 *
 * The semantics of every uop are those of 86Box's arm64 backend
 * (codegen_backend_arm64_uops.c); the emission technique is the one of
 * PCem-WebAssembly's wasm backend (GPLv2).
 *
 * Register conventions:
 *   - an integer host reg (an i32 local) holds the FULL 32-bit value of its
 *     IR register; W/B/BH views are read with mask/shift and written by
 *     merging into the old value, as the arm64 backend does with BFI.
 *   - an FP host reg is one f64 local. A D sized value is the double itself;
 *     a Q sized value (ST_i64, MMX) is the same 64 bits, reinterpreted.
 *     f64 locals, loads and stores are bit-preserving in WebAssembly.
 *
 * Nothing is silently mis-executed: an operand combination or uop this file
 * does not implement rejects the block (wjit_reject), which then stays on the
 * interpreter. All MMX/3DNow! uops are in that class.
 *
 * Licensed under GPLv2 or later, as 86Box itself.
 */
#ifdef __EMSCRIPTEN__

#    include <stdint.h>
#    include <86box/86box.h>
#    include "cpu.h"
#    include <86box/mem.h>
#    include <86box/plat_unused.h>

#    include "x86.h"
#    include "x86seg_common.h"
#    include "x86seg.h"
#    include "x87_sf.h"
#    include "x87.h"
#    include "386_common.h"
#    include "codegen.h"
#    include "codegen_backend.h"
#    include "codegen_ir_defs.h"

#    include "wasm-emit.h"

#    define HOST_REG_GET(reg) (IREG_GET_REG(reg) & 0x1f)

#    define REG_IS_L(size)    (size == IREG_SIZE_L)
#    define REG_IS_W(size)    (size == IREG_SIZE_W)
#    define REG_IS_B(size)    (size == IREG_SIZE_B)
#    define REG_IS_BH(size)   (size == IREG_SIZE_BH)
#    define REG_IS_D(size)    (size == IREG_SIZE_D)
#    define REG_IS_Q(size)    (size == IREG_SIZE_Q)

extern int32_t wjit_fp_round(double d);
extern int32_t wjit_fp_round_w(double d);
extern int64_t wjit_fp_round_quad(double d);

#    define E wjit_body()

/* ---- small emit utilities ------------------------------------------------- */

static void e_get(int loc) { wemit_local_get(E, loc); }
static void e_set(int loc) { wemit_local_set(E, loc); }
static void e_tee(int loc) { wemit_local_tee(E, loc); }
static void e_i32(uint32_t v) { wemit_i32_const(E, (int32_t) v); }
static void e_op(uint8_t op) { wemit_op(E, op); }

static int
is_int_size(int size)
{
    return REG_IS_L(size) || REG_IS_W(size) || REG_IS_B(size) || REG_IS_BH(size);
}

static int
size_bits(int size)
{
    return REG_IS_L(size) ? 32 : (REG_IS_W(size) ? 16 : 8);
}

/* push the zero-extended value of a sized integer host reg */
static void
e_src(int sized_reg)
{
    int hr   = HOST_REG_GET(sized_reg);
    int size = IREG_GET_SIZE(sized_reg);

    e_get(WLOC_INT(hr));
    if (REG_IS_W(size)) {
        e_i32(0xffff);
        e_op(WOP_I32_AND);
    } else if (REG_IS_B(size)) {
        e_i32(0xff);
        e_op(WOP_I32_AND);
    } else if (REG_IS_BH(size)) {
        e_i32(8);
        e_op(WOP_I32_SHR_U);
        e_i32(0xff);
        e_op(WOP_I32_AND);
    } else if (!REG_IS_L(size))
        wjit_reject("integer source of FP size");
}

/* push the value of a sized integer host reg, sign extended to 32 bits */
static void
e_src_sx(int sized_reg)
{
    int hr   = HOST_REG_GET(sized_reg);
    int size = IREG_GET_SIZE(sized_reg);

    e_get(WLOC_INT(hr));
    if (REG_IS_W(size))
        e_op(WOP_I32_EXTEND16_S);
    else if (REG_IS_B(size))
        e_op(WOP_I32_EXTEND8_S);
    else if (REG_IS_BH(size)) {
        e_i32(8);
        e_op(WOP_I32_SHR_U);
        e_op(WOP_I32_EXTEND8_S);
    } else if (!REG_IS_L(size))
        wjit_reject("integer source of FP size");
}

/* push the value of a sized integer host reg shifted up to bit 31, so that
   every comparison works on any size (the arm64 backend's LSL 16/24) */
static void
e_src_top(int sized_reg)
{
    int size = IREG_GET_SIZE(sized_reg);

    if (REG_IS_L(size))
        e_get(WLOC_INT(HOST_REG_GET(sized_reg)));
    else {
        e_src(sized_reg);
        e_i32(32 - size_bits(size));
        e_op(WOP_I32_SHL);
    }
}

/* merge the value on the wasm stack into a sized integer host reg */
static void
e_dst(int sized_reg)
{
    int hr   = HOST_REG_GET(sized_reg);
    int size = IREG_GET_SIZE(sized_reg);

    if (REG_IS_L(size)) {
        e_set(WLOC_INT(hr));
    } else if (REG_IS_W(size)) {
        e_i32(0xffff);
        e_op(WOP_I32_AND);
        e_get(WLOC_INT(hr));
        e_i32(0xffff0000);
        e_op(WOP_I32_AND);
        e_op(WOP_I32_OR);
        e_set(WLOC_INT(hr));
    } else if (REG_IS_B(size)) {
        e_i32(0xff);
        e_op(WOP_I32_AND);
        e_get(WLOC_INT(hr));
        e_i32(0xffffff00);
        e_op(WOP_I32_AND);
        e_op(WOP_I32_OR);
        e_set(WLOC_INT(hr));
    } else if (REG_IS_BH(size)) {
        e_i32(0xff);
        e_op(WOP_I32_AND);
        e_i32(8);
        e_op(WOP_I32_SHL);
        e_get(WLOC_INT(hr));
        e_i32(0xffff00ff);
        e_op(WOP_I32_AND);
        e_op(WOP_I32_OR);
        e_set(WLOC_INT(hr));
    } else {
        e_op(WOP_DROP);
        wjit_reject("integer destination of FP size");
    }
}

/* FP host regs: the double, or its 64 bits */
static void e_fget(int sized_reg) { e_get(WLOC_FP(HOST_REG_GET(sized_reg))); }
static void e_fset(int sized_reg) { e_set(WLOC_FP(HOST_REG_GET(sized_reg))); }
static void
e_qget(int sized_reg)
{
    e_get(WLOC_FP(HOST_REG_GET(sized_reg)));
    e_op(WOP_I64_REINTERPRET_F64);
}
static void
e_qset(int sized_reg)
{
    e_op(WOP_F64_REINTERPRET_I64);
    e_set(WLOC_FP(HOST_REG_GET(sized_reg)));
}

static void
e_return_if(void)
{
    wemit_if(E);
    e_op(WOP_RETURN);
    wemit_end(E);
}

/* if (cpu_state.abrt) return; */
static void
e_abrt_check_exit(void)
{
    wemit_read_abs(E, WOP_I32_LOAD8_U, &cpu_state.abrt);
    e_return_if();
}

/* the inlined body of one of the shared exit routines; never falls through */
static void
e_jump_to_sentinel(void *p)
{
    if (p == codegen_exit_rout)
        e_op(WOP_RETURN);
    else if (p == codegen_gpf_rout) {
        e_i32(0);
        e_i32(0);
        wjit_call_c((void *) x86gpf, WTYPE_II_V);
        e_op(WOP_RETURN);
    } else if (p == codegen_ss_rout) {
        e_i32(0);
        e_i32(0);
        wjit_call_c((void *) x86ss, WTYPE_II_V);
        e_op(WOP_RETURN);
    } else {
        wjit_reject("jump to unknown routine");
        e_op(WOP_RETURN);
    }
}

static int
codegen_UNIMPLEMENTED(UNUSED(codeblock_t *block), UNUSED(uop_t *uop))
{
    wjit_reject("uop not implemented by the wasm backend");
    return 0;
}

static int
codegen_MMX(UNUSED(codeblock_t *block), UNUSED(uop_t *uop))
{
    wjit_reject("MMX/3DNow! uop");
    return 0;
}

/* ---- generic ALU ----------------------------------------------------------- */

static int
gen_alu2(uop_t *uop, uint8_t i32_op, int has_q)
{
    int dest_size  = IREG_GET_SIZE(uop->dest_reg_a_real);
    int src_size_a = IREG_GET_SIZE(uop->src_reg_a_real);
    int src_size_b = IREG_GET_SIZE(uop->src_reg_b_real);

    if (is_int_size(dest_size) && is_int_size(src_size_a) && is_int_size(src_size_b)) {
        e_src(uop->src_reg_a_real);
        e_src(uop->src_reg_b_real);
        e_op(i32_op);
        e_dst(uop->dest_reg_a_real);
    } else if (has_q)
        wjit_reject("MMX logic uop");
    else
        wjit_reject("ALU operand sizes");
    return 0;
}

static int
gen_alu_imm(uop_t *uop, uint8_t i32_op)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);
    int src_size  = IREG_GET_SIZE(uop->src_reg_a_real);

    if (is_int_size(dest_size) && is_int_size(src_size)) {
        e_src(uop->src_reg_a_real);
        e_i32(uop->imm_data);
        e_op(i32_op);
        e_dst(uop->dest_reg_a_real);
    } else
        wjit_reject("ALU immediate operand sizes");
    return 0;
}

static int codegen_ADD(UNUSED(codeblock_t *block), uop_t *uop) { return gen_alu2(uop, WOP_I32_ADD, 0); }
static int codegen_ADD_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_alu_imm(uop, WOP_I32_ADD); }
static int codegen_AND(UNUSED(codeblock_t *block), uop_t *uop) { return gen_alu2(uop, WOP_I32_AND, 1); }
static int codegen_AND_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_alu_imm(uop, WOP_I32_AND); }
static int codegen_OR(UNUSED(codeblock_t *block), uop_t *uop) { return gen_alu2(uop, WOP_I32_OR, 1); }
static int codegen_OR_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_alu_imm(uop, WOP_I32_OR); }
static int codegen_SUB(UNUSED(codeblock_t *block), uop_t *uop) { return gen_alu2(uop, WOP_I32_SUB, 0); }
static int codegen_SUB_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_alu_imm(uop, WOP_I32_SUB); }
static int codegen_XOR(UNUSED(codeblock_t *block), uop_t *uop) { return gen_alu2(uop, WOP_I32_XOR, 1); }
static int codegen_XOR_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_alu_imm(uop, WOP_I32_XOR); }

/* dest = src_a + (src_b << imm): effective addresses, whole registers */
static int
codegen_ADD_LSHIFT(UNUSED(codeblock_t *block), uop_t *uop)
{
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_a_real)));
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_b_real)));
    if (uop->imm_data) {
        e_i32(uop->imm_data);
        e_op(WOP_I32_SHL);
    }
    e_op(WOP_I32_ADD);
    e_set(WLOC_INT(HOST_REG_GET(uop->dest_reg_a_real)));
    return 0;
}

/* ---- calls ----------------------------------------------------------------- */

/* The exact wasm type of every C function the IR calls by address:
   call_indirect traps on a mismatch. The arrays make the compiler check the
   prototypes. Functions not listed here are local to a codegen_ops_*.c file
   (flag helpers and their noinline wrappers) and take no arguments. */
static void (*const fns_v_v[])(void)                 = { fpu_postamble };
static void (*const fns_int_v[])(int)                = { x86_int };
static void (*const fns_u16_v[])(uint16_t)           = { loadcs, x87_ferr_nowait };
static void (*const fns_u16_u32_v[])(uint16_t, uint32_t) = { loadcsjmp };
static int (*const fns_v_i[])(void)                  = { codegen_mmx_enter, codegen_femms, codegen_mmx_fpu_pending,
                                                         codegen_fp_enter, codegen_fp_pending, x87_legacy_pending,
                                                         x87_legacy_pending_entry };

#    define FN_IN(list, fn) fn_in((void *const *) (list), sizeof(list) / sizeof((list)[0]), fn)
static int
fn_in(void *const *list, int nr, void *fn)
{
    for (int c = 0; c < nr; c++) {
        if (list[c] == fn)
            return 1;
    }
    return 0;
}

static const int type_nargs[WTYPE_COUNT] = {
    [WTYPE_V_V] = 0, [WTYPE_I_V] = 1, [WTYPE_II_V] = 2, [WTYPE_V_I] = 0
};

/* -1: unknown */
static int
call_type(void *fn, int nargs, int has_result)
{
    int type = -1;

    if (FN_IN(fns_v_v, fn))
        type = WTYPE_V_V;
    else if (FN_IN(fns_int_v, fn) || FN_IN(fns_u16_v, fn))
        type = WTYPE_I_V;
    else if (FN_IN(fns_u16_u32_v, fn))
        type = WTYPE_II_V;
    else if (FN_IN(fns_v_i, fn))
        type = WTYPE_V_I;
    else if (!nargs)
        type = has_result ? WTYPE_V_I : WTYPE_V_V;

    if (type < 0)
        return -1;
    if (type_nargs[type] != nargs)
        return -1;
    if (has_result != (type == WTYPE_V_I))
        return -1;
    return type;
}

static void
e_push_args(int nargs)
{
    for (int i = 0; i < nargs; i++)
        e_get(WLOC_ARG(i));
}

static int
codegen_CALL_FUNC(UNUSED(codeblock_t *block), uop_t *uop)
{
    int nargs = wjit_take_func_args();
    int type  = call_type(uop->p, nargs, 0);

    if (type < 0) {
        wjit_reject("CALL_FUNC to a function of unknown type");
        return 0;
    }
    e_push_args(nargs);
    wjit_call_c(uop->p, type);
    return 0;
}

static int
codegen_CALL_FUNC_RESULT(UNUSED(codeblock_t *block), uop_t *uop)
{
    int nargs     = wjit_take_func_args();
    int type      = call_type(uop->p, nargs, 1);
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);

    if (type < 0 || !REG_IS_L(dest_size)) {
        wjit_reject("CALL_FUNC_RESULT to a function of unknown type");
        return 0;
    }
    e_push_args(nargs);
    wjit_call_c(uop->p, type);
    e_set(WLOC_INT(HOST_REG_GET(uop->dest_reg_a_real)));
    return 0;
}

/* p(imm_data): an instruction handler; a non-zero return leaves the block */
static int
codegen_CALL_INSTRUCTION_FUNC(UNUSED(codeblock_t *block), uop_t *uop)
{
    (void) wjit_take_func_args();
    e_i32(uop->imm_data);
    wjit_call_c(uop->p, WTYPE_I_I);
    e_return_if();
    return 0;
}

static int
gen_load_func_arg(uop_t *uop, int n)
{
    int src_size = IREG_GET_SIZE(uop->src_reg_a_real);

    if (!is_int_size(src_size)) {
        wjit_reject("LOAD_FUNC_ARG size");
        return 0;
    }
    e_src(uop->src_reg_a_real);
    e_set(WLOC_ARG(n));
    wjit_note_func_arg(n);
    return 0;
}
static int codegen_LOAD_FUNC_ARG0(UNUSED(codeblock_t *block), uop_t *uop) { return gen_load_func_arg(uop, 0); }
static int codegen_LOAD_FUNC_ARG1(UNUSED(codeblock_t *block), uop_t *uop) { return gen_load_func_arg(uop, 1); }
static int codegen_LOAD_FUNC_ARG2(UNUSED(codeblock_t *block), uop_t *uop) { return gen_load_func_arg(uop, 2); }
static int codegen_LOAD_FUNC_ARG3(UNUSED(codeblock_t *block), uop_t *uop) { return gen_load_func_arg(uop, 3); }

static int
gen_load_func_arg_imm(uop_t *uop, int n)
{
    e_i32(uop->imm_data);
    e_set(WLOC_ARG(n));
    wjit_note_func_arg(n);
    return 0;
}
static int codegen_LOAD_FUNC_ARG0_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_load_func_arg_imm(uop, 0); }
static int codegen_LOAD_FUNC_ARG1_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_load_func_arg_imm(uop, 1); }
static int codegen_LOAD_FUNC_ARG2_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_load_func_arg_imm(uop, 2); }
static int codegen_LOAD_FUNC_ARG3_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_load_func_arg_imm(uop, 3); }

static int
codegen_LOAD_SEG(UNUSED(codeblock_t *block), uop_t *uop)
{
    int (*fn)(uint16_t, x86seg *) = loadseg;
    int src_size                  = IREG_GET_SIZE(uop->src_reg_a_real);

    if (!REG_IS_W(src_size)) {
        wjit_reject("LOAD_SEG size");
        return 0;
    }
    e_src(uop->src_reg_a_real);
    e_i32((uint32_t) (uintptr_t) uop->p);
    wjit_call_c((void *) fn, WTYPE_II_I);
    e_return_if();
    return 0;
}

/* ---- jumps ----------------------------------------------------------------- */

static int
codegen_JMP(UNUSED(codeblock_t *block), uop_t *uop)
{
    e_jump_to_sentinel(uop->p);
    return 0;
}

static int
codegen_CMP_IMM_JZ(UNUSED(codeblock_t *block), uop_t *uop)
{
    int src_size = IREG_GET_SIZE(uop->src_reg_a_real);

    if (!REG_IS_L(src_size)) {
        wjit_reject("CMP_IMM_JZ size");
        return 0;
    }
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_a_real)));
    e_i32(uop->imm_data);
    e_op(WOP_I32_EQ);
    wemit_if(E);
    e_jump_to_sentinel(uop->p);
    wemit_end(E);
    return 0;
}

static int
gen_cmp_jcc_abs(uop_t *uop, uint8_t cmp_op)
{
    int src_size_a = IREG_GET_SIZE(uop->src_reg_a_real);
    int src_size_b = IREG_GET_SIZE(uop->src_reg_b_real);

    if (!(REG_IS_L(src_size_a) && REG_IS_L(src_size_b))) {
        wjit_reject("CMP_JB/CMP_JNBE size");
        return 0;
    }
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_a_real)));
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_b_real)));
    e_op(cmp_op);
    wemit_if(E);
    e_jump_to_sentinel(uop->p);
    wemit_end(E);
    return 0;
}
static int codegen_CMP_JB(UNUSED(codeblock_t *block), uop_t *uop) { return gen_cmp_jcc_abs(uop, WOP_I32_LT_U); }
static int codegen_CMP_JNBE(UNUSED(codeblock_t *block), uop_t *uop) { return gen_cmp_jcc_abs(uop, WOP_I32_GT_U); }

/* if (src < lo || src + imm > hi), unsigned, jump to the routine */
static int
codegen_CMP_JNWITHIN(UNUSED(codeblock_t *block), uop_t *uop)
{
    int src_size = IREG_GET_SIZE(uop->src_reg_a_real);
    int lo_size  = IREG_GET_SIZE(uop->src_reg_b_real);
    int hi_size  = IREG_GET_SIZE(uop->src_reg_c_real);

    if (!(REG_IS_L(src_size) && REG_IS_L(lo_size) && REG_IS_L(hi_size))) {
        wjit_reject("CMP_JNWITHIN size");
        return 0;
    }
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_a_real)));
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_b_real)));
    e_op(WOP_I32_LT_U);
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_a_real)));
    if (uop->imm_data) {
        e_i32(uop->imm_data);
        e_op(WOP_I32_ADD);
    }
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_c_real)));
    e_op(WOP_I32_GT_U);
    e_op(WOP_I32_OR);
    wemit_if(E);
    e_jump_to_sentinel(uop->p);
    wemit_end(E);
    return 0;
}

/* if (lo < src < hi), all ordered, jump */
static int
codegen_FCMP_JWITHIN_DEST(UNUSED(codeblock_t *block), uop_t *uop)
{
    int src_size = IREG_GET_SIZE(uop->src_reg_a_real);
    int lo_size  = IREG_GET_SIZE(uop->src_reg_b_real);
    int hi_size  = IREG_GET_SIZE(uop->src_reg_c_real);

    if (!(REG_IS_D(src_size) && REG_IS_D(lo_size) && REG_IS_D(hi_size))) {
        wjit_reject("FCMP_JWITHIN_DEST size");
        return 0;
    }
    e_fget(uop->src_reg_a_real);
    e_fget(uop->src_reg_b_real);
    e_op(WOP_F64_GT);
    e_fget(uop->src_reg_c_real);
    e_fget(uop->src_reg_a_real);
    e_op(WOP_F64_GT);
    e_op(WOP_I32_AND);
    uop->p = wjit_emit_br_patch(1);
    return 0;
}

/* The condition uop_cc_t cc of (a CMP b), a and b shifted up to bit 31,
   as an i32 0/1 on the wasm stack. Uses scratch locals 0 and 1. */
static void
e_cond_top(int cc)
{
    static const uint8_t cmp_op[16] = {
        [UOP_CC_B] = WOP_I32_LT_U, [UOP_CC_NB] = WOP_I32_GE_U,
        [UOP_CC_Z] = WOP_I32_EQ, [UOP_CC_NZ] = WOP_I32_NE,
        [UOP_CC_BE] = WOP_I32_LE_U, [UOP_CC_NBE] = WOP_I32_GT_U,
        [UOP_CC_L] = WOP_I32_LT_S, [UOP_CC_NL] = WOP_I32_GE_S,
        [UOP_CC_LE] = WOP_I32_LE_S, [UOP_CC_NLE] = WOP_I32_GT_S
    };

    /* stack: a b */
    switch (cc) {
        case UOP_CC_O:
        case UOP_CC_NO:
            /* V of a - b = ((a ^ b) & (a ^ (a - b))) >> 31 */
            e_set(WLOC_SCRATCH_I32_1);
            e_tee(WLOC_SCRATCH_I32_0);
            e_get(WLOC_SCRATCH_I32_1);
            e_op(WOP_I32_XOR);
            e_get(WLOC_SCRATCH_I32_0);
            e_get(WLOC_SCRATCH_I32_0);
            e_get(WLOC_SCRATCH_I32_1);
            e_op(WOP_I32_SUB);
            e_op(WOP_I32_XOR);
            e_op(WOP_I32_AND);
            e_i32(31);
            e_op(WOP_I32_SHR_U);
            if (cc == UOP_CC_NO)
                e_op(WOP_I32_EQZ);
            break;

        case UOP_CC_S:
        case UOP_CC_NS:
            /* N of a - b */
            e_op(WOP_I32_SUB);
            e_i32(31);
            e_op(WOP_I32_SHR_U);
            if (cc == UOP_CC_NS)
                e_op(WOP_I32_EQZ);
            break;

        default:
            if (!cmp_op[cc & 0xf]) {
                wjit_reject("condition code");
                e_op(WOP_I32_EQ);
            } else
                e_op(cmp_op[cc & 0xf]);
            break;
    }
}

static int
gen_cmp_jcc_dest(uop_t *uop, int cc)
{
    int src_size_a = IREG_GET_SIZE(uop->src_reg_a_real);
    int src_size_b = IREG_GET_SIZE(uop->src_reg_b_real);

    if (!is_int_size(src_size_a) || REG_IS_BH(src_size_a) || (src_size_a != src_size_b)) {
        wjit_reject("CMP_Jcc_DEST sizes");
        return 0;
    }
    e_src_top(uop->src_reg_a_real);
    e_src_top(uop->src_reg_b_real);
    e_cond_top(cc);
    uop->p = wjit_emit_br_patch(1);
    return 0;
}

#    define CMP_JCC_DEST(NAME, cc)                                 \
        static int codegen_CMP_##NAME##_DEST(UNUSED(codeblock_t *block), uop_t *uop) \
        {                                                          \
            return gen_cmp_jcc_dest(uop, cc);                      \
        }
CMP_JCC_DEST(JB, UOP_CC_B)
CMP_JCC_DEST(JNB, UOP_CC_NB)
CMP_JCC_DEST(JBE, UOP_CC_BE)
CMP_JCC_DEST(JNBE, UOP_CC_NBE)
CMP_JCC_DEST(JL, UOP_CC_L)
CMP_JCC_DEST(JNL, UOP_CC_NL)
CMP_JCC_DEST(JLE, UOP_CC_LE)
CMP_JCC_DEST(JNLE, UOP_CC_NLE)
CMP_JCC_DEST(JZ, UOP_CC_Z)
CMP_JCC_DEST(JNZ, UOP_CC_NZ)
CMP_JCC_DEST(JO, UOP_CC_O)
CMP_JCC_DEST(JNO, UOP_CC_NO)

static int
gen_cmp_imm_jcc_dest(uop_t *uop, uint8_t cmp_op)
{
    int src_size = IREG_GET_SIZE(uop->src_reg_a_real);

    if (!(REG_IS_L(src_size) || REG_IS_W(src_size))) {
        wjit_reject("CMP_IMM_Jcc_DEST size");
        return 0;
    }
    e_src(uop->src_reg_a_real);
    e_i32(uop->imm_data);
    e_op(cmp_op);
    uop->p = wjit_emit_br_patch(1);
    return 0;
}
static int codegen_CMP_IMM_JZ_DEST(UNUSED(codeblock_t *block), uop_t *uop) { return gen_cmp_imm_jcc_dest(uop, WOP_I32_EQ); }
static int codegen_CMP_IMM_JNZ_DEST(UNUSED(codeblock_t *block), uop_t *uop) { return gen_cmp_imm_jcc_dest(uop, WOP_I32_NE); }

static int
gen_test_js_dest(uop_t *uop, int jump_if_set)
{
    int src_size = IREG_GET_SIZE(uop->src_reg_a_real);

    if (!is_int_size(src_size) || REG_IS_BH(src_size)) {
        wjit_reject("TEST_JS/JNS_DEST size");
        return 0;
    }
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_a_real)));
    e_i32(1u << (size_bits(src_size) - 1));
    e_op(WOP_I32_AND);
    if (!jump_if_set)
        e_op(WOP_I32_EQZ);
    uop->p = wjit_emit_br_patch(1);
    return 0;
}
static int codegen_TEST_JS_DEST(UNUSED(codeblock_t *block), uop_t *uop) { return gen_test_js_dest(uop, 1); }
static int codegen_TEST_JNS_DEST(UNUSED(codeblock_t *block), uop_t *uop) { return gen_test_js_dest(uop, 0); }

/* ---- integer uops of CODEGEN_BACKEND_HAS_INT_UOPS ---------------------------- */

static int
codegen_CMP_SET(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size  = IREG_GET_SIZE(uop->dest_reg_a_real);
    int src_size_a = IREG_GET_SIZE(uop->src_reg_a_real);
    int src_size_b = IREG_GET_SIZE(uop->src_reg_b_real);

    if (!is_int_size(src_size_a) || REG_IS_BH(src_size_a) || (src_size_a != src_size_b) || !REG_IS_L(dest_size)) {
        wjit_reject("CMP_SET sizes");
        return 0;
    }
    e_src_top(uop->src_reg_a_real);
    e_src_top(uop->src_reg_b_real);
    e_cond_top(uop->imm_data & 0xf);
    e_set(WLOC_INT(HOST_REG_GET(uop->dest_reg_a_real)));
    return 0;
}

static int
codegen_TEST_SET(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);
    int src_size  = IREG_GET_SIZE(uop->src_reg_a_real);

    if (!is_int_size(src_size) || REG_IS_BH(src_size) || !REG_IS_L(dest_size)) {
        wjit_reject("TEST_SET sizes");
        return 0;
    }
    e_src_top(uop->src_reg_a_real);
    e_i32(0);
    e_cond_top(uop->imm_data & 0xf);
    e_set(WLOC_INT(HOST_REG_GET(uop->dest_reg_a_real)));
    return 0;
}

static int
all_l(uop_t *uop, int nsrc)
{
    if (!REG_IS_L(IREG_GET_SIZE(uop->dest_reg_a_real)) || !REG_IS_L(IREG_GET_SIZE(uop->src_reg_a_real)))
        return 0;
    if ((nsrc > 1) && !REG_IS_L(IREG_GET_SIZE(uop->src_reg_b_real)))
        return 0;
    return 1;
}

static int
codegen_BSWAP(UNUSED(codeblock_t *block), uop_t *uop)
{
    int src = WLOC_INT(HOST_REG_GET(uop->src_reg_a_real));

    if (!all_l(uop, 1)) {
        wjit_reject("BSWAP sizes");
        return 0;
    }
    e_get(src);
    e_i32(8);
    e_op(WOP_I32_ROTL);
    e_i32(0x00ff00ff);
    e_op(WOP_I32_AND);
    e_get(src);
    e_i32(8);
    e_op(WOP_I32_ROTR);
    e_i32(0xff00ff00);
    e_op(WOP_I32_AND);
    e_op(WOP_I32_OR);
    e_set(WLOC_INT(HOST_REG_GET(uop->dest_reg_a_real)));
    return 0;
}

static int
codegen_IMUL(UNUSED(codeblock_t *block), uop_t *uop)
{
    if (!all_l(uop, 2)) {
        wjit_reject("IMUL sizes");
        return 0;
    }
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_a_real)));
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_b_real)));
    e_op(WOP_I32_MUL);
    e_set(WLOC_INT(HOST_REG_GET(uop->dest_reg_a_real)));
    return 0;
}

static void
e_mul64(uop_t *uop, int is_signed)
{
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_a_real)));
    e_op(is_signed ? WOP_I64_EXTEND_I32_S : WOP_I64_EXTEND_I32_U);
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_b_real)));
    e_op(is_signed ? WOP_I64_EXTEND_I32_S : WOP_I64_EXTEND_I32_U);
    e_op(WOP_I64_MUL);
}

/* 1 if the signed 64-bit product isn't its low word sign extended */
static int
codegen_IMUL_OV(UNUSED(codeblock_t *block), uop_t *uop)
{
    if (!all_l(uop, 2)) {
        wjit_reject("IMUL_OV sizes");
        return 0;
    }
    e_mul64(uop, 1);
    e_tee(WLOC_SCRATCH_I64_0);
    e_get(WLOC_SCRATCH_I64_0);
    e_op(WOP_I32_WRAP_I64);
    e_op(WOP_I64_EXTEND_I32_S);
    e_op(WOP_I64_NE);
    e_set(WLOC_INT(HOST_REG_GET(uop->dest_reg_a_real)));
    return 0;
}

static int
gen_mul_hi(uop_t *uop, int is_signed)
{
    if (!all_l(uop, 2)) {
        wjit_reject("MUL_HI sizes");
        return 0;
    }
    e_mul64(uop, is_signed);
    wemit_i64_const(E, 32);
    e_op(WOP_I64_SHR_U);
    e_op(WOP_I32_WRAP_I64);
    e_set(WLOC_INT(HOST_REG_GET(uop->dest_reg_a_real)));
    return 0;
}
static int codegen_MUL_HI(UNUSED(codeblock_t *block), uop_t *uop) { return gen_mul_hi(uop, 0); }
static int codegen_IMUL_HI(UNUSED(codeblock_t *block), uop_t *uop) { return gen_mul_hi(uop, 1); }

/* dest = src_a ? index of its lowest/highest set bit : src_b */
static int
gen_bs(uop_t *uop, int reverse)
{
    int src = WLOC_INT(HOST_REG_GET(uop->src_reg_a_real));

    if (!all_l(uop, 2)) {
        wjit_reject("BSF/BSR sizes");
        return 0;
    }
    if (reverse) {
        e_i32(31);
        e_get(src);
        e_op(WOP_I32_CLZ);
        e_op(WOP_I32_SUB);
    } else {
        e_get(src);
        e_op(WOP_I32_CTZ);
    }
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_b_real)));
    e_get(src);
    e_op(WOP_SELECT);
    e_set(WLOC_INT(HOST_REG_GET(uop->dest_reg_a_real)));
    return 0;
}
static int codegen_BSF(UNUSED(codeblock_t *block), uop_t *uop) { return gen_bs(uop, 0); }
static int codegen_BSR(UNUSED(codeblock_t *block), uop_t *uop) { return gen_bs(uop, 1); }

/* ---- FP_ENTER / MMX_ENTER -------------------------------------------------- */

/* if (cr0 & 0xc) { cpu_state.oldpc = imm; x86_int(7); leave the block } */
static int
codegen_FP_ENTER(UNUSED(codeblock_t *block), uop_t *uop)
{
    void (*fn)(int) = x86_int;

    wemit_read_abs(E, WOP_I32_LOAD, &cr0);
    e_i32(0xc);
    e_op(WOP_I32_AND);
    wemit_if(E);
    wemit_write_abs_pre(E, &cpu_state.oldpc);
    e_i32(uop->imm_data);
    wemit_store(E, WOP_I32_STORE, 0, 0);
    e_i32(7);
    wjit_call_c((void *) fn, WTYPE_I_V);
    e_op(WOP_RETURN);
    wemit_end(E);
    return 0;
}

/* ---- guest memory access ---------------------------------------------------- */

enum {
    MEM_B = 0, /* i32 value, 1 byte */
    MEM_W,     /* i32 value, 2 bytes */
    MEM_L,     /* i32 value, 4 bytes */
    MEM_Q,     /* f64 local holding 64 raw bits */
    MEM_S,     /* f64 local holding a double, stored as a single */
    MEM_D      /* f64 local holding a double */
};

static int
mem_bytes(int kind)
{
    switch (kind) {
        case MEM_B:
            return 1;
        case MEM_W:
            return 2;
        case MEM_L:
        case MEM_S:
            return 4;
        default:
            return 8;
    }
}

/* Linear address on the wasm stack. Leaves the value in WLOC_SCRATCH_I32_2
   (B/W/L, zero extended) or WLOC_SCRATCH_F64_0 (Q/S/D), having left the block
   if the access aborted.

   The direct path is the arm64 backend's load routine: through readlookup2
   when the page is mapped there and the access is aligned (ea_rule: at most
   0xffc into its page, aligned or not, as the interpreter's eal_r path). */
static void
e_mem_load(int kind, int ea_rule)
{
    int bytes = mem_bytes(kind);

    e_tee(WLOC_SCRATCH_I32_0);
    e_i32(12);
    e_op(WOP_I32_SHR_U);
    e_i32(2);
    e_op(WOP_I32_SHL);
    wemit_load(E, WOP_I32_LOAD, (uint32_t) (uintptr_t) readlookup2, 2);
    e_tee(WLOC_SCRATCH_I32_1);
    e_i32((uint32_t) LOOKUP_INV);
    e_op(WOP_I32_EQ);
    if (ea_rule) {
        e_get(WLOC_SCRATCH_I32_0);
        e_i32(0xfff);
        e_op(WOP_I32_AND);
        e_i32(0xffc);
        e_op(WOP_I32_GT_U);
        e_op(WOP_I32_OR);
    } else if (bytes != 1) {
        e_get(WLOC_SCRATCH_I32_0);
        e_i32(bytes - 1);
        e_op(WOP_I32_AND);
        e_op(WOP_I32_OR);
    }
    wemit_if(E);
    {
        e_get(WLOC_SCRATCH_I32_0);
        switch (kind) {
            case MEM_B: {
                uint8_t (*fn)(uint32_t) = readmembl;
                wjit_call_c((void *) fn, WTYPE_I_I);
                e_set(WLOC_SCRATCH_I32_2);
                break;
            }
            case MEM_W: {
                uint16_t (*fn)(uint32_t) = readmemwl;
                wjit_call_c((void *) fn, WTYPE_I_I);
                e_set(WLOC_SCRATCH_I32_2);
                break;
            }
            case MEM_L: {
                uint32_t (*fn)(uint32_t) = readmemll;
                wjit_call_c((void *) fn, WTYPE_I_I);
                e_set(WLOC_SCRATCH_I32_2);
                break;
            }
            case MEM_S: {
                uint32_t (*fn)(uint32_t) = readmemll;
                wjit_call_c((void *) fn, WTYPE_I_I);
                e_op(WOP_F32_REINTERPRET_I32);
                e_op(WOP_F64_PROMOTE_F32);
                e_set(WLOC_SCRATCH_F64_0);
                break;
            }
            default: {
                uint64_t (*fn)(uint32_t) = readmemql;
                wjit_call_c((void *) fn, WTYPE_I_L);
                e_op(WOP_F64_REINTERPRET_I64);
                e_set(WLOC_SCRATCH_F64_0);
                break;
            }
        }
        e_abrt_check_exit();
    }
    wemit_else(E);
    {
        e_get(WLOC_SCRATCH_I32_1);
        e_get(WLOC_SCRATCH_I32_0);
        e_op(WOP_I32_ADD);
        switch (kind) {
            case MEM_B:
                wemit_load(E, WOP_I32_LOAD8_U, 0, 0);
                e_set(WLOC_SCRATCH_I32_2);
                break;
            case MEM_W:
                wemit_load(E, WOP_I32_LOAD16_U, 0, 0);
                e_set(WLOC_SCRATCH_I32_2);
                break;
            case MEM_L:
                wemit_load(E, WOP_I32_LOAD, 0, 0);
                e_set(WLOC_SCRATCH_I32_2);
                break;
            case MEM_S:
                wemit_load(E, WOP_F32_LOAD, 0, 0);
                e_op(WOP_F64_PROMOTE_F32);
                e_set(WLOC_SCRATCH_F64_0);
                break;
            default:
                wemit_load(E, WOP_F64_LOAD, 0, 0);
                e_set(WLOC_SCRATCH_F64_0);
                break;
        }
    }
    wemit_end(E);
}

/* Linear address in WLOC_SCRATCH_I32_0, value in WLOC_SCRATCH_I32_2 (B/W/L)
   or WLOC_SCRATCH_F64_0 (Q/S/D). Leaves the block if the store aborted. */
static void
e_mem_store(int kind)
{
    int bytes = mem_bytes(kind);

    e_get(WLOC_SCRATCH_I32_0);
    e_i32(12);
    e_op(WOP_I32_SHR_U);
    e_i32(2);
    e_op(WOP_I32_SHL);
    wemit_load(E, WOP_I32_LOAD, (uint32_t) (uintptr_t) writelookup2, 2);
    e_tee(WLOC_SCRATCH_I32_1);
    e_i32((uint32_t) LOOKUP_INV);
    e_op(WOP_I32_EQ);
    if (bytes != 1) {
        e_get(WLOC_SCRATCH_I32_0);
        e_i32(bytes - 1);
        e_op(WOP_I32_AND);
        e_op(WOP_I32_OR);
    }
    wemit_if(E);
    {
        e_get(WLOC_SCRATCH_I32_0);
        switch (kind) {
            case MEM_B: {
                void (*fn)(uint32_t, uint8_t) = writemembl;
                e_get(WLOC_SCRATCH_I32_2);
                wjit_call_c((void *) fn, WTYPE_II_V);
                break;
            }
            case MEM_W: {
                void (*fn)(uint32_t, uint16_t) = writememwl;
                e_get(WLOC_SCRATCH_I32_2);
                wjit_call_c((void *) fn, WTYPE_II_V);
                break;
            }
            case MEM_L: {
                void (*fn)(uint32_t, uint32_t) = writememll;
                e_get(WLOC_SCRATCH_I32_2);
                wjit_call_c((void *) fn, WTYPE_II_V);
                break;
            }
            case MEM_S: {
                void (*fn)(uint32_t, uint32_t) = writememll;
                e_get(WLOC_SCRATCH_F64_0);
                e_op(WOP_F32_DEMOTE_F64);
                e_op(WOP_I32_REINTERPRET_F32);
                wjit_call_c((void *) fn, WTYPE_II_V);
                break;
            }
            default: {
                void (*fn)(uint32_t, uint64_t) = writememql;
                e_get(WLOC_SCRATCH_F64_0);
                e_op(WOP_I64_REINTERPRET_F64);
                wjit_call_c((void *) fn, WTYPE_IL_V);
                break;
            }
        }
        e_abrt_check_exit();
    }
    wemit_else(E);
    {
        e_get(WLOC_SCRATCH_I32_1);
        e_get(WLOC_SCRATCH_I32_0);
        e_op(WOP_I32_ADD);
        switch (kind) {
            case MEM_B:
                e_get(WLOC_SCRATCH_I32_2);
                wemit_store(E, WOP_I32_STORE8, 0, 0);
                break;
            case MEM_W:
                e_get(WLOC_SCRATCH_I32_2);
                wemit_store(E, WOP_I32_STORE16, 0, 0);
                break;
            case MEM_L:
                e_get(WLOC_SCRATCH_I32_2);
                wemit_store(E, WOP_I32_STORE, 0, 0);
                break;
            case MEM_S:
                e_get(WLOC_SCRATCH_F64_0);
                e_op(WOP_F32_DEMOTE_F64);
                wemit_store(E, WOP_F32_STORE, 0, 0);
                break;
            default:
                e_get(WLOC_SCRATCH_F64_0);
                wemit_store(E, WOP_F64_STORE, 0, 0);
                break;
        }
    }
    wemit_end(E);
}

/* push src_reg_a (segment base) + src_reg_b (offset) + imm */
static void
e_guest_addr(uop_t *uop, int use_imm)
{
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_a_real)));
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_b_real)));
    e_op(WOP_I32_ADD);
    if (use_imm && uop->imm_data) {
        e_i32(uop->imm_data);
        e_op(WOP_I32_ADD);
    }
}

static int
int_mem_kind(int size)
{
    if (REG_IS_B(size) || REG_IS_BH(size))
        return MEM_B;
    if (REG_IS_W(size))
        return MEM_W;
    if (REG_IS_L(size))
        return MEM_L;
    return -1;
}

static int
codegen_MEM_LOAD_ABS(UNUSED(codeblock_t *block), uop_t *uop)
{
    int kind = int_mem_kind(IREG_GET_SIZE(uop->dest_reg_a_real));

    if (kind < 0) {
        wjit_reject("MEM_LOAD_ABS size");
        return 0;
    }
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_a_real)));
    if (uop->imm_data) {
        e_i32(uop->imm_data);
        e_op(WOP_I32_ADD);
    }
    e_mem_load(kind, 0);
    e_get(WLOC_SCRATCH_I32_2);
    e_dst(uop->dest_reg_a_real);
    return 0;
}

static int
codegen_MEM_LOAD_REG(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);
    int kind      = int_mem_kind(dest_size);

    if (REG_IS_Q(dest_size)) {
        e_guest_addr(uop, 1);
        e_mem_load(MEM_Q, 0);
        e_get(WLOC_SCRATCH_F64_0);
        e_fset(uop->dest_reg_a_real);
        return 0;
    }
    if (kind < 0) {
        wjit_reject("MEM_LOAD_REG size");
        return 0;
    }
    e_guest_addr(uop, 1);
    e_mem_load(kind, 0);
    e_get(WLOC_SCRATCH_I32_2);
    e_dst(uop->dest_reg_a_real);
    return 0;
}

/* The arm64 handler does not add imm_data here */
static int
codegen_MEM_LOAD_REG_EA(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);

    if (!REG_IS_W(dest_size) && !REG_IS_L(dest_size)) {
        wjit_reject("MEM_LOAD_REG_EA size");
        return 0;
    }
    e_guest_addr(uop, 0);
    e_mem_load(REG_IS_W(dest_size) ? MEM_W : MEM_L, 1);
    e_get(WLOC_SCRATCH_I32_2);
    e_dst(uop->dest_reg_a_real);
    return 0;
}

static int
gen_mem_load_float(uop_t *uop, int kind)
{
    if (!REG_IS_D(IREG_GET_SIZE(uop->dest_reg_a_real))) {
        wjit_reject("MEM_LOAD_SINGLE/DOUBLE size");
        return 0;
    }
    e_guest_addr(uop, 1);
    e_mem_load(kind, 0);
    e_get(WLOC_SCRATCH_F64_0);
    e_fset(uop->dest_reg_a_real);
    return 0;
}
static int codegen_MEM_LOAD_SINGLE(UNUSED(codeblock_t *block), uop_t *uop) { return gen_mem_load_float(uop, MEM_S); }
static int codegen_MEM_LOAD_DOUBLE(UNUSED(codeblock_t *block), uop_t *uop) { return gen_mem_load_float(uop, MEM_D); }

static int
codegen_MEM_STORE_ABS(UNUSED(codeblock_t *block), uop_t *uop)
{
    int kind = int_mem_kind(IREG_GET_SIZE(uop->src_reg_b_real));

    if (kind < 0) {
        wjit_reject("MEM_STORE_ABS size");
        return 0;
    }
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_a_real)));
    if (uop->imm_data) {
        e_i32(uop->imm_data);
        e_op(WOP_I32_ADD);
    }
    e_set(WLOC_SCRATCH_I32_0);
    e_src(uop->src_reg_b_real);
    e_set(WLOC_SCRATCH_I32_2);
    e_mem_store(kind);
    return 0;
}

static int
codegen_MEM_STORE_REG(UNUSED(codeblock_t *block), uop_t *uop)
{
    int src_size = IREG_GET_SIZE(uop->src_reg_c_real);
    int kind     = int_mem_kind(src_size);

    if (REG_IS_Q(src_size)) {
        e_guest_addr(uop, 1);
        e_set(WLOC_SCRATCH_I32_0);
        e_fget(uop->src_reg_c_real);
        e_set(WLOC_SCRATCH_F64_0);
        e_mem_store(MEM_Q);
        return 0;
    }
    if (kind < 0) {
        wjit_reject("MEM_STORE_REG size");
        return 0;
    }
    e_guest_addr(uop, 1);
    e_set(WLOC_SCRATCH_I32_0);
    e_src(uop->src_reg_c_real);
    e_set(WLOC_SCRATCH_I32_2);
    e_mem_store(kind);
    return 0;
}

/* The arm64 handlers do not add an offset here: imm_data is the value */
static int
gen_mem_store_imm(uop_t *uop, int kind)
{
    e_guest_addr(uop, 0);
    e_set(WLOC_SCRATCH_I32_0);
    e_i32(uop->imm_data);
    e_set(WLOC_SCRATCH_I32_2);
    e_mem_store(kind);
    return 0;
}
static int codegen_MEM_STORE_IMM_8(UNUSED(codeblock_t *block), uop_t *uop) { return gen_mem_store_imm(uop, MEM_B); }
static int codegen_MEM_STORE_IMM_16(UNUSED(codeblock_t *block), uop_t *uop) { return gen_mem_store_imm(uop, MEM_W); }
static int codegen_MEM_STORE_IMM_32(UNUSED(codeblock_t *block), uop_t *uop) { return gen_mem_store_imm(uop, MEM_L); }

static int
gen_mem_store_float(uop_t *uop, int kind)
{
    if (!REG_IS_D(IREG_GET_SIZE(uop->src_reg_c_real))) {
        wjit_reject("MEM_STORE_SINGLE/DOUBLE size");
        return 0;
    }
    e_guest_addr(uop, 1);
    e_set(WLOC_SCRATCH_I32_0);
    e_fget(uop->src_reg_c_real);
    e_set(WLOC_SCRATCH_F64_0);
    e_mem_store(kind);
    return 0;
}
static int codegen_MEM_STORE_SINGLE(UNUSED(codeblock_t *block), uop_t *uop) { return gen_mem_store_float(uop, MEM_S); }
static int codegen_MEM_STORE_DOUBLE(UNUSED(codeblock_t *block), uop_t *uop) { return gen_mem_store_float(uop, MEM_D); }

/* ---- MOV family -------------------------------------------------------------- */

static int
codegen_MOV(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);
    int src_size  = IREG_GET_SIZE(uop->src_reg_a_real);

    if ((REG_IS_D(dest_size) && REG_IS_D(src_size)) || (REG_IS_Q(dest_size) && REG_IS_Q(src_size))) {
        e_fget(uop->src_reg_a_real);
        e_fset(uop->dest_reg_a_real);
    } else if (is_int_size(dest_size) && is_int_size(src_size)) {
        e_src(uop->src_reg_a_real);
        e_dst(uop->dest_reg_a_real);
    } else
        wjit_reject("MOV sizes");
    return 0;
}

static int
codegen_MOV_IMM(UNUSED(codeblock_t *block), uop_t *uop)
{
    if (!is_int_size(IREG_GET_SIZE(uop->dest_reg_a_real))) {
        wjit_reject("MOV_IMM size");
        return 0;
    }
    e_i32(uop->imm_data);
    e_dst(uop->dest_reg_a_real);
    return 0;
}

static int
codegen_MOV_PTR(UNUSED(codeblock_t *block), uop_t *uop)
{
    e_i32((uint32_t) (uintptr_t) uop->p);
    e_set(WLOC_INT(HOST_REG_GET(uop->dest_reg_a_real)));
    return 0;
}

static int
codegen_MOVSX(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);
    int src_size  = IREG_GET_SIZE(uop->src_reg_a_real);

    if (!(REG_IS_L(dest_size) || REG_IS_W(dest_size)) || !(REG_IS_B(src_size) || REG_IS_BH(src_size) || REG_IS_W(src_size))) {
        wjit_reject("MOVSX sizes");
        return 0;
    }
    e_src_sx(uop->src_reg_a_real);
    e_dst(uop->dest_reg_a_real);
    return 0;
}

static int
codegen_MOVZX(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);
    int src_size  = IREG_GET_SIZE(uop->src_reg_a_real);

    if (is_int_size(dest_size) && is_int_size(src_size)) {
        e_src(uop->src_reg_a_real);
        e_dst(uop->dest_reg_a_real);
    } else
        wjit_reject("MOVZX to or from MMX");
    return 0;
}

static int
codegen_MOV_DOUBLE_INT(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);
    int src_size  = IREG_GET_SIZE(uop->src_reg_a_real);

    if (REG_IS_D(dest_size) && (REG_IS_L(src_size) || REG_IS_W(src_size))) {
        e_src_sx(uop->src_reg_a_real);
        e_op(WOP_F64_CONVERT_I32_S);
        e_fset(uop->dest_reg_a_real);
    } else if (REG_IS_D(dest_size) && REG_IS_Q(src_size)) {
        e_qget(uop->src_reg_a_real);
        e_op(WOP_F64_CONVERT_I64_S);
        e_fset(uop->dest_reg_a_real);
    } else
        wjit_reject("MOV_DOUBLE_INT sizes");
    return 0;
}

static int
codegen_MOV_INT_DOUBLE(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);
    int src_size  = IREG_GET_SIZE(uop->src_reg_a_real);

    if (REG_IS_L(dest_size) && REG_IS_D(src_size)) {
        e_fget(uop->src_reg_a_real);
        wjit_call_c((void *) wjit_fp_round, WTYPE_D_I);
        e_set(WLOC_INT(HOST_REG_GET(uop->dest_reg_a_real)));
    } else if (REG_IS_W(dest_size) && REG_IS_D(src_size)) {
        e_fget(uop->src_reg_a_real);
        wjit_call_c((void *) wjit_fp_round_w, WTYPE_D_I);
        e_dst(uop->dest_reg_a_real);
    } else
        wjit_reject("MOV_INT_DOUBLE sizes");
    return 0;
}

static int
codegen_MOV_INT_DOUBLE_64(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size   = IREG_GET_SIZE(uop->dest_reg_a_real);
    int src_size    = IREG_GET_SIZE(uop->src_reg_a_real);
    int src_64_size = IREG_GET_SIZE(uop->src_reg_b_real);

    if (!(REG_IS_Q(dest_size) && REG_IS_D(src_size) && REG_IS_Q(src_64_size))) {
        wjit_reject("MOV_INT_DOUBLE_64 sizes");
        return 0;
    }
    /* If TAG_UINT64 (bit 7 of the tag) is set the source is MM[], taken as
       it is. Otherwise it is the double in ST(), rounded. The double is
       read first: dest may be the same host reg as either source. */
    e_fget(uop->src_reg_a_real);
    e_set(WLOC_SCRATCH_F64_0);
    e_fget(uop->src_reg_b_real);
    e_fset(uop->dest_reg_a_real);
    e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_c_real)));
    e_i32(0x80);
    e_op(WOP_I32_AND);
    e_op(WOP_I32_EQZ);
    wemit_if(E);
    e_get(WLOC_SCRATCH_F64_0);
    wjit_call_c((void *) wjit_fp_round_quad, WTYPE_D_L);
    e_qset(uop->dest_reg_a_real);
    wemit_end(E);
    return 0;
}

static int
codegen_MOV_REG_PTR(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);

    if (REG_IS_L(dest_size)) {
        wemit_read_abs(E, WOP_I32_LOAD, uop->p);
        e_set(WLOC_INT(HOST_REG_GET(uop->dest_reg_a_real)));
    } else if (REG_IS_Q(dest_size) || REG_IS_D(dest_size)) {
        wemit_read_abs(E, WOP_F64_LOAD, uop->p);
        e_fset(uop->dest_reg_a_real);
    } else
        wjit_reject("MOV_REG_PTR size");
    return 0;
}

static int
codegen_MOVZX_REG_PTR_8(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);

    if (!(REG_IS_L(dest_size) || REG_IS_W(dest_size) || REG_IS_B(dest_size))) {
        wjit_reject("MOVZX_REG_PTR_8 size");
        return 0;
    }
    wemit_read_abs(E, WOP_I32_LOAD8_U, uop->p);
    e_dst(uop->dest_reg_a_real);
    return 0;
}

static int
codegen_MOVZX_REG_PTR_16(UNUSED(codeblock_t *block), uop_t *uop)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);

    if (!(REG_IS_L(dest_size) || REG_IS_W(dest_size))) {
        wjit_reject("MOVZX_REG_PTR_16 size");
        return 0;
    }
    wemit_read_abs(E, WOP_I32_LOAD16_U, uop->p);
    e_dst(uop->dest_reg_a_real);
    return 0;
}

static int
codegen_NOP(UNUSED(codeblock_t *block), UNUSED(uop_t *uop))
{
    return 0;
}

static int
gen_store_ptr_imm(uop_t *uop, uint8_t store_op)
{
    wemit_write_abs_pre(E, uop->p);
    e_i32(uop->imm_data);
    wemit_store(E, store_op, 0, 0);
    return 0;
}
static int codegen_STORE_PTR_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_store_ptr_imm(uop, WOP_I32_STORE); }
static int codegen_STORE_PTR_IMM_8(UNUSED(codeblock_t *block), uop_t *uop) { return gen_store_ptr_imm(uop, WOP_I32_STORE8); }
static int codegen_STORE_PTR_IMM_16(UNUSED(codeblock_t *block), uop_t *uop) { return gen_store_ptr_imm(uop, WOP_I32_STORE16); }

/* ---- shifts / rotates --------------------------------------------------------- */

static int
shift_sizes_ok(uop_t *uop)
{
    int dest_size = IREG_GET_SIZE(uop->dest_reg_a_real);
    int src_size  = IREG_GET_SIZE(uop->src_reg_a_real);

    return is_int_size(dest_size) && (dest_size == src_size);
}

static void
e_shift_count(uop_t *uop, int is_imm)
{
    if (is_imm)
        e_i32(uop->imm_data);
    else
        e_get(WLOC_INT(HOST_REG_GET(uop->src_reg_b_real)));
}

/* The count is taken modulo 32 whatever the operand size, as by the arm64
   backend's LSL/LSR/ASR on W registers */
static int
gen_shift(uop_t *uop, uint8_t op, int is_imm)
{
    if (!shift_sizes_ok(uop)) {
        wjit_reject("shift sizes");
        return 0;
    }
    if (op == WOP_I32_SHR_S)
        e_src_sx(uop->src_reg_a_real);
    else
        e_src(uop->src_reg_a_real);
    e_shift_count(uop, is_imm);
    e_op(op);
    e_dst(uop->dest_reg_a_real);
    return 0;
}
static int codegen_SAR(UNUSED(codeblock_t *block), uop_t *uop) { return gen_shift(uop, WOP_I32_SHR_S, 0); }
static int codegen_SAR_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_shift(uop, WOP_I32_SHR_S, 1); }
static int codegen_SHL(UNUSED(codeblock_t *block), uop_t *uop) { return gen_shift(uop, WOP_I32_SHL, 0); }
static int codegen_SHL_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_shift(uop, WOP_I32_SHL, 1); }
static int codegen_SHR(UNUSED(codeblock_t *block), uop_t *uop) { return gen_shift(uop, WOP_I32_SHR_U, 0); }
static int codegen_SHR_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_shift(uop, WOP_I32_SHR_U, 1); }

/* A 16 or 8 bit value repeated to fill the word rotates within its own
   width when the word is rotated, by any count */
static int
gen_rot(uop_t *uop, uint8_t op, int is_imm)
{
    int src_size = IREG_GET_SIZE(uop->src_reg_a_real);

    if (!shift_sizes_ok(uop)) {
        wjit_reject("rotate sizes");
        return 0;
    }
    e_src(uop->src_reg_a_real);
    if (REG_IS_W(src_size)) {
        e_i32(0x00010001);
        e_op(WOP_I32_MUL);
    } else if (!REG_IS_L(src_size)) {
        e_i32(0x01010101);
        e_op(WOP_I32_MUL);
    }
    e_shift_count(uop, is_imm);
    e_op(op);
    e_dst(uop->dest_reg_a_real);
    return 0;
}
static int codegen_ROL(UNUSED(codeblock_t *block), uop_t *uop) { return gen_rot(uop, WOP_I32_ROTL, 0); }
static int codegen_ROL_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_rot(uop, WOP_I32_ROTL, 1); }
static int codegen_ROR(UNUSED(codeblock_t *block), uop_t *uop) { return gen_rot(uop, WOP_I32_ROTR, 0); }
static int codegen_ROR_IMM(UNUSED(codeblock_t *block), uop_t *uop) { return gen_rot(uop, WOP_I32_ROTR, 1); }

/* ---- x87 ------------------------------------------------------------------------ */

static int
gen_fop2(uop_t *uop, uint8_t f64_op)
{
    if (!(REG_IS_D(IREG_GET_SIZE(uop->dest_reg_a_real)) && REG_IS_D(IREG_GET_SIZE(uop->src_reg_a_real)) && REG_IS_D(IREG_GET_SIZE(uop->src_reg_b_real)))) {
        wjit_reject("x87 arithmetic sizes");
        return 0;
    }
    e_fget(uop->src_reg_a_real);
    e_fget(uop->src_reg_b_real);
    e_op(f64_op);
    e_fset(uop->dest_reg_a_real);
    return 0;
}
static int codegen_FADD(UNUSED(codeblock_t *block), uop_t *uop) { return gen_fop2(uop, WOP_F64_ADD); }
static int codegen_FSUB(UNUSED(codeblock_t *block), uop_t *uop) { return gen_fop2(uop, WOP_F64_SUB); }
static int codegen_FMUL(UNUSED(codeblock_t *block), uop_t *uop) { return gen_fop2(uop, WOP_F64_MUL); }
static int codegen_FDIV(UNUSED(codeblock_t *block), uop_t *uop) { return gen_fop2(uop, WOP_F64_DIV); }

static int
gen_fop1(uop_t *uop, uint8_t f64_op)
{
    if (!(REG_IS_D(IREG_GET_SIZE(uop->dest_reg_a_real)) && REG_IS_D(IREG_GET_SIZE(uop->src_reg_a_real)))) {
        wjit_reject("x87 unary sizes");
        return 0;
    }
    e_fget(uop->src_reg_a_real);
    e_op(f64_op);
    e_fset(uop->dest_reg_a_real);
    return 0;
}
static int codegen_FABS(UNUSED(codeblock_t *block), uop_t *uop) { return gen_fop1(uop, WOP_F64_ABS); }
static int codegen_FCHS(UNUSED(codeblock_t *block), uop_t *uop) { return gen_fop1(uop, WOP_F64_NEG); }
static int codegen_FSQRT(UNUSED(codeblock_t *block), uop_t *uop) { return gen_fop1(uop, WOP_F64_SQRT); }

/* dest = (double)(float)src: precision control at 24 bits */
static int
codegen_FROUND_S(UNUSED(codeblock_t *block), uop_t *uop)
{
    if (!(REG_IS_D(IREG_GET_SIZE(uop->dest_reg_a_real)) && REG_IS_D(IREG_GET_SIZE(uop->src_reg_a_real)))) {
        wjit_reject("FROUND_S sizes");
        return 0;
    }
    e_fget(uop->src_reg_a_real);
    e_op(WOP_F32_DEMOTE_F64);
    e_op(WOP_F64_PROMOTE_F32);
    e_fset(uop->dest_reg_a_real);
    return 0;
}

/* The condition codes of a compare of the f64 locals a and b on the wasm
   stack: C3 if equal, C0 if a < b, C0|C2|C3 if unordered, else none */
static void
e_fcom_result(int fp_a, int fp_b)
{
    /* unordered ? C0|C2|C3 : (eq * C3 | lt * C0) */
    e_i32(FPU_SW_C0 | FPU_SW_C2 | FPU_SW_C3);
    e_get(fp_a);
    e_get(fp_b);
    e_op(WOP_F64_EQ);
    e_i32(FPU_SW_C3);
    e_op(WOP_I32_MUL);
    e_get(fp_a);
    e_get(fp_b);
    e_op(WOP_F64_LT);
    e_i32(FPU_SW_C0);
    e_op(WOP_I32_MUL);
    e_op(WOP_I32_OR);
    e_get(fp_a);
    e_get(fp_a);
    e_op(WOP_F64_NE);
    e_get(fp_b);
    e_get(fp_b);
    e_op(WOP_F64_NE);
    e_op(WOP_I32_OR);
    e_op(WOP_SELECT);
}

static int
codegen_FCOM(UNUSED(codeblock_t *block), uop_t *uop)
{
    if (!(REG_IS_W(IREG_GET_SIZE(uop->dest_reg_a_real)) && REG_IS_D(IREG_GET_SIZE(uop->src_reg_a_real)) && REG_IS_D(IREG_GET_SIZE(uop->src_reg_b_real)))) {
        wjit_reject("FCOM sizes");
        return 0;
    }
    e_fcom_result(WLOC_FP(HOST_REG_GET(uop->src_reg_a_real)), WLOC_FP(HOST_REG_GET(uop->src_reg_b_real)));
    e_dst(uop->dest_reg_a_real);
    return 0;
}

static int
codegen_FTST(UNUSED(codeblock_t *block), uop_t *uop)
{
    if (!(REG_IS_W(IREG_GET_SIZE(uop->dest_reg_a_real)) && REG_IS_D(IREG_GET_SIZE(uop->src_reg_a_real)))) {
        wjit_reject("FTST sizes");
        return 0;
    }
    wemit_f64_const(E, 0.0);
    e_set(WLOC_SCRATCH_F64_1);
    e_fcom_result(WLOC_FP(HOST_REG_GET(uop->src_reg_a_real)), WLOC_SCRATCH_F64_1);
    e_dst(uop->dest_reg_a_real);
    return 0;
}

/* ---- handler table -------------------------------------------------------------- */

#    pragma clang diagnostic push
#    pragma clang diagnostic ignored "-Winitializer-overrides"
const uOpFn uop_handlers[UOP_MAX] = {
    [0 ... UOP_MAX - 1] = codegen_UNIMPLEMENTED,

    [UOP_CALL_FUNC & UOP_MASK]                = codegen_CALL_FUNC,
    [UOP_CALL_FUNC_RESULT & UOP_MASK]         = codegen_CALL_FUNC_RESULT,
    /* wasm locals survive a call: the ordered forms are the plain ones */
    [UOP_CALL_FUNC_ORDERED & UOP_MASK]        = codegen_CALL_FUNC,
    [UOP_CALL_FUNC_RESULT_ORDERED & UOP_MASK] = codegen_CALL_FUNC_RESULT,
    [UOP_CALL_INSTRUCTION_FUNC & UOP_MASK]    = codegen_CALL_INSTRUCTION_FUNC,

    [UOP_JMP & UOP_MASK] = codegen_JMP,

    [UOP_LOAD_SEG & UOP_MASK] = codegen_LOAD_SEG,

    [UOP_LOAD_FUNC_ARG_0 & UOP_MASK] = codegen_LOAD_FUNC_ARG0,
    [UOP_LOAD_FUNC_ARG_1 & UOP_MASK] = codegen_LOAD_FUNC_ARG1,
    [UOP_LOAD_FUNC_ARG_2 & UOP_MASK] = codegen_LOAD_FUNC_ARG2,
    [UOP_LOAD_FUNC_ARG_3 & UOP_MASK] = codegen_LOAD_FUNC_ARG3,

    [UOP_LOAD_FUNC_ARG_0_IMM & UOP_MASK] = codegen_LOAD_FUNC_ARG0_IMM,
    [UOP_LOAD_FUNC_ARG_1_IMM & UOP_MASK] = codegen_LOAD_FUNC_ARG1_IMM,
    [UOP_LOAD_FUNC_ARG_2_IMM & UOP_MASK] = codegen_LOAD_FUNC_ARG2_IMM,
    [UOP_LOAD_FUNC_ARG_3_IMM & UOP_MASK] = codegen_LOAD_FUNC_ARG3_IMM,

    [UOP_STORE_P_IMM & UOP_MASK]    = codegen_STORE_PTR_IMM,
    [UOP_STORE_P_IMM_8 & UOP_MASK]  = codegen_STORE_PTR_IMM_8,
    [UOP_STORE_P_IMM_16 & UOP_MASK] = codegen_STORE_PTR_IMM_16,

    [UOP_MEM_LOAD_ABS & UOP_MASK]    = codegen_MEM_LOAD_ABS,
    [UOP_MEM_LOAD_REG & UOP_MASK]    = codegen_MEM_LOAD_REG,
    [UOP_MEM_LOAD_REG_EA & UOP_MASK] = codegen_MEM_LOAD_REG_EA,
    [UOP_MEM_LOAD_SINGLE & UOP_MASK] = codegen_MEM_LOAD_SINGLE,
    [UOP_MEM_LOAD_DOUBLE & UOP_MASK] = codegen_MEM_LOAD_DOUBLE,

    [UOP_MEM_STORE_ABS & UOP_MASK]    = codegen_MEM_STORE_ABS,
    [UOP_MEM_STORE_REG & UOP_MASK]    = codegen_MEM_STORE_REG,
    [UOP_MEM_STORE_IMM_8 & UOP_MASK]  = codegen_MEM_STORE_IMM_8,
    [UOP_MEM_STORE_IMM_16 & UOP_MASK] = codegen_MEM_STORE_IMM_16,
    [UOP_MEM_STORE_IMM_32 & UOP_MASK] = codegen_MEM_STORE_IMM_32,
    [UOP_MEM_STORE_SINGLE & UOP_MASK] = codegen_MEM_STORE_SINGLE,
    [UOP_MEM_STORE_DOUBLE & UOP_MASK] = codegen_MEM_STORE_DOUBLE,

    [UOP_MOV & UOP_MASK]               = codegen_MOV,
    [UOP_MOV_PTR & UOP_MASK]           = codegen_MOV_PTR,
    [UOP_MOV_IMM & UOP_MASK]           = codegen_MOV_IMM,
    [UOP_MOVSX & UOP_MASK]             = codegen_MOVSX,
    [UOP_MOVZX & UOP_MASK]             = codegen_MOVZX,
    [UOP_MOV_DOUBLE_INT & UOP_MASK]    = codegen_MOV_DOUBLE_INT,
    [UOP_MOV_INT_DOUBLE & UOP_MASK]    = codegen_MOV_INT_DOUBLE,
    [UOP_MOV_INT_DOUBLE_64 & UOP_MASK] = codegen_MOV_INT_DOUBLE_64,
    [UOP_MOV_REG_PTR & UOP_MASK]       = codegen_MOV_REG_PTR,
    [UOP_MOVZX_REG_PTR_8 & UOP_MASK]   = codegen_MOVZX_REG_PTR_8,
    [UOP_MOVZX_REG_PTR_16 & UOP_MASK]  = codegen_MOVZX_REG_PTR_16,

    [UOP_ADD & UOP_MASK]        = codegen_ADD,
    [UOP_ADD_IMM & UOP_MASK]    = codegen_ADD_IMM,
    [UOP_ADD_LSHIFT & UOP_MASK] = codegen_ADD_LSHIFT,
    [UOP_AND & UOP_MASK]        = codegen_AND,
    [UOP_AND_IMM & UOP_MASK]    = codegen_AND_IMM,
    [UOP_ANDN & UOP_MASK]       = codegen_MMX,
    [UOP_OR & UOP_MASK]         = codegen_OR,
    [UOP_OR_IMM & UOP_MASK]     = codegen_OR_IMM,
    [UOP_SUB & UOP_MASK]        = codegen_SUB,
    [UOP_SUB_IMM & UOP_MASK]    = codegen_SUB_IMM,
    [UOP_XOR & UOP_MASK]        = codegen_XOR,
    [UOP_XOR_IMM & UOP_MASK]    = codegen_XOR_IMM,

    [UOP_SAR & UOP_MASK]     = codegen_SAR,
    [UOP_SAR_IMM & UOP_MASK] = codegen_SAR_IMM,
    [UOP_SHL & UOP_MASK]     = codegen_SHL,
    [UOP_SHL_IMM & UOP_MASK] = codegen_SHL_IMM,
    [UOP_SHR & UOP_MASK]     = codegen_SHR,
    [UOP_SHR_IMM & UOP_MASK] = codegen_SHR_IMM,
    [UOP_ROL & UOP_MASK]     = codegen_ROL,
    [UOP_ROL_IMM & UOP_MASK] = codegen_ROL_IMM,
    [UOP_ROR & UOP_MASK]     = codegen_ROR,
    [UOP_ROR_IMM & UOP_MASK] = codegen_ROR_IMM,

    [UOP_CMP_IMM_JZ & UOP_MASK] = codegen_CMP_IMM_JZ,

    [UOP_CMP_JB & UOP_MASK]       = codegen_CMP_JB,
    [UOP_CMP_JNBE & UOP_MASK]     = codegen_CMP_JNBE,
    [UOP_CMP_JNWITHIN & UOP_MASK] = codegen_CMP_JNWITHIN,

    [UOP_FCMP_JWITHIN_DEST & UOP_MASK] = codegen_FCMP_JWITHIN_DEST,

    [UOP_CMP_JNB_DEST & UOP_MASK]  = codegen_CMP_JNB_DEST,
    [UOP_CMP_JNBE_DEST & UOP_MASK] = codegen_CMP_JNBE_DEST,
    [UOP_CMP_JNL_DEST & UOP_MASK]  = codegen_CMP_JNL_DEST,
    [UOP_CMP_JNLE_DEST & UOP_MASK] = codegen_CMP_JNLE_DEST,
    [UOP_CMP_JNO_DEST & UOP_MASK]  = codegen_CMP_JNO_DEST,
    [UOP_CMP_JNZ_DEST & UOP_MASK]  = codegen_CMP_JNZ_DEST,
    [UOP_CMP_JB_DEST & UOP_MASK]   = codegen_CMP_JB_DEST,
    [UOP_CMP_JBE_DEST & UOP_MASK]  = codegen_CMP_JBE_DEST,
    [UOP_CMP_JL_DEST & UOP_MASK]   = codegen_CMP_JL_DEST,
    [UOP_CMP_JLE_DEST & UOP_MASK]  = codegen_CMP_JLE_DEST,
    [UOP_CMP_JO_DEST & UOP_MASK]   = codegen_CMP_JO_DEST,
    [UOP_CMP_JZ_DEST & UOP_MASK]   = codegen_CMP_JZ_DEST,

    [UOP_CMP_IMM_JNZ_DEST & UOP_MASK] = codegen_CMP_IMM_JNZ_DEST,
    [UOP_CMP_IMM_JZ_DEST & UOP_MASK]  = codegen_CMP_IMM_JZ_DEST,

    [UOP_TEST_JNS_DEST & UOP_MASK] = codegen_TEST_JNS_DEST,
    [UOP_TEST_JS_DEST & UOP_MASK]  = codegen_TEST_JS_DEST,

    [UOP_CMP_SET & UOP_MASK]  = codegen_CMP_SET,
    [UOP_TEST_SET & UOP_MASK] = codegen_TEST_SET,
    [UOP_BSWAP & UOP_MASK]    = codegen_BSWAP,
    [UOP_IMUL & UOP_MASK]     = codegen_IMUL,
    [UOP_IMUL_OV & UOP_MASK]  = codegen_IMUL_OV,
    [UOP_MUL_HI & UOP_MASK]   = codegen_MUL_HI,
    [UOP_IMUL_HI & UOP_MASK]  = codegen_IMUL_HI,
    [UOP_BSF & UOP_MASK]      = codegen_BSF,
    [UOP_BSR & UOP_MASK]      = codegen_BSR,

    [UOP_FP_ENTER & UOP_MASK]         = codegen_FP_ENTER,
    [UOP_FP_ENTER_ORDERED & UOP_MASK] = codegen_FP_ENTER,
    [UOP_MMX_ENTER & UOP_MASK]        = codegen_MMX,

    [UOP_FADD & UOP_MASK] = codegen_FADD,
    [UOP_FCOM & UOP_MASK] = codegen_FCOM,
    [UOP_FDIV & UOP_MASK] = codegen_FDIV,
    [UOP_FMUL & UOP_MASK] = codegen_FMUL,
    [UOP_FSUB & UOP_MASK] = codegen_FSUB,

    [UOP_FABS & UOP_MASK]     = codegen_FABS,
    [UOP_FCHS & UOP_MASK]     = codegen_FCHS,
    [UOP_FSQRT & UOP_MASK]    = codegen_FSQRT,
    [UOP_FROUND_S & UOP_MASK] = codegen_FROUND_S,
    [UOP_FTST & UOP_MASK]     = codegen_FTST,

    [UOP_NOP_BARRIER & UOP_MASK] = codegen_NOP,
};
#    pragma clang diagnostic pop

/* ---- register allocator surface (codegen_direct_*) ---------------------------- */

void
codegen_direct_read_8(UNUSED(codeblock_t *block), int host_reg, void *p)
{
    wemit_read_abs(E, WOP_I32_LOAD8_U, p);
    e_set(WLOC_INT(host_reg));
}
void
codegen_direct_read_16(UNUSED(codeblock_t *block), int host_reg, void *p)
{
    wemit_read_abs(E, WOP_I32_LOAD16_U, p);
    e_set(WLOC_INT(host_reg));
}
void
codegen_direct_read_32(UNUSED(codeblock_t *block), int host_reg, void *p)
{
    wemit_read_abs(E, WOP_I32_LOAD, p);
    e_set(WLOC_INT(host_reg));
}
void
codegen_direct_read_pointer(UNUSED(codeblock_t *block), int host_reg, void *p)
{
    wemit_read_abs(E, WOP_I32_LOAD, p);
    e_set(WLOC_INT(host_reg));
}
void
codegen_direct_read_64(UNUSED(codeblock_t *block), int host_reg, void *p)
{
    wemit_read_abs(E, WOP_F64_LOAD, p);
    e_set(WLOC_FP(host_reg));
}
void
codegen_direct_read_double(UNUSED(codeblock_t *block), int host_reg, void *p)
{
    wemit_read_abs(E, WOP_F64_LOAD, p);
    e_set(WLOC_FP(host_reg));
}

/* registers relative to the FPU top of stack: base[(TOPDIFF + reg_idx) & 7] */
static void
e_st_addr(void *base, int reg_idx, int stride_shift)
{
    e_get(WLOC_TOPDIFF);
    e_i32(reg_idx);
    e_op(WOP_I32_ADD);
    e_i32(7);
    e_op(WOP_I32_AND);
    if (stride_shift) {
        e_i32(stride_shift);
        e_op(WOP_I32_SHL);
    }
    e_i32((uint32_t) (uintptr_t) base);
    e_op(WOP_I32_ADD);
}
void
codegen_direct_read_st_8(UNUSED(codeblock_t *block), int host_reg, void *base, int reg_idx)
{
    e_st_addr(base, reg_idx, 0);
    wemit_load(E, WOP_I32_LOAD8_U, 0, 0);
    e_set(WLOC_INT(host_reg));
}
void
codegen_direct_read_st_64(UNUSED(codeblock_t *block), int host_reg, void *base, int reg_idx)
{
    e_st_addr(base, reg_idx, 3);
    wemit_load(E, WOP_F64_LOAD, 0, 0);
    e_set(WLOC_FP(host_reg));
}
void
codegen_direct_read_st_double(UNUSED(codeblock_t *block), int host_reg, void *base, int reg_idx)
{
    e_st_addr(base, reg_idx, 3);
    wemit_load(E, WOP_F64_LOAD, 0, 0);
    e_set(WLOC_FP(host_reg));
}

void
codegen_direct_write_8(UNUSED(codeblock_t *block), void *p, int host_reg)
{
    wemit_write_abs_pre(E, p);
    e_get(WLOC_INT(host_reg));
    wemit_store(E, WOP_I32_STORE8, 0, 0);
}
void
codegen_direct_write_16(UNUSED(codeblock_t *block), void *p, int host_reg)
{
    wemit_write_abs_pre(E, p);
    e_get(WLOC_INT(host_reg));
    wemit_store(E, WOP_I32_STORE16, 0, 0);
}
void
codegen_direct_write_32(UNUSED(codeblock_t *block), void *p, int host_reg)
{
    wemit_write_abs_pre(E, p);
    e_get(WLOC_INT(host_reg));
    wemit_store(E, WOP_I32_STORE, 0, 0);
}
void
codegen_direct_write_ptr(UNUSED(codeblock_t *block), void *p, int host_reg)
{
    wemit_write_abs_pre(E, p);
    e_get(WLOC_INT(host_reg));
    wemit_store(E, WOP_I32_STORE, 0, 0);
}
void
codegen_direct_write_64(UNUSED(codeblock_t *block), void *p, int host_reg)
{
    wemit_write_abs_pre(E, p);
    e_get(WLOC_FP(host_reg));
    wemit_store(E, WOP_F64_STORE, 0, 0);
}
void
codegen_direct_write_double(UNUSED(codeblock_t *block), void *p, int host_reg)
{
    wemit_write_abs_pre(E, p);
    e_get(WLOC_FP(host_reg));
    wemit_store(E, WOP_F64_STORE, 0, 0);
}
void
codegen_direct_write_st_8(UNUSED(codeblock_t *block), void *base, int reg_idx, int host_reg)
{
    e_st_addr(base, reg_idx, 0);
    e_get(WLOC_INT(host_reg));
    wemit_store(E, WOP_I32_STORE8, 0, 0);
}
void
codegen_direct_write_st_64(UNUSED(codeblock_t *block), void *base, int reg_idx, int host_reg)
{
    e_st_addr(base, reg_idx, 3);
    e_get(WLOC_FP(host_reg));
    wemit_store(E, WOP_F64_STORE, 0, 0);
}
void
codegen_direct_write_st_double(UNUSED(codeblock_t *block), void *base, int reg_idx, int host_reg)
{
    e_st_addr(base, reg_idx, 3);
    e_get(WLOC_FP(host_reg));
    wemit_store(E, WOP_F64_STORE, 0, 0);
}

/* stack slots (the block's temporaries) are dedicated locals */
static int
wloc_stack_i32(int stack_offset)
{
    switch (stack_offset - CODEGEN_TEMP_BASE) {
        case 16:
            return WLOC_STACK_I32_16;
        case 20:
            return WLOC_STACK_I32_20;
        case 24:
            return WLOC_STACK_I32_24;
        case 28:
            return WLOC_STACK_I32_28;
        case 32:
            return WLOC_TOPDIFF;
        default:
            break;
    }
    fatal("wasm JIT: bad i32 stack slot %i\n", stack_offset);
    return 0;
}
static int
wloc_stack_f64(int stack_offset)
{
    switch (stack_offset - CODEGEN_TEMP_BASE) {
        case 40:
            return WLOC_STACK_F64_40;
        case 48:
            return WLOC_STACK_F64_48;
        case 56:
            return WLOC_STACK_F64_56;
        default:
            break;
    }
    fatal("wasm JIT: bad f64 stack slot %i\n", stack_offset);
    return 0;
}

void
codegen_direct_read_16_stack(UNUSED(codeblock_t *block), int host_reg, int stack_offset)
{
    e_get(wloc_stack_i32(stack_offset));
    e_i32(0xffff);
    e_op(WOP_I32_AND);
    e_set(WLOC_INT(host_reg));
}
void
codegen_direct_read_32_stack(UNUSED(codeblock_t *block), int host_reg, int stack_offset)
{
    e_get(wloc_stack_i32(stack_offset));
    e_set(WLOC_INT(host_reg));
}
void
codegen_direct_read_pointer_stack(UNUSED(codeblock_t *block), int host_reg, int stack_offset)
{
    e_get(wloc_stack_i32(stack_offset));
    e_set(WLOC_INT(host_reg));
}
void
codegen_direct_read_64_stack(UNUSED(codeblock_t *block), int host_reg, int stack_offset)
{
    e_get(wloc_stack_f64(stack_offset));
    e_set(WLOC_FP(host_reg));
}
void
codegen_direct_read_double_stack(UNUSED(codeblock_t *block), int host_reg, int stack_offset)
{
    e_get(wloc_stack_f64(stack_offset));
    e_set(WLOC_FP(host_reg));
}
void
codegen_direct_write_32_stack(UNUSED(codeblock_t *block), int stack_offset, int host_reg)
{
    e_get(WLOC_INT(host_reg));
    e_set(wloc_stack_i32(stack_offset));
}
void
codegen_direct_write_64_stack(UNUSED(codeblock_t *block), int stack_offset, int host_reg)
{
    e_get(WLOC_FP(host_reg));
    e_set(wloc_stack_f64(stack_offset));
}
void
codegen_direct_write_double_stack(UNUSED(codeblock_t *block), int stack_offset, int host_reg)
{
    e_get(WLOC_FP(host_reg));
    e_set(wloc_stack_f64(stack_offset));
}

/* immediates straight to memory / stack slots (CODEGEN_BACKEND_HAS_MOV_IMM) */
void
codegen_direct_write_8_imm(UNUSED(codeblock_t *block), void *p, uint8_t imm_data)
{
    wemit_write_abs_pre(E, p);
    e_i32(imm_data);
    wemit_store(E, WOP_I32_STORE8, 0, 0);
}
void
codegen_direct_write_16_imm(UNUSED(codeblock_t *block), void *p, uint16_t imm_data)
{
    wemit_write_abs_pre(E, p);
    e_i32(imm_data);
    wemit_store(E, WOP_I32_STORE16, 0, 0);
}
void
codegen_direct_write_32_imm(UNUSED(codeblock_t *block), void *p, uint32_t imm_data)
{
    wemit_write_abs_pre(E, p);
    e_i32(imm_data);
    wemit_store(E, WOP_I32_STORE, 0, 0);
}
void
codegen_direct_write_32_imm_stack(UNUSED(codeblock_t *block), int stack_offset, uint32_t imm_data)
{
    e_i32(imm_data);
    e_set(wloc_stack_i32(stack_offset));
}

#endif /* __EMSCRIPTEN__ */
