# Retro486 - PROVAJIT.COM: programma di prova per il ricompilatore dinamico.
# Esegue in ciclo istruzioni intere a 8/16/32 bit, salti condizionati, stringhe e x87 su valori
# pseudocasuali e ne accumula risultati e flag in una somma di controllo, che stampa alla fine.
# La stessa somma deve uscire con l'interprete e con il ricompilatore; nella build con l'oracolo
# (WJIT_ORACLE) ogni blocco compilato viene anche confrontato con l'interprete.
#   as --32 provajit.S -o provajit.o && ld -m elf_i386 -Ttext 0x100 --oformat binary -o PROVAJIT.COM provajit.o
        .code16
        .intel_syntax noprefix
        .text
        .globl  _start

        .equ    GIRI, 3000

# accumula un registro a 32 bit e i flag (SF ZF AF PF CF in AH, OF in AL) nella somma
        .macro  ACC reg
        mov     dword ptr [tmp], \reg
        lahf
        seto    al
        add     word ptr [chk], ax
        rol     dword ptr [chk], 3
        mov     eax, dword ptr [tmp]
        xor     dword ptr [chk], eax
        rol     dword ptr [chk], 5
        cmp     eax, 0x1234             # lascia flag tutti definiti
        .endm
# solo i flag definiti dall'istruzione: maschera in AH (SF=80 ZF=40 AF=10 PF=04 CF=01), OF se of=1
        .macro  ACCF reg, mask, of
        mov     dword ptr [tmp], \reg
        lahf
        seto    al
        and     ah, \mask
        .if     \of == 0
        mov     al, 0
        .endif
        add     word ptr [chk], ax
        rol     dword ptr [chk], 3
        mov     eax, dword ptr [tmp]
        xor     dword ptr [chk], eax
        rol     dword ptr [chk], 5
        cmp     eax, 0x1234
        .endm
# numero pseudocasuale a 32 bit in EAX
        .macro  RND
        mov     eax, dword ptr [seme]
        imul    eax, eax, 1103515245
        add     eax, 12345
        mov     dword ptr [seme], eax
        .endm

_start:
        cld
        mov     dword ptr [chk], 0x12345678
        mov     dword ptr [seme], 0x2545F491
        mov     word ptr [giri], GIRI
        fninit
ciclo:
        call    p_alu8
        call    p_alu16
        call    p_alu32
        call    p_scorri
        call    p_muldiv
        call    p_bit
        call    p_salti
        call    p_stringhe
        call    p_pila
        call    p_x87
        dec     word ptr [giri]
        jz      fine
        jmp     ciclo
fine:
        # stampa la somma in esadecimale
        mov     ebx, dword ptr [chk]
        mov     cx, 8
st1:    rol     ebx, 4
        mov     dl, bl
        and     dl, 15
        add     dl, '0'
        cmp     dl, '9'
        jbe     st2
        add     dl, 7
st2:    mov     ah, 2
        int     0x21
        loop    st1
        mov     dx, offset acapo
        mov     ah, 9
        int     0x21
        mov     ax, 0x4c00
        int     0x21

# ---------------------------------------------------------------- ALU a 8 bit
p_alu8:
        RND
        mov     ebx, eax
        RND
        mov     ecx, eax
        mov     edx, ebx
        add     dl, cl
        ACC     edx
        mov     edx, ebx
        add     dh, ch
        adc     dl, ch
        ACC     edx
        mov     edx, ebx
        sub     dl, cl
        sbb     dh, cl
        ACC     edx
        mov     edx, ebx
        and     dl, ch
        ACC     edx
        mov     edx, ebx
        or      dh, cl
        ACC     edx
        mov     edx, ebx
        xor     dl, dh
        ACC     edx
        mov     edx, ebx
        cmp     dl, cl
        ACC     edx
        cmp     dh, 0x7f
        ACC     edx
        test    dl, ch
        ACC     edx
        mov     edx, ebx
        inc     dl
        ACC     edx
        dec     dh
        ACC     edx
        neg     dl
        ACC     edx
        not     dh
        ACC     edx
        mov     byte ptr [mem], bl
        add     byte ptr [mem], cl
        ACC     edx
        sub     byte ptr [mem+1], ch
        ACC     edx
        xor     byte ptr [mem], 0x5a
        ACC     edx
        mov     dl, byte ptr [mem]
        add     dl, byte ptr [mem+1]
        ACC     edx
        add     dl, 0x80
        ACC     edx
        sub     dh, 0x01
        ACC     edx
        ret

# ---------------------------------------------------------------- ALU a 16 bit
p_alu16:
        RND
        mov     ebx, eax
        RND
        mov     ecx, eax
        mov     edx, ebx
        add     dx, cx
        ACC     edx
        adc     dx, bx
        ACC     edx
        sub     dx, cx
        ACC     edx
        sbb     dx, 0x1234
        ACC     edx
        and     dx, cx
        ACC     edx
        or      dx, bx
        ACC     edx
        xor     dx, 0xa55a
        ACC     edx
        cmp     dx, cx
        ACC     edx
        test    dx, bx
        ACC     edx
        inc     dx
        ACC     edx
        dec     dx
        ACC     edx
        neg     dx
        ACC     edx
        not     dx
        ACC     edx
        mov     word ptr [mem], bx
        add     word ptr [mem], cx
        ACC     edx
        adc     word ptr [mem], 7
        ACC     edx
        sub     word ptr [mem+2], cx
        ACC     edx
        mov     si, offset mem
        mov     dx, word ptr [si]
        add     dx, word ptr [si+2]
        ACC     edx
        mov     bp, 2
        xor     dx, word ptr ds:[bp+si]
        ACC     edx
        add     dx, -1
        ACC     edx
        cmp     dx, 0x8000
        ACC     edx
        movzx   dx, bl
        ACC     edx
        movsx   dx, bh
        ACC     edx
        mov     ax, bx
        cbw
        cwd
        mov     word ptr [tmp2], ax
        mov     word ptr [tmp2+2], dx
        mov     edx, dword ptr [tmp2]
        ACC     edx
        xchg    bx, cx
        mov     edx, ebx
        ACC     edx
        xchg    bl, ch
        mov     edx, ebx
        ACC     edx
        lea     dx, [bx+si+0x1234]
        ACC     edx
        ret

# ---------------------------------------------------------------- ALU a 32 bit
p_alu32:
        RND
        mov     ebx, eax
        RND
        mov     ecx, eax
        mov     edx, ebx
        add     edx, ecx
        ACC     edx
        adc     edx, ebx
        ACC     edx
        sub     edx, ecx
        ACC     edx
        sbb     edx, 0x12345678
        ACC     edx
        and     edx, ecx
        ACC     edx
        or      edx, ebx
        ACC     edx
        xor     edx, 0xa55a3cc3
        ACC     edx
        cmp     edx, ecx
        ACC     edx
        test    edx, ebx
        ACC     edx
        inc     edx
        ACC     edx
        dec     edx
        ACC     edx
        neg     edx
        ACC     edx
        not     edx
        ACC     edx
        mov     dword ptr [mem], ebx
        add     dword ptr [mem], ecx
        ACC     edx
        sub     dword ptr [mem+4], ecx
        ACC     edx
        mov     edx, dword ptr [mem]
        add     edx, dword ptr [mem+4]
        ACC     edx
        add     edx, -1
        ACC     edx
        cmp     edx, 0x80000000
        ACC     edx
        movzx   edx, bl
        ACC     edx
        movzx   edx, bx
        ACC     edx
        movsx   edx, bh
        ACC     edx
        movsx   edx, bx
        ACC     edx
        mov     eax, ebx
        cwde
        cdq
        xor     edx, eax
        ACC     edx
        mov     edx, ebx
        bswap   edx
        ACC     edx
        # indirizzamento a 32 bit: registri piccoli, per restare nel segmento
        movzx   esi, bl
        movzx   edi, cl
        lea     edx, [esi+edi*4+0x1234]
        ACC     edx
        lea     edx, [ebx+ecx*8-5]
        ACC     edx
        mov     edx, dword ptr [esi+edi*2+tab]
        ACC     edx
        mov     dword ptr [esi+tab+4], ecx
        add     edx, dword ptr [esi+tab+4]
        ACC     edx
        xadd    edx, ebx
        ACC     edx
        mov     eax, ecx
        cmpxchg edx, ebx
        ACC     edx
        mov     eax, edx
        cmpxchg edx, ecx
        ACC     edx
        ret

# ---------------------------------------------------------------- scorrimenti e rotazioni
p_scorri:
        RND
        mov     ebx, eax
        RND
        mov     ecx, eax
        and     cl, 31
        mov     edx, ebx
        shl     edx, 1
        ACC     edx
        mov     edx, ebx
        shr     edx, 1
        ACC     edx
        mov     edx, ebx
        sar     edx, 1
        ACC     edx
        mov     edx, ebx
        shl     dx, 1
        ACC     edx
        mov     edx, ebx
        shr     dl, 1
        ACC     edx
        mov     edx, ebx
        sar     dh, 1
        ACC     edx
        mov     edx, ebx
        rol     edx, 1
        ACCF    edx, 0x01, 1
        mov     edx, ebx
        ror     dx, 1
        ACCF    edx, 0x01, 1
        mov     edx, ebx
        rol     dl, 1
        ACCF    edx, 0x01, 1
        mov     edx, ebx
        stc
        rcl     edx, 1
        ACCF    edx, 0x01, 1
        mov     edx, ebx
        clc
        rcr     dx, 1
        ACCF    edx, 0x01, 1
        # con conteggio immediato: OF e AF non definiti
        mov     edx, ebx
        shl     edx, 5
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        shr     edx, 9
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        sar     edx, 13
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        shl     dx, 3
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        shr     dx, 7
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        sar     dl, 2
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        shl     dh, 4
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        rol     edx, 7
        ACCF    edx, 0x01, 0
        mov     edx, ebx
        ror     edx, 11
        ACCF    edx, 0x01, 0
        mov     edx, ebx
        rol     dx, 5
        ACCF    edx, 0x01, 0
        mov     edx, ebx
        ror     dl, 3
        ACCF    edx, 0x01, 0
        # con conteggio in CL (anche zero: i flag restano quelli di prima)
        mov     edx, ebx
        cmp     ebx, ecx
        shl     edx, cl
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        cmp     ebx, ecx
        shr     edx, cl
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        cmp     ebx, ecx
        sar     edx, cl
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        cmp     ebx, ecx
        shl     dx, cl
        mov     dword ptr [tmp2], edx
        mov     edx, ebx
        shr     dl, cl
        add     edx, dword ptr [tmp2]
        ACCF    edx, 0x00, 0
        mov     edx, ebx
        rol     edx, cl
        ACCF    edx, 0x00, 0
        mov     edx, ebx
        ror     edx, cl
        ACCF    edx, 0x00, 0
        mov     edx, ebx
        rol     dx, cl
        ACCF    edx, 0x00, 0
        mov     edx, ebx
        ror     dh, cl
        ACCF    edx, 0x00, 0
        mov     edx, ebx
        mov     esi, ecx
        shld    edx, esi, 7
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        shrd    edx, esi, 9
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        shld    dx, si, 3
        ACCF    edx, 0xc5, 0
        mov     edx, ebx
        and     cl, 15
        jz      sc1
        shrd    dx, si, cl
        ACCF    edx, 0xc5, 0
sc1:    ret

# ---------------------------------------------------------------- moltiplicazioni e divisioni
p_muldiv:
        RND
        mov     ebx, eax
        RND
        mov     ecx, eax
        mov     eax, ebx
        mul     cl
        ACCF    eax, 0x01, 1
        mov     eax, ebx
        imul    ch
        ACCF    eax, 0x01, 1
        mov     eax, ebx
        mul     cx
        mov     word ptr [tmp2], ax
        mov     word ptr [tmp2+2], dx
        ACCF    edx, 0x01, 1
        mov     edx, dword ptr [tmp2]
        ACCF    edx, 0x00, 0
        mov     eax, ebx
        imul    cx
        mov     word ptr [tmp2], ax
        mov     word ptr [tmp2+2], dx
        ACCF    edx, 0x01, 1
        mov     edx, dword ptr [tmp2]
        ACCF    edx, 0x00, 0
        mov     eax, ebx
        mul     ecx
        mov     esi, eax
        ACCF    edx, 0x01, 1
        ACCF    esi, 0x00, 0
        mov     eax, ebx
        imul    ecx
        mov     esi, eax
        ACCF    edx, 0x01, 1
        ACCF    esi, 0x00, 0
        mov     edx, ebx
        imul    dx, cx
        ACCF    edx, 0x01, 1
        mov     edx, ebx
        imul    edx, ecx
        ACCF    edx, 0x01, 1
        imul    edx, ebx, 1000
        ACCF    edx, 0x01, 1
        imul    dx, cx, -7
        ACCF    edx, 0x01, 1
        # divisioni: divisore mai zero, quoziente che sta nel registro
        mov     eax, ebx
        xor     edx, edx
        mov     esi, ecx
        or      esi, 1
        div     esi
        mov     edi, eax
        ACCF    edx, 0x00, 0
        ACCF    edi, 0x00, 0
        mov     eax, ebx
        cdq
        idiv    esi
        mov     edi, eax
        ACCF    edx, 0x00, 0
        ACCF    edi, 0x00, 0
        mov     ax, bx
        xor     dx, dx
        mov     si, cx
        or      si, 1
        div     si
        mov     word ptr [tmp2], ax
        mov     word ptr [tmp2+2], dx
        mov     edx, dword ptr [tmp2]
        ACCF    edx, 0x00, 0
        mov     ax, bx
        cwd
        idiv    si
        mov     word ptr [tmp2], ax
        mov     word ptr [tmp2+2], dx
        mov     edx, dword ptr [tmp2]
        ACCF    edx, 0x00, 0
        movzx   ax, bl
        mov     dl, cl
        or      dl, 1
        div     dl
        movzx   edx, ax
        ACCF    edx, 0x00, 0
        ret

# ---------------------------------------------------------------- bit, SETcc
p_bit:
        RND
        mov     ebx, eax
        RND
        mov     ecx, eax
        mov     edx, ebx
        or      edx, 0x00010000
        bsf     esi, edx
        ACCF    esi, 0x40, 0
        bsr     esi, edx
        ACCF    esi, 0x40, 0
        mov     dx, bx
        or      dx, 0x0100
        bsf     si, dx
        movzx   esi, si
        ACCF    esi, 0x40, 0
        bsr     si, dx
        movzx   esi, si
        ACCF    esi, 0x40, 0
        mov     edx, ebx
        mov     esi, ecx
        and     esi, 31
        bt      edx, esi
        ACCF    edx, 0x01, 0
        bts     edx, esi
        ACCF    edx, 0x01, 0
        btr     edx, 5
        ACCF    edx, 0x01, 0
        btc     edx, esi
        ACCF    edx, 0x01, 0
        mov     si, cx
        and     si, 15
        bt      dx, si
        ACCF    edx, 0x01, 0
        btc     dx, 9
        ACCF    edx, 0x01, 0
        # SETcc dopo un confronto: tutte le condizioni
        cmp     ebx, ecx
        seto    dl
        setno   dh
        ror     edx, 16
        setb    dl
        setae   dh
        ror     edx, 8
        sete    dl
        setne   dh
        mov     esi, edx
        cmp     bx, cx
        setbe   dl
        seta    dh
        ror     edx, 16
        sets    dl
        setns   dh
        ror     edx, 8
        setp    dl
        setnp   dh
        xor     esi, edx
        cmp     bl, cl
        setl    dl
        setge   dh
        ror     edx, 16
        setle   dl
        setg    dh
        xor     esi, edx
        ACCF    esi, 0x00, 0
        test    bl, 0x0f
        setz    byte ptr [mem]
        add     bl, cl
        setc    byte ptr [mem+1]
        mov     dx, word ptr [mem]
        ACCF    edx, 0x00, 0
        # decimali
        mov     ax, bx
        add     al, cl
        daa
        mov     dx, ax
        ACCF    edx, 0xd5, 0
        mov     ax, bx
        sub     al, cl
        das
        mov     dx, ax
        ACCF    edx, 0xd5, 0
        mov     ax, bx
        and     ax, 0x0f0f
        add     al, ah
        aaa
        mov     dx, ax
        ACCF    edx, 0x11, 0
        mov     al, bl
        aam
        mov     dx, ax
        ACCF    edx, 0xc4, 0
        mov     ax, bx
        and     ax, 0x0909
        aad
        mov     dx, ax
        ACCF    edx, 0xc4, 0
        ret

# ---------------------------------------------------------------- salti condizionati
p_salti:
        RND
        mov     ebx, eax
        RND
        mov     ecx, eax
        xor     edx, edx
        cmp     ebx, ecx
        jo      1f
        add     edx, 1
1:      jno     1f
        add     edx, 2
1:      cmp     ebx, ecx
        jb      1f
        add     edx, 4
1:      cmp     ebx, ecx
        jae     1f
        add     edx, 8
1:      cmp     bx, cx
        je      1f
        add     edx, 16
1:      cmp     bx, cx
        jne     1f
        add     edx, 32
1:      cmp     bx, cx
        jbe     1f
        add     edx, 64
1:      cmp     bx, cx
        ja      1f
        add     edx, 128
1:      cmp     bl, cl
        js      1f
        add     edx, 256
1:      cmp     bl, cl
        jns     1f
        add     edx, 512
1:      cmp     bl, cl
        jp      1f
        add     edx, 1024
1:      cmp     bl, cl
        jnp     1f
        add     edx, 2048
1:      cmp     ebx, ecx
        jl      1f
        add     edx, 4096
1:      cmp     ebx, ecx
        jge     1f
        add     edx, 8192
1:      cmp     bx, cx
        jle     1f
        add     edx, 16384
1:      cmp     bx, cx
        jg      1f
        add     edx, 32768
1:      # dopo ADD, SUB, INC, DEC, AND, scorrimenti: flag presi dall'operazione
        mov     esi, ebx
        add     esi, ecx
        jc      1f
        add     edx, 0x10000
1:      jo      1f
        add     edx, 0x20000
1:      js      1f
        add     edx, 0x40000
1:      mov     si, bx
        sub     si, cx
        jl      1f
        add     edx, 0x80000
1:      jbe     1f
        add     edx, 0x100000
1:      mov     al, bl
        inc     al
        jz      1f
        add     edx, 0x200000
1:      jo      1f
        add     edx, 0x400000
1:      mov     esi, ebx
        and     esi, ecx
        jp      1f
        add     edx, 0x800000
1:      jle     1f
        add     edx, 0x1000000
1:      mov     si, bx
        shl     si, 1
        jc      1f
        add     edx, 0x2000000
1:      mov     esi, ebx
        shr     esi, 3
        jnc     1f
        add     edx, 0x4000000
1:      mov     al, cl
        dec     al
        js      1f
        add     edx, 0x8000000
1:      test    bx, cx
        jnz     1f
        add     edx, 0x10000000
1:      mov     esi, ecx
        neg     esi
        ja      1f
        add     edx, 0x20000000
1:      ACCF    edx, 0x00, 0
        # LOOP e JCXZ
        mov     cx, bx
        and     cx, 7
        xor     dx, dx
        jcxz    3f
2:      add     dx, cx
        loop    2b
3:      ACCF    edx, 0x00, 0
        ret

# ---------------------------------------------------------------- stringhe
p_stringhe:
        RND
        mov     ebx, eax
        push    es
        push    ds
        pop     es
        mov     di, offset buf
        mov     cx, 16
        mov     eax, ebx
        rep stosd
        mov     si, offset buf
        mov     di, offset buf+64
        mov     cx, 24
        rep movsb
        mov     cx, 10
        rep movsw
        mov     si, offset buf+3
        lodsb
        mov     dl, al
        lodsw
        add     dx, ax
        lodsd
        add     edx, eax
        ACCF    edx, 0x00, 0
        mov     di, offset buf+100
        mov     al, bl
        stosb
        mov     ax, bx
        stosw
        mov     eax, ebx
        stosd
        mov     si, offset buf+100
        mov     di, offset buf+120
        movsb
        movsw
        movsd
        mov     edx, dword ptr [buf+121]
        ACCF    edx, 0x00, 0
        mov     si, offset buf
        mov     di, offset buf+64
        mov     cx, 30
        repe cmpsb
        mov     dx, cx
        ACC     edx
        mov     di, offset buf
        mov     al, bh
        mov     cx, 64
        repne scasb
        mov     dx, cx
        ACC     edx
        std
        mov     si, offset buf+40
        mov     di, offset buf+90
        mov     cx, 9
        rep movsb
        lodsw
        cld
        mov     dx, ax
        add     dx, word ptr [buf+85]
        ACCF    edx, 0x00, 0
        pop     es
        ret

# ---------------------------------------------------------------- pila
p_pila:
        RND
        mov     ebx, eax
        RND
        mov     ecx, eax
        push    bx
        push    ecx
        push    0x1234
        push    word ptr [mem]
        pop     dx
        pop     si
        add     dx, si
        pop     esi
        add     edx, esi
        pop     si
        add     dx, si
        ACCF    edx, 0x00, 0
        mov     edx, ebx
        mov     esi, ecx
        mov     edi, ebx
        pusha
        xor     dx, dx
        xor     si, si
        popa
        add     dx, si
        pushad
        mov     edx, 1
        popad
        ACCF    edx, 0x00, 0
        cmp     bx, cx
        pushf
        pop     dx
        and     dx, 0x08d5
        ACCF    edx, 0x00, 0
        mov     dx, bx
        and     dx, 0x08d5
        or      dx, 0x0202
        push    dx
        popf
        ACC     edx
        mov     dx, cx
        enter   8, 0
        mov     word ptr [bp-2], dx
        mov     word ptr [bp-8], bx
        mov     dx, word ptr [bp-8]
        add     dx, word ptr [bp-2]
        leave
        ACCF    edx, 0x00, 0
        mov     dx, bx
        call    sub1
        ACCF    edx, 0x00, 0
        mov     si, offset sub1
        call    si
        ACCF    edx, 0x00, 0
        call    word ptr [psub]
        ACCF    edx, 0x00, 0
        push    cx
        call    sub2
        ACCF    edx, 0x00, 0
        ret
sub1:   add     dx, 0x1111
        ret
sub2:   push    bp
        mov     bp, sp
        add     dx, word ptr [bp+4]
        pop     bp
        ret     2

# ---------------------------------------------------------------- x87
p_x87:
        RND
        mov     ebx, eax
        RND
        mov     ecx, eax
        mov     dword ptr [fi1], ebx
        mov     dword ptr [fi2], ecx
        mov     word ptr [fw1], bx
        or      word ptr [fw1], 1
        fild    dword ptr [fi1]
        fild    dword ptr [fi2]
        fadd    st(0), st(1)
        fst     qword ptr [fd1]
        fmul    dword ptr [fk1]
        fsub    qword ptr [fk2]
        fild    word ptr [fw1]
        fdivp   st(1), st(0)
        fstp    qword ptr [fd2]
        fabs
        fsqrt
        fld     st(0)
        fchs
        fxch    st(1)
        faddp   st(1), st(0)
        fld1
        fldz
        fldpi
        faddp   st(1), st(0)
        fsubrp  st(1), st(0)
        fmul    qword ptr [fd2]
        fstp    dword ptr [fs1]
        fstp    qword ptr [fd3]
        mov     edx, dword ptr [fd1]
        xor     edx, dword ptr [fd1+4]
        ACCF    edx, 0x00, 0
        mov     edx, dword ptr [fd2]
        xor     edx, dword ptr [fd2+4]
        ACCF    edx, 0x00, 0
        mov     edx, dword ptr [fs1]
        xor     edx, dword ptr [fd3]
        xor     edx, dword ptr [fd3+4]
        ACCF    edx, 0x00, 0
        # confronti
        fild    dword ptr [fi1]
        fild    dword ptr [fi2]
        fcom    st(1)
        fnstsw  ax
        and     ax, 0x4500
        mov     dx, ax
        fcomp   dword ptr [fk1]
        fnstsw  ax
        and     ax, 0x4500
        add     dx, ax
        ftst
        fnstsw  ax
        and     ax, 0x4500
        add     dx, ax
        fld     st(0)
        fcompp
        fnstsw  ax
        sahf
        jne     xf1
        add     dx, 3
xf1:    ACCF    edx, 0x00, 0
        # conversioni a intero, con i quattro arrotondamenti
        fild    dword ptr [fi1]
        fmul    qword ptr [fk3]
        fld     st(0)
        fistp   dword ptr [fo1]
        fld     st(0)
        fistp   word ptr [fo2]
        fld     st(0)
        fistp   qword ptr [fo3]
        mov     edx, dword ptr [fo1]
        add     dx, word ptr [fo2]
        xor     edx, dword ptr [fo3]
        xor     edx, dword ptr [fo3+4]
        ACCF    edx, 0x00, 0
        fnstcw  word ptr [fcw]
        mov     ax, word ptr [fcw]
        and     ax, 0xf3ff
        mov     si, bx
        and     si, 0x0c00
        or      ax, si
        mov     word ptr [fcw2], ax
        fldcw   word ptr [fcw2]
        fld     st(0)
        fistp   dword ptr [fo1]
        fld     st(0)
        frndint
        fstp    qword ptr [fd1]
        fldcw   word ptr [fcw]
        fstp    st(0)
        mov     edx, dword ptr [fo1]
        xor     edx, dword ptr [fd1]
        xor     edx, dword ptr [fd1+4]
        ACCF    edx, 0x00, 0
        fild    qword ptr [fo3]
        fild    word ptr [fw1]
        fmulp   st(1), st(0)
        fstp    qword ptr [fd1]
        mov     edx, dword ptr [fd1]
        xor     edx, dword ptr [fd1+4]
        ACCF    edx, 0x00, 0
        ret

        .balign 4
fk1:    .float  3.25
fk2:    .double 12345.6789
fk3:    .double 0.000123456789
psub:   .word   sub1
acapo:  .ascii  "\r\n$"
        .balign 4
tab:    .long   0x11111111, 0x22222222, 0x33333333, 0x44444444
        .fill   320, 4, 0x5a5a5a5a
chk:    .long   0
seme:   .long   0
giri:   .word   0
        .balign 4
tmp:    .long   0
tmp2:   .long   0
mem:    .long   0, 0
fi1:    .long   0
fi2:    .long   0
fw1:    .word   0
fcw:    .word   0
fcw2:   .word   0
        .balign 4
fo1:    .long   0
fo2:    .word   0, 0
fo3:    .quad   0
fd1:    .quad   0
fd2:    .quad   0
fd3:    .quad   0
fs1:    .long   0
buf:    .fill   256, 1, 0
