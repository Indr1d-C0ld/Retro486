<?php
// Voci della libreria aggiunte dal portale (dati/libreria-utente.json): quelle di serie stanno in
// dati/libreria.json, che deploy/pubblica-dati.sh riscrive.
// PUT                      l'elenco completo delle voci personali (JSON: array).
// PUT ?copertina=<id>      l'immagine di copertina di una voce (png, jpeg, webp, gif; max 2 MB).
require __DIR__ . '/_comune.php';
metodo('PUT');
cartella('.');

if (isset($_GET['copertina'])) {
    $id = nome_sicuro((string) $_GET['copertina'], '/^[A-Za-z0-9_-]{1,40}$/');
    $dir = cartella('libreria');
    $tmp = ricevi_corpo($dir, 2 << 20);
    $info = @getimagesize($tmp);
    $ext = [IMAGETYPE_PNG => 'png', IMAGETYPE_JPEG => 'jpg', IMAGETYPE_WEBP => 'webp', IMAGETYPE_GIF => 'gif'][$info[2] ?? 0] ?? null;
    if (!$ext) { unlink($tmp); errore('Immagine non riconosciuta (png, jpeg, webp, gif)'); }
    foreach (glob("$dir/$id.*") ?: [] as $vecchia) unlink($vecchia);
    rename($tmp, "$dir/$id.$ext");
    rispondi(['ok' => true, 'file' => "$id.$ext"]);
}

$voci = json_decode((string) file_get_contents('php://input', false, null, 0, 1 << 20), true);
if (!is_array($voci) || !array_is_list($voci)) errore('Atteso un array JSON di voci');
$pulite = [];
foreach ($voci as $v) {
    if (!is_array($v) || !isset($v['id'], $v['titolo'], $v['cartella'], $v['avvio'])) errore('Voce non valida');
    nome_sicuro((string) $v['id'], '/^[A-Za-z0-9_-]{1,40}$/');
    if (!preg_match('/^C:(\\\\[A-Z0-9_!#$%&\'()@^`{}~-]{1,8}(\.[A-Z0-9_!#$%&\'()@^`{}~-]{1,3})?){1,6}$/', (string) $v['cartella'])) errore('Cartella non valida');
    if (!preg_match('/^[A-Z0-9_!#$%&\'()@^`{}~-]{1,8}(\.(EXE|COM|BAT))( [ -~]{0,60})?$/', (string) $v['avvio'])) errore('Comando di avvio non valido');
    $p = ['id' => (string) $v['id'], 'cartella' => (string) $v['cartella'], 'avvio' => (string) $v['avvio'], 'utente' => true];
    foreach (['titolo' => 80, 'sottotitolo' => 160, 'editore' => 60, 'genere' => 40, 'note' => 600, 'profilo' => 40, 'copertina' => 60] as $k => $max) {
        if (isset($v[$k]) && $v[$k] !== '') $p[$k] = taglia((string) $v[$k], $max);
    }
    if (isset($p['copertina'])) nome_sicuro($p['copertina']);
    if (isset($v['anno']) && (int) $v['anno'] >= 1975 && (int) $v['anno'] <= 2100) $p['anno'] = (int) $v['anno'];
    $pulite[] = $p;
}
json_atomico(DATI . '/libreria-utente.json', $pulite);
// copertine rimaste senza voce
$usate = array_filter(array_column($pulite, 'copertina'));
foreach (glob(DATI . '/libreria/u*.*') ?: [] as $f) if (!in_array(basename($f), $usate, true)) unlink($f);
rispondi(['ok' => true, 'voci' => count($pulite)]);
