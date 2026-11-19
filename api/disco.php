<?php
// PUT ?nome=c  corpo: l'immagine dell'hard disk compressa con gzip.
// Tiene le ultime tre versioni come <nome>.img.gz.1 .. .3
require __DIR__ . '/_comune.php';
metodo('PUT');
$nome = nome_sicuro($_GET['nome'] ?? '', '/^[a-z0-9_-]{1,32}$/');
$dir = cartella('dischi');
$tmp = ricevi_corpo($dir, 2048 << 20);

$h = fopen($tmp, 'rb'); $magic = fread($h, 2); fclose($h);
if ($magic !== "\x1f\x8b") { unlink($tmp); errore('Il corpo non è un file gzip'); }

$dest = "$dir/$nome.img.gz";
if (is_file($dest)) {
    for ($i = 3; $i >= 1; $i--) {
        $da = $i === 1 ? $dest : "$dest." . ($i - 1);
        if (is_file($da)) rename($da, "$dest.$i");
    }
}
rename($tmp, $dest);
clearstatcache();
$info = leggi_json("$dir/$nome.json", []);
$orig = (int) ($_SERVER['HTTP_X_DIMENSIONE_ORIGINALE'] ?? 0);
if ($orig > 0) $info['byte'] = $orig;
$info['salvato'] = date('c');
json_atomico("$dir/$nome.json", $info);
rispondi(['ok' => true, 'file' => basename($dest), 'byte_gz' => filesize($dest), 'mtime' => filemtime($dest)]);
