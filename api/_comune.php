<?php
// Retro486 - funzioni comuni del backend.
// I dati stanno in ../dati (fuori dalla cartella pubblicata con --delete).
// L'accesso al sito è protetto da Basic Auth in Apache; qui si controllano
// metodo, nomi dei file e un'intestazione che un altro sito non può inviare
// senza una richiesta preflight CORS (che il server non autorizza).

declare(strict_types=1);

const DATI = __DIR__ . '/../dati';

function rispondi($dati, int $codice = 200): never {
    http_response_code($codice);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($dati, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    exit;
}

function errore(string $msg, int $codice = 400): never {
    rispondi(['errore' => $msg], $codice);
}

function metodo(string ...$ammessi): string {
    $m = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($m, $ammessi, true)) {
        header('Allow: ' . implode(', ', $ammessi));
        errore("Metodo $m non ammesso", 405);
    }
    if ($m !== 'GET' && ($_SERVER['HTTP_X_RETRO486'] ?? '') !== '1') {
        errore('Intestazione X-Retro486 mancante', 403);
    }
    return $m;
}

function nome_sicuro(string $n, string $re = '/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/'): string {
    if (!preg_match($re, $n) || str_contains($n, '..')) errore("Nome non valido: $n");
    return $n;
}

function cartella(string $sub): string {
    $d = DATI . '/' . $sub;
    if (!is_dir($d) && !mkdir($d, 02775, true)) errore("Impossibile creare $sub", 500);
    return $d;
}

// Copia il corpo della richiesta in un file temporaneo, con un limite di byte.
function ricevi_corpo(string $dir, int $max): string {
    $tmp = tempnam($dir, '.ricevo-');
    $in = fopen('php://input', 'rb');
    $out = fopen($tmp, 'wb');
    $n = 0;
    while (!feof($in)) {
        $buf = fread($in, 1 << 20);
        if ($buf === false) break;
        $n += strlen($buf);
        if ($n > $max) { fclose($out); unlink($tmp); errore("File troppo grande (limite " . intdiv($max, 1 << 20) . " MB)", 413); }
        fwrite($out, $buf);
    }
    fclose($in); fclose($out);
    if ($n === 0) { unlink($tmp); errore('Corpo della richiesta vuoto'); }
    chmod($tmp, 0664);
    return $tmp;
}

function json_atomico(string $file, $dati): void {
    $tmp = $file . '.tmp';
    file_put_contents($tmp, json_encode($dati, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n");
    chmod($tmp, 0664);
    rename($tmp, $file);
}

function leggi_json(string $file, $predef) {
    if (!is_file($file)) return $predef;
    $d = json_decode((string) file_get_contents($file), true);
    return $d ?? $predef;
}
