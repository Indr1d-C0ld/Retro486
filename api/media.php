<?php
// PUT ?nome=<file>[&etichetta=...]  carica un'immagine di floppy o CD.
// DELETE ?nome=<file>               la elimina.
require __DIR__ . '/_comune.php';
$m = metodo('PUT', 'DELETE');
$nome = nome_sicuro($_GET['nome'] ?? '');
if ($nome === 'etichette.json') errore('Nome riservato');
$dir = cartella('media');
$etichette = leggi_json("$dir/etichette.json", []);
if ($m === 'DELETE') {
    if (is_file("$dir/$nome")) unlink("$dir/$nome");
    unset($etichette[$nome]);
    json_atomico("$dir/etichette.json", $etichette);
    rispondi(['ok' => true]);
}
$tmp = ricevi_corpo($dir, 900 << 20);
rename($tmp, "$dir/$nome");
if (!empty($_GET['etichetta'])) $etichette[$nome] = mb_substr((string) $_GET['etichetta'], 0, 80);
json_atomico("$dir/etichette.json", $etichette);
rispondi(['ok' => true, 'file' => $nome]);
