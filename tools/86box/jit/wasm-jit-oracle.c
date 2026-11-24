/*
 * wasm-jit-oracle.c - interpreter-differential oracle for the WebAssembly
 * backend of 86Box's dynamic recompiler. Only built with -DWJIT_ORACLE (a
 * validation build: several times slower than the interpreter).
 *
 * After PCem-WebAssembly's wasm/jit/wasm-jit-oracle.c (GPLv2). Every run of
 * a compiled block is checked against the interpreter:
 *
 *   1. snapshot cpu_state and the few globals the recompiled code depends
 *      on; flush the write lookups and keep them from being refilled, so
 *      every RAM write goes through mem_write_ram*_page(), which records
 *      the bytes it is about to change;
 *   2. run the compiled block. An access to anything but RAM (a device, a
 *      ROM) taints the run: it cannot be replayed, the result stands and
 *      the run is counted as skipped;
 *   3. otherwise put RAM and the state back and run the same instructions
 *      one at a time with the interpreter, comparing after each: the
 *      architectural state and the final contents of every byte either
 *      side wrote must be identical;
 *   4. a divergence is logged with both states and counted. The block's
 *      instructions are then run once more by the interpreter and that
 *      result is kept, so the guest carries on correctly and further
 *      divergences can be collected.
 *
 * Licensed under GPLv2 or later, as 86Box itself.
 */
#if defined(__EMSCRIPTEN__) && defined(WJIT_ORACLE)

#    include <stdio.h>
#    include <stdint.h>
#    include <stdlib.h>
#    include <stddef.h>
#    include <string.h>
#    include <86box/86box.h>
#    include "cpu.h"
#    include <86box/mem.h>
#    include <86box/plat_unused.h>

#    include "x86.h"
#    include "x86seg_common.h"
#    include "x86seg.h"
#    include "x87_sf.h"
#    include "x87.h"
#    include "x86_flags.h"
#    include "codegen.h"
#    include "codegen_backend.h"

int wjit_oracle_phase  = 0; /* 0 off, 1 compiled run, 2 interpreter replay */
int wjit_oracle_nofill = 0; /* addwritelookup() does nothing */

uint32_t wjit_oracle_verified;
uint32_t wjit_oracle_skipped;        /* compiled run touched a device */
uint32_t wjit_oracle_replay_skipped; /* only the replay touched a device */
uint32_t wjit_oracle_mismatches;
uint32_t wjit_oracle_unverifiable;   /* runs of blocks that call interpreter handlers */

static int taint;

extern void wjit_oracle_interp_step(void); /* 386_dynarec.c */
extern int  inrecomp;

/* ---- bytes written, per phase ------------------------------------------------ */

#    define WMAP_SIZE 16384 /* power of two */
#    define WMAP_MAX  (WMAP_SIZE / 2)

typedef struct wmap_t {
    uint8_t *addr[WMAP_SIZE]; /* host address, NULL = free */
    uint8_t  orig[WMAP_SIZE];
    uint8_t  final[WMAP_SIZE];
    uint16_t used[WMAP_MAX];
    int      nr;
} wmap_t;

static wmap_t wmap[2];

static void
wmap_clear(wmap_t *m)
{
    for (int c = 0; c < m->nr; c++)
        m->addr[m->used[c]] = NULL;
    m->nr = 0;
}

static int
wmap_find(const wmap_t *m, const uint8_t *p)
{
    uint32_t h = (((uintptr_t) p) * 2654435761u) >> 18;

    for (;;) {
        h &= (WMAP_SIZE - 1);
        if (m->addr[h] == p)
            return (int) h;
        if (!m->addr[h])
            return -1 - (int) h;
        h++;
    }
}

/* Called by mem_write_ram*_page() before it writes. */
void
wjit_oracle_note_ram_write(uint8_t *host, int size)
{
    wmap_t *m = &wmap[wjit_oracle_phase - 1];

    for (int c = 0; c < size; c++) {
        int slot = wmap_find(m, &host[c]);

        if (slot >= 0)
            continue;
        if (m->nr >= WMAP_MAX) {
            taint = 1;
            return;
        }
        slot            = -1 - slot;
        m->addr[slot]   = &host[c];
        m->orig[slot]   = host[c];
        m->used[m->nr++] = (uint16_t) slot;
    }
}

/* Called for an access that is not to RAM. */
void
wjit_oracle_note_io(void)
{
    taint = 1;
}

static void
wmap_capture_final(wmap_t *m)
{
    for (int c = 0; c < m->nr; c++)
        m->final[m->used[c]] = *m->addr[m->used[c]];
}

static void
wmap_rollback(const wmap_t *m)
{
    for (int c = 0; c < m->nr; c++)
        *m->addr[m->used[c]] = m->orig[m->used[c]];
}

static void
wmap_reapply(const wmap_t *m)
{
    for (int c = 0; c < m->nr; c++)
        *m->addr[m->used[c]] = m->final[m->used[c]];
}

/* The bytes the compiled run (a) left against RAM as the replay (b) has it
   now. Returns the number that differ. */
static int
wmap_diff(const wmap_t *a, const wmap_t *b, int log)
{
    int diffs = 0;

    for (int c = 0; c < a->nr; c++) {
        int slot = a->used[c];

        if (*a->addr[slot] != a->final[slot]) {
            if (log && (diffs < 16))
                wjit_log("jit-oracle:   ram+%08x jit=%02x interp=%02x (was %02x)\n", (uint32_t) (a->addr[slot] - ram),
                      a->final[slot], *a->addr[slot], a->orig[slot]);
            diffs++;
        }
    }
    for (int c = 0; c < b->nr; c++) {
        int slot = b->used[c];

        /* written by the replay only: the compiled run left it alone */
        if ((wmap_find(a, b->addr[slot]) < 0) && (*b->addr[slot] != b->orig[slot])) {
            if (log && (diffs < 16))
                wjit_log("jit-oracle:   ram+%08x jit=(untouched %02x) interp=%02x\n", (uint32_t) (b->addr[slot] - ram),
                      b->orig[slot], *b->addr[slot]);
            diffs++;
        }
    }
    return diffs;
}

/* ---- state snapshot / compare ------------------------------------------------ */

typedef struct oracle_state_t {
    cpu_state_t st;
    uint32_t    use32_;
    int         stack32_;
    uint16_t    cpu_cur_status_;
    int         end_block_after_ins_;
    int         new_ne_;
    int         flush_pending_;
    uint16_t    oldcs_;
    int         oldcpl_;
    int         trap_;
    int         block_end_;
} oracle_state_t;

static void
state_save(oracle_state_t *s)
{
    memcpy(&s->st, &cpu_state, sizeof(cpu_state_t));
    s->use32_               = use32;
    s->stack32_             = stack32;
    s->cpu_cur_status_      = cpu_cur_status;
    s->end_block_after_ins_ = cpu_end_block_after_ins;
    s->new_ne_              = new_ne;
    s->flush_pending_       = cpu_flush_pending;
    s->oldcs_               = oldcs;
    s->oldcpl_              = oldcpl;
    s->trap_                = trap;
    s->block_end_           = cpu_block_end;
}

static void
state_restore(const oracle_state_t *s)
{
    memcpy(&cpu_state, &s->st, sizeof(cpu_state_t));
    use32                   = s->use32_;
    stack32                 = s->stack32_;
    cpu_cur_status          = s->cpu_cur_status_;
    cpu_end_block_after_ins = s->end_block_after_ins_;
    new_ne                  = s->new_ne_;
    cpu_flush_pending       = s->flush_pending_;
    oldcs                   = s->oldcs_;
    oldcpl                  = s->oldcpl_;
    trap                    = s->trap_;
    cpu_block_end           = s->block_end_;
}

/* The recompiler's contract, not the whole struct. Left out on purpose:
     _cycles                  the timing of the two differs by design (the
                              lookups are refilled at different moments);
     old/new_fp_control       rounding mode plumbing of the backends;
     MM_w4                    interpreter-side scratch;
     oldpc                    kept per instruction by the interpreter, but
                              only before a possible fault by compiled code;
                              compared when the block aborted;
     ea_seg/eaaddr/ssegs/op32/rm_data
                              decode scratch, set again by both before use;
     seg_*.checked            a cache of the recompiler;
     temp_*, x87_op, x87_operand
                              scratch of the FPU exception reporting;
     fpu_op, fpu_CS/cs/pc, fpu_DS/ds/ea
                              compared only with cpu_dyn_accurate_fpu_env.  */
#    define F(field)                                                    \
        {                                                               \
#field, offsetof(cpu_state_t, field), sizeof(((cpu_state_t *) 0)->field) \
        }
#    define FSEG(seg)                                                                   \
        {                                                                               \
#seg, offsetof(cpu_state_t, seg), offsetof(x86seg, checked)                             \
        }
static const struct {
    const char *name;
    size_t      off;
    size_t      len;
} cmp_fields[] = {
    F(regs),
    F(tag),
    F(flags_op),
    F(flags_res),
    F(flags_op1),
    F(flags_op2),
    F(pc),
    F(TOP),
    F(ismmx),
    F(abrt),
    F(npxs),
    F(npxc),
    F(ST),
    F(MM),
    FSEG(seg_cs),
    FSEG(seg_ds),
    FSEG(seg_es),
    FSEG(seg_ss),
    FSEG(seg_fs),
    FSEG(seg_gs),
    F(CR0),
    F(flags),
    F(eflags),
    F(_smbase),
    F(fpu_op),
    F(fpu_CS),
    F(fpu_cs),
    F(fpu_pc),
    F(fpu_DS),
    F(fpu_ds),
    F(fpu_ea),
    F(sf_exc),
};
#    undef F
#    undef FSEG
#    define N_CMP_FIELDS (int) (sizeof(cmp_fields) / sizeof(cmp_fields[0]))

static int
state_diff(const cpu_state_t *a, const cpu_state_t *b, int log)
{
    int diffs = 0;

    for (int i = 0; i < N_CMP_FIELDS; i++) {
        const uint8_t *pa = (const uint8_t *) a + cmp_fields[i].off;
        const uint8_t *pb = (const uint8_t *) b + cmp_fields[i].off;

        if (memcmp(pa, pb, cmp_fields[i].len)) {
            /* The FPU instruction and operand pointers and opcode (FSTENV,
               FSAVE) are only kept by compiled code when the VM asks for
               it: upstream behaviour, cpu_dyn_accurate_fpu_env. */
            if (!cpu_dyn_accurate_fpu_env && (cmp_fields[i].off >= offsetof(cpu_state_t, fpu_CS)) &&
                (cmp_fields[i].off <= offsetof(cpu_state_t, fpu_ea)))
                continue;
            /* While the flags are held as an operation and its operands
               (flags_op), the status bits of the flags word are stale on
               both sides and nobody reads them. */
            if ((cmp_fields[i].off == offsetof(cpu_state_t, flags)) && (a->flags_op != FLAGS_UNKNOWN) &&
                (b->flags_op != FLAGS_UNKNOWN) &&
                !((a->flags ^ b->flags) & ~(C_FLAG | P_FLAG | A_FLAG | Z_FLAG | N_FLAG | V_FLAG)))
                continue;
            diffs++;
            if (log) {
                char   ha[160];
                char   hb[160];
                size_t n = cmp_fields[i].len > 64 ? 64 : cmp_fields[i].len;

                for (size_t c = 0; c < n; c++) {
                    sprintf(ha + c * 2, "%02x", pa[c]);
                    sprintf(hb + c * 2, "%02x", pb[c]);
                }
                wjit_log("jit-oracle:   field %-10s jit=%s interp=%s\n", cmp_fields[i].name, ha, hb);
            }
        }
    }
    return diffs;
}

/* sjit: the state the compiled block left; the current state is the replay's */
static int
globals_equal(const oracle_state_t *s, int log)
{
    int ok = 1;

#    define G(name, saved)                                                              \
        if ((name) != (saved)) {                                                        \
            if (log)                                                                    \
                wjit_log("jit-oracle:   global %s jit=%x interp=%x\n", #name, (unsigned) (saved), (unsigned) (name)); \
            ok = 0;                                                                     \
        }
    G(use32, s->use32_)
    G(stack32, s->stack32_)
    G(cpu_cur_status, s->cpu_cur_status_)
    G(cpu_end_block_after_ins, s->end_block_after_ins_)
    G(new_ne, s->new_ne_)
    G(cpu_flush_pending, s->flush_pending_)
#    undef G
    return ok;
}

static int
states_match(const oracle_state_t *sjit, int log)
{
    int ok = 1;

    if (state_diff(&sjit->st, &cpu_state, log))
        ok = 0;
    if (!globals_equal(sjit, log))
        ok = 0;
    if (cpu_state.abrt && (cpu_state.oldpc != sjit->st.oldpc)) {
        if (log)
            wjit_log("jit-oracle:   oldpc at the abort jit=%08x interp=%08x\n", sjit->st.oldpc, cpu_state.oldpc);
        ok = 0;
    }
    if (!ok && !log)
        return 0;
    if (wmap_diff(&wmap[0], &wmap[1], log))
        ok = 0;
    return ok;
}

static void
oracle_report(const codeblock_t *block, const oracle_state_t *s0, const oracle_state_t *sjit, int steps)
{
    static int reported;
    char       buf[160];
    int        o    = 0;
    uint32_t   base = s0->st.seg_cs.base + s0->st.pc;

    wjit_oracle_mismatches++;
    if (reported >= 40)
        return;
    reported++;

    wjit_log("jit-oracle: MISMATCH #%u block pc=%08x cs=%08x phys=%08x ins=%d flags=%04x status=%04x, %d interpreter steps\n",
          wjit_oracle_mismatches, block->pc, block->_cs, block->phys, block->ins, block->flags, block->status, steps);
    {
        uint8_t abrt = cpu_state.abrt;

        for (int k = 0; k < 40; k++)
            o += sprintf(buf + o, "%02x ", readmembl(base + k));
        cpu_state.abrt = abrt;
    }
    wjit_log("jit-oracle:  code @%08x: %s\n", base, buf);
    wjit_log("jit-oracle:  start: eax=%08x ecx=%08x edx=%08x ebx=%08x esp=%08x ebp=%08x esi=%08x edi=%08x flags=%04x op=%d\n",
          s0->st.regs[0].l, s0->st.regs[1].l, s0->st.regs[2].l, s0->st.regs[3].l, s0->st.regs[4].l, s0->st.regs[5].l,
          s0->st.regs[6].l, s0->st.regs[7].l, s0->st.flags, s0->st.flags_op);
    states_match(sjit, 1);
}

/* ---- driver ------------------------------------------------------------------------ */

void
wjit_oracle_exec(codeblock_t *block, void (*code)(void))
{
    static oracle_state_t s0;
    static oracle_state_t sjit;
    int                   steps;
    int                   max_steps;

    /* A block that calls instruction handlers can do port I/O or change
       system state kept outside cpu_state, and the handlers compiled code
       calls (x86_dynarec_opcodes) are not the ones the interpreter loop
       uses: such a run is not replayed. */
    if (codegen_wasm_block_callouts(block->data)) {
        inrecomp = 1;
        code();
        inrecomp = 0;
        wjit_oracle_unverifiable++;
        return;
    }

    state_save(&s0);

    flushmmucache_nopc();
    wjit_oracle_nofill = 1;
    taint              = 0;
    wmap_clear(&wmap[0]);
    wmap_clear(&wmap[1]);

    wjit_oracle_phase = 1;
    inrecomp          = 1;
    code();
    inrecomp          = 0;
    wjit_oracle_phase = 0;

    if (taint) {
        /* device traffic: not replayable, the compiled result stands */
        wjit_oracle_nofill = 0;
        wjit_oracle_skipped++;
        return;
    }

    state_save(&sjit);
    wmap_capture_final(&wmap[0]);

    /* roll back and replay with the interpreter */
    wmap_rollback(&wmap[0]);
    state_restore(&s0);
    flushmmucache_nopc();
    wjit_oracle_phase = 2;

    /* A block left before its first instruction did anything (a guard that
       hands the instruction to the interpreter) changes nothing. */
    if (states_match(&sjit, 0)) {
        wjit_oracle_phase  = 0;
        wjit_oracle_nofill = 0;
        state_restore(&sjit);
        wjit_oracle_verified++;
        return;
    }

    /* A compiled block can run more instructions than block->ins (small
       loops are unrolled), so the interpreter is stepped until it
       reproduces the compiled block's state, not a fixed number of times. */
    max_steps = (block->ins ? block->ins : 1) * 64 + 64;
    for (steps = 1; steps <= max_steps; steps++) {
        wjit_oracle_interp_step();

        if (taint) {
            /* only the replay reached a device: give up on this run and
               take the compiled block's result */
            wjit_oracle_phase = 0;
            wmap_rollback(&wmap[1]);
            wmap_reapply(&wmap[0]);
            state_restore(&sjit);
            flushmmucache_nopc();
            wjit_oracle_nofill = 0;
            wjit_oracle_replay_skipped++;
            return;
        }

        if (states_match(&sjit, 0)) {
            int cyc = sjit.st._cycles;

            /* verified; the compiled block's cycle count is the one kept,
               so that the oracle build keeps the recompiler's timing */
            wjit_oracle_phase  = 0;
            wjit_oracle_nofill = 0;
            cpu_state._cycles  = cyc;
            flushmmucache_nopc();
            wjit_oracle_verified++;
            return;
        }

        if (cpu_state.abrt)
            break;
    }

    /* Run the block's instructions with the interpreter alone, report how
       the two differ after them, and keep the interpreter's result. */
    wmap_rollback(&wmap[1]);
    wmap_clear(&wmap[1]);
    state_restore(&s0);
    flushmmucache_nopc();
    for (steps = 0; steps < (block->ins ? block->ins : 1); steps++) {
        wjit_oracle_interp_step();
        if (cpu_state.abrt)
            break;
    }
    oracle_report(block, &s0, &sjit, steps);
    wjit_oracle_phase  = 0;
    wjit_oracle_nofill = 0;
    flushmmucache_nopc();
}

#endif /* __EMSCRIPTEN__ && WJIT_ORACLE */
