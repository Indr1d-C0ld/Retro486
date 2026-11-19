<?php
// PUT ?macchina=<nome interno 86Box>  corpo: la CMOS (file .nvr di 86Box).
require __DIR__ . '/_comune.php';
metodo('PUT');
$m = nome_sicuro($_GET['macchina'] ?? '', '/^[a-z0-9_]{1,40}$/');
$dir = cartella('nvr');
$tmp = ricevi_corpo($dir, 64 << 10);
rename($tmp, "$dir/$m.nvr");
rispondi(['ok' => true, 'macchina' => $m]);
