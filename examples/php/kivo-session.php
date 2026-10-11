<?php
// Copy this file outside the public directory and include it from your PHP page.
// Replace these two values with the same URL and site ID as your existing widget.
$kivoServiceUrl = 'https://chat.example.com';
$kivoSiteId = 'REPLACE_WITH_YOUR_SITE_ID';

// Read an already initialized Laravel or native PHP session. No API or key needed.
$kivoSessionName = '';
if (class_exists('Illuminate\Support\Facades\Session')) {
    try {
        $kivoUser = \Illuminate\Support\Facades\Session::get('user');
        $kivoSessionName = is_array($kivoUser) && isset($kivoUser['username'])
            ? $kivoUser['username'] : \Illuminate\Support\Facades\Session::get('username', '');
    } catch (\Exception $error) {
        // An unavailable session uses the default visitor name.
    }
} elseif (isset($_SESSION)) {
    $kivoSessionName = isset($_SESSION['user']['username'])
        ? $_SESSION['user']['username'] : (isset($_SESSION['username']) ? $_SESSION['username'] : '');
}
$kivoSessionName = is_string($kivoSessionName) || is_numeric($kivoSessionName) ? trim((string) $kivoSessionName) : '';
$kivoEscape = function ($value) { return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); };
?>
<script src="<?php echo $kivoEscape(rtrim($kivoServiceUrl, '/') . '/widget.js'); ?>"
        data-site="<?php echo $kivoEscape($kivoSiteId); ?>"
        data-visitor-name="<?php echo $kivoEscape($kivoSessionName); ?>"
        async></script>
