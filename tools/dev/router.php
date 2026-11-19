<?php
// Retro486 - router per il server di sviluppo di PHP (php -S ... -t dist tools/dev/router.php).
// Aggiunge le intestazioni di isolamento (COOP/COEP) che servono a SharedArrayBuffer,
// come fa la configurazione di Apache su Balthasar.
header('Cross-Origin-Opener-Policy: same-origin');
header('Cross-Origin-Embedder-Policy: require-corp');
header('Cross-Origin-Resource-Policy: same-origin');
header('Cache-Control: no-cache');

$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$file = realpath($_SERVER['DOCUMENT_ROOT'] . $uri);
if (str_ends_with($uri, '.php')) return false;          // lo esegue PHP
if ($file && is_dir($file)) $file = realpath($file . '/index.html');
if (!$file || !is_file($file)) { http_response_code(404); echo "404 $uri"; return true; }

$tipi = ['html' => 'text/html; charset=utf-8', 'js' => 'text/javascript', 'mjs' => 'text/javascript', 'css' => 'text/css',
  'wasm' => 'application/wasm', 'json' => 'application/json', 'svg' => 'image/svg+xml', 'png' => 'image/png', 'ico' => 'image/x-icon',
  'woff' => 'font/woff', 'gz' => 'application/octet-stream', 'txt' => 'text/plain; charset=utf-8'];
$ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
header('Content-Type: ' . ($tipi[$ext] ?? 'application/octet-stream'));
header('Content-Length: ' . filesize($file));
readfile($file);
return true;
