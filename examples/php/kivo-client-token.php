<?php
// Add to the business server yourself. Keep its existing session middleware.
// Native apps call this server using YOUR existing login authentication.
// This session example never trusts userId/account supplied by the client.
if (session_status() !== PHP_SESSION_ACTIVE) session_start();
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, private');
$user = isset($_SESSION['user']) && is_array($_SESSION['user']) ? $_SESSION['user'] : $_SESSION;
if (empty($user['id']) || empty($user['username'])) {
    http_response_code(401); echo json_encode(array('error' => '请先登录')); exit;
}
$url = rtrim(getenv('KIVO_URL'), '/');
$site = getenv('KIVO_SITE_ID');
$secret = getenv('KIVO_IDENTITY_SECRET');
if (strpos($url, 'https://') !== 0 || !$site || !preg_match('/^[a-f0-9]{64}$/', $secret) || !function_exists('curl_init')) {
    http_response_code(503); echo json_encode(array('error' => '客服后端配置不完整')); exit;
}
$payload = json_encode(array('siteId' => $site, 'user' => array(
    'userId' => (string) $user['id'], 'account' => (string) $user['username'],
    'nickname' => isset($user['nickname']) ? (string) $user['nickname'] : '',
    'attributes' => (object) array() // Map up to five permitted fields from your server's user record.
)), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
$curl = curl_init($url . '/api/client/v1/tokens');
curl_setopt_array($curl, array(CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_TIMEOUT => 10,
    CURLOPT_HTTPHEADER => array('Content-Type: application/json', 'Authorization: Bearer ' . $secret),
    CURLOPT_POSTFIELDS => $payload));
$result = curl_exec($curl); $status = curl_getinfo($curl, CURLINFO_HTTP_CODE); curl_close($curl);
$data = is_string($result) ? json_decode($result, true) : null;
if ($status !== 201 || !is_array($data) || empty($data['token']) || empty($data['expiresAt'])) {
    http_response_code(502); echo json_encode(array('error' => '客服凭证暂时无法获取')); exit;
}
echo json_encode(array('siteId' => $site, 'baseUrl' => $url, 'token' => $data['token'], 'expiresAt' => $data['expiresAt']), JSON_UNESCAPED_SLASHES);
