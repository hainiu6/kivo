<?php
namespace App\Components;

class KivoIdentity
{
    public static function sign($siteId, $secret, $userId, $account, $nickname = '')
    {
        if (!preg_match('/^[a-f0-9]{64}$/', $secret)) {
            throw new \InvalidArgumentException('Kivo identity secret must be the original 64-character key.');
        }
        $issued = time();
        $payload = json_encode(array(
            'siteId' => (string) $siteId,
            'userId' => (string) $userId,
            'account' => (string) $account,
            'nickname' => (string) $nickname,
            'iat' => $issued,
            'exp' => $issued + 900,
        ), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($payload === false) {
            throw new \InvalidArgumentException('Kivo user fields must contain valid UTF-8.');
        }
        $encoded = self::base64url($payload);
        return $encoded . '.' . self::base64url(hash_hmac('sha256', $encoded, $secret, true));
    }

    private static function base64url($value)
    {
        return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
    }
}
