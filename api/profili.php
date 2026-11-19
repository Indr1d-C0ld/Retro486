<?php
// PUT: l'elenco completo dei profili hardware personali (JSON).
require __DIR__ . '/_comune.php';
metodo('PUT');
$corpo = file_get_contents('php://input', false, null, 0, 1 << 20);
$profili = json_decode((string) $corpo, true);
if (!is_array($profili) || !array_is_list($profili)) errore('Atteso un array JSON di profili');
foreach ($profili as $p) {
    if (!is_array($p) || !isset($p['id'], $p['nome'], $p['hw']) || !is_array($p['hw'])) errore('Profilo non valido');
    nome_sicuro((string) $p['id'], '/^[A-Za-z0-9_-]{1,40}$/');
}
cartella('.');
json_atomico(DATI . '/profili.json', $profili);
rispondi(['ok' => true, 'profili' => count($profili)]);
