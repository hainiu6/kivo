@if(config('kivo.enabled') && config('kivo.url') && config('kivo.site_id'))
    <script src="{{ config('kivo.url') }}/widget.js" data-site="{{ config('kivo.site_id') }}" data-identity-url="{{ url('kivo/identity') }}" async></script>
@else
    <script src="https://assets.salesmartly.com/js/project_32495_33841_1701313564.js"></script>
@endif
