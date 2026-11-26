<?php
// GET: accesso dell'amministratore. Apache chiede l'account admin (Basic Auth, vedi
// deploy/balthasar/retro486.conf); da qui in poi il browser manda le credenziali con le
// scritture in api/. Torna al portale, che si mette in modalita' admin.
require __DIR__ . '/_comune.php';
metodo('GET');
if (!admin()) errore('Accesso riservato all\'amministratore', 403);
header('Cache-Control: no-store');
header('Location: ../?admin=1', true, 303);
exit;
