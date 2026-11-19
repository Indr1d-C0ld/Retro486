# Retro486 - MBR minimo: si sposta a 0000:0600, cerca la partizione attiva,
# ne carica il settore di avvio a 0000:7C00 (via INT 13h, CHS della tabella)
# e gli passa il controllo con DL = unita' di avvio e DS:SI = voce di partizione.
        .code16
        .text
        .globl _start
_start:
        cli
        xorw    %ax, %ax
        movw    %ax, %ss
        movw    $0x7c00, %sp
        movw    %ax, %es
        movw    %ax, %ds
        sti
        cld
        movw    $0x7c00, %si
        movw    $0x0600, %di
        movw    $0x0100, %cx
        rep movsw
        ljmp    $0, $(0x0600 + relocated - _start)
relocated:
        movw    $0x07be, %si
        movw    $4, %cx
find:
        cmpb    $0x80, (%si)
        je      found
        addw    $16, %si
        loop    find
        movw    $(0x0600 + msg_nopart - _start), %si
        jmp     fail
found:
        movw    $5, %di                 # tentativi
retry:
        movb    1(%si), %dh
        movw    2(%si), %cx
        movw    $0x7c00, %bx
        movw    $0x0201, %ax
        pushw   %si
        pushw   %di
        int     $0x13
        popw    %di
        popw    %si
        jnc     loaded
        xorw    %ax, %ax                # reset del disco e nuovo tentativo
        int     $0x13
        decw    %di
        jnz     retry
        movw    $(0x0600 + msg_err - _start), %si
        jmp     fail
loaded:
        cmpw    $0xaa55, (0x7dfe)
        jne     nosys
        ljmp    $0, $0x7c00
nosys:
        movw    $(0x0600 + msg_nosys - _start), %si
fail:
        lodsb
        orb     %al, %al
        jz      halt
        movb    $0x0e, %ah
        movw    $0x0007, %bx
        int     $0x10
        jmp     fail
halt:
        hlt
        jmp     halt
msg_nopart: .asciz "Tabella delle partizioni non valida"
msg_err:    .asciz "Errore nel caricamento del sistema operativo"
msg_nosys:  .asciz "Sistema operativo mancante"
