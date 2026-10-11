<?php
namespace App\Http\Controllers;

use App\Components\KivoIdentity;
use App\Http\Models\User;
use Illuminate\Http\Request;

// Independent of the application's base controller, which loads unrelated data.
class KivoController extends \Illuminate\Routing\Controller
{
    public function identity(Request $request)
    {
        $headers = array('Cache-Control' => 'no-store, private', 'X-Content-Type-Options' => 'nosniff');
        if (!config('kivo.enabled')) {
            return response()->json(array('identityToken' => null), 200, $headers);
        }
        $sessionUser = $request->session()->get('user');
        $user = is_array($sessionUser) && isset($sessionUser['id']) ? User::query()->find($sessionUser['id']) : null;
        if (!$user || (!$user->is_admin && $user->status < 0)) {
            return response()->json(array('identityToken' => null), 200, $headers);
        }
        try {
            $token = KivoIdentity::sign(config('kivo.site_id'), config('kivo.identity_secret'), $user->id, $user->username);
            return response()->json(array('identityToken' => $token), 200, $headers);
        } catch (\Exception $error) {
            return response()->json(array('error' => '客服身份配置尚未完成，请联系管理员'), 503, $headers);
        }
    }
}
