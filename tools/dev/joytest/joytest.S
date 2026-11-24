# Retro486 - JOYTEST.COM: mostra lo stato della porta giochi (201h) come lo vede un gioco DOS.
# Stampa in continuazione i pulsanti premuti (bit 0-3) e il tempo di scarica degli assi X e Y
# del joystick 1; un tasto qualsiasi esce. Serve a tools/dev/prova-joystick.mjs.
#   as --32 joytest.S -o joytest.o && ld -m elf_i386 -Ttext 0x100 --oformat binary -o JOYTEST.COM joytest.o
        .code16
        .intel_syntax noprefix
        .text
        .globl  _start
_start:
        mov     dx, offset titolo
        mov     ah, 9
        int     0x21
ciclo:
        mov     bl, 1                   # asse X: bit 0
        call    misura
        mov     word ptr [vx], cx
        mov     bl, 2                   # asse Y: bit 1
        call    misura
        mov     word ptr [vy], cx
        mov     dx, 0x201
        in      al, dx
        shr     al, 4
        not     al
        and     al, 0x0f
        mov     byte ptr [vb], al

        mov     al, 13
        call    car
        mov     si, offset tb
        call    testo
        mov     al, byte ptr [vb]
        call    hex1
        mov     si, offset tx
        call    testo
        mov     ax, word ptr [vx]
        call    hex4
        mov     si, offset ty
        call    testo
        mov     ax, word ptr [vy]
        call    hex4

        mov     ah, 1                   # tasto premuto?
        int     0x16
        jz      ciclo
        xor     ah, ah
        int     0x16
        mov     ax, 0x4c00
        int     0x21

# conta in CX i giri finché il bit BL di 201h resta alto dopo lo scatto dei monostabili
misura:
        mov     dx, 0x201
        xor     cx, cx
        cli
        out     dx, al
1:      in      al, dx
        test    al, bl
        jz      2f
        inc     cx
        cmp     cx, 0xfff0
        jb      1b
2:      sti
        push    cx                      # lascia scaricare anche l'altro asse
        mov     cx, 0x4000
3:      loop    3b
        pop     cx
        ret

testo:  lodsb
        or      al, al
        jz      1f
        call    car
        jmp     testo
1:      ret
hex4:   push    ax
        mov     al, ah
        call    hex2
        pop     ax
hex2:   push    ax
        shr     al, 4
        call    hex1
        pop     ax
hex1:   and     al, 0x0f
        add     al, '0'
        cmp     al, '9'
        jbe     car
        add     al, 7
car:    mov     ah, 0x0e
        xor     bx, bx
        int     0x10
        ret

titolo: .ascii  "JOYTEST - porta giochi 201h (un tasto per uscire)\r\n$"
tb:     .asciz  "PULSANTI="
tx:     .asciz  "  X="
ty:     .asciz  "  Y="
vx:     .word   0
vy:     .word   0
vb:     .byte   0
