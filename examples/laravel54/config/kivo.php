<?php
return array(
    'enabled' => (bool) env('KIVO_ENABLED', false),
    'url' => rtrim(env('KIVO_URL', ''), '/'),
    'site_id' => env('KIVO_SITE_ID', ''),
    'identity_secret' => env('KIVO_IDENTITY_SECRET', ''),
);
