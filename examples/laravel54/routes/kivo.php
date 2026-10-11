<?php
// Copy this route into your existing routes/web.php, outside the login-only group.
// Do not replace routes/web.php with this file.
Route::get('kivo/identity', 'KivoController@identity')->middleware('throttle:60,1');
