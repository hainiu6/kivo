@if(config('kivo.enabled') && config('kivo.url') && config('kivo.site_id'))
    <script src="{{ config('kivo.url') }}/widget.js" data-site="{{ config('kivo.site_id') }}" data-visitor-name="{{ Session::get('user.username', Session::get('username', '')) }}" async></script>
@else
    {{-- Keep the existing support widget until Kivo is configured. --}}
    <script src="https://assets.salesmartly.com/js/project_32495_33841_1701313564.js"></script>
@endif
