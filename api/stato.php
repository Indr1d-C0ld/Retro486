<?php
// GET: tutto ciò che il portale deve sapere all'avvio.
require __DIR__ . '/_comune.php';
metodo('GET');

$dischi = [];
foreach (glob(DATI . '/dischi/*.img.gz') ?: [] as $f) {
    $nome = basename($f, '.img.gz');
    $info = leggi_json(DATI . "/dischi/$nome.json", []);
    $dischi[] = [
        'nome' => $nome, 'file' => basename($f), 'byte_gz' => filesize($f), 'mtime' => filemtime($f),
        'byte' => $info['byte'] ?? null, 'cilindri' => $info['cilindri'] ?? null, 'giochi' => $info['giochi'] ?? [],
    ];
}

$media = [];
$etichette = leggi_json(DATI . '/media/etichette.json', []);
foreach (glob(DATI . '/media/*') ?: [] as $f) {
    if (!is_file($f)) continue;
    $b = basename($f);
    if ($b === 'etichette.json') continue;
    $ext = strtolower(pathinfo($b, PATHINFO_EXTENSION));
    $tipo = in_array($ext, ['iso', 'cue', 'bin', 'mds', 'chd'], true) ? 'cdrom'
        : (in_array($ext, ['img', 'ima', 'vfd', 'dsk', 'flp', '86f', 'td0', 'imd', 'fdi'], true) ? 'floppy' : 'altro');
    $media[] = ['file' => $b, 'nome' => $etichette[$b] ?? $b, 'tipo' => $tipo, 'byte' => filesize($f)];
}
usort($media, fn($a, $b) => strcmp($a['nome'], $b['nome']));

$nvr = array_map(fn($f) => basename($f, '.nvr'), glob(DATI . '/nvr/*.nvr') ?: []);
$versione = leggi_json(__DIR__ . '/../version.json', []);

rispondi([
    'versione' => isset($versione['version']) ? "v{$versione['version']} ({$versione['commit']})" : '',
    'dischi' => $dischi,
    'libreria' => array_merge(leggi_json(DATI . '/libreria.json', ['voci' => []])['voci'] ?? [], leggi_json(DATI . '/libreria-utente.json', [])),
    'profili' => leggi_json(DATI . '/profili.json', []),
    'media' => $media,
    'nvr' => $nvr,
]);
