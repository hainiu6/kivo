<?php
// Generic PHP example. For Laravel use examples/laravel54 instead.
require __DIR__ . '/KivoIdentity.php';
if (session_status() !== PHP_SESSION_ACTIVE) {
    session_start();
}
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private');
header('X-Content-Type-Options: nosniff');

// Map these fields to your website's existing server-side login session.
$userId = isset($_SESSION['user_id']) ? $_SESSION['user_id'] : null;
$account = isset($_SESSION['username']) ? $_SESSION['username'] : '';
$nickname = isset($_SESSION['nickname']) ? $_SESSION['nickname'] : '';
if ($userId === null || $account === '') {
    echo json_encode(array('identityToken' => null));
    exit;
}
try {
    $token = \App\Components\KivoIdentity::sign(getenv('KIVO_SITE_ID'), getenv('KIVO_IDENTITY_SECRET'), $userId, $account, $nickname);
    echo json_encode(array('identityToken' => $token));
} catch (\Exception $error) {
    http_response_code(503);
    echo json_encode(array('error' => 'Kivo identity configuration is unavailable.'));
}
