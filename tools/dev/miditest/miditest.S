# Retro486 - MIDITEST.COM: suona un accordo sull'interfaccia MPU-401 a 330h (modalità UART) e resta
# in attesa di un tasto. Serve a tools/dev/prova-midi.mjs per misurare se il sintetizzatore MIDI
# del profilo produce davvero suono.
#   as --32 miditest.S -o miditest.o && ld -m elf_i386 -Ttext 0x100 --oformat binary -o MIDITEST.COM miditest.o
        .code16
        .intel_syntax noprefix
        .text
        .globl  _start
_start:
        mov     al, 0xff                # reset dell'MPU-401
        call    comando
        mov     al, 0x3f                # modalità UART
        call    comando
        mov     si, offset note
1:      lodsb
        cmp     al, 0xfe
        je      2f
        call    dato
        jmp     1b
2:      mov     dx, offset msg
        mov     ah, 9
        int     0x21
        xor     ah, ah                  # un tasto: spegne le note ed esce
        int     0x16
        mov     si, offset spegni
3:      lodsb
        cmp     al, 0xfe
        je      4f
        call    dato
        jmp     3b
4:      mov     ax, 0x4c00
        int     0x21

attesa: mov     dx, 0x331               # pronto a ricevere: bit 6 dello stato a zero
        mov     cx, 0xffff
1:      in      al, dx
        test    al, 0x40
        jz      2f
        loop    1b
2:      ret
comando:
        push    ax
        call    attesa
        pop     ax
        mov     dx, 0x331
        out     dx, al
        mov     cx, 0x2000              # l'ACK (FEh) arriva sulla porta dati: lo si legge e si butta
1:      mov     dx, 0x331
        in      al, dx
        test    al, 0x80
        jz      2f
        loop    1b
        ret
2:      mov     dx, 0x330
        in      al, dx
        ret
dato:   push    ax
        call    attesa
        pop     ax
        mov     dx, 0x330
        out     dx, al
        ret

note:   .byte   0xc0, 0x00              # canale 1: pianoforte
        .byte   0xb0, 0x07, 0x7f        # volume al massimo
        .byte   0x90, 0x3c, 0x7f, 0x90, 0x40, 0x7f, 0x90, 0x43, 0x7f, 0x90, 0x48, 0x7f
        .byte   0xc1, 0x30              # canale 2: archi, che tengono la nota
        .byte   0xb1, 0x07, 0x7f
        .byte   0x91, 0x3c, 0x7f, 0x91, 0x43, 0x7f
        .byte   0xfe
spegni: .byte   0xb0, 0x7b, 0x00, 0xb1, 0x7b, 0x00, 0xfe
msg:    .ascii  "MIDITEST - accordo sulla MPU-401 a 330h (un tasto per uscire)\r\n$"
