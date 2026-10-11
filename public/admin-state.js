(() => {
  const key = 'kivo.admin.workspace';
  const defaults = () => ({ view: 'inbox', status: 'open', site: '', query: '', conversation: '', draft: '', statsDays:7, statsSite:'' });
  function clean(state) {
    const result = defaults();
    if (!state || typeof state !== 'object') return result;
    if (['inbox','sites','replies','stats','settings'].includes(state.view)) result.view = state.view;
    if ([1,7,30,90].includes(state.statsDays)) result.statsDays=state.statsDays;
    if(typeof state.statsSite==='string'&&/^[\da-f-]{36}$/i.test(state.statsSite))result.statsSite=state.statsSite;
    if (['open','closed',''].includes(state.status)) result.status = state.status;
    for (const key of ['site','conversation']) if (typeof state[key] === 'string' && /^[\da-f-]{36}$/i.test(state[key])) result[key] = state[key];
    if (typeof state.query === 'string') result.query = state.query.slice(0,100);
    if (typeof state.draft === 'string' && result.conversation) result.draft = state.draft.slice(0,4000);
    return result;
  }
  window.KivoWorkspaceState = {
    load(username) {
      try { const state = JSON.parse(sessionStorage.getItem(key)); return state?.username === username ? clean(state) : defaults(); } catch { return defaults(); }
    },
    save(username, state) { if (username) try { sessionStorage.setItem(key, JSON.stringify({ ...clean(state), username })); } catch {} },
    clear() { try { sessionStorage.removeItem(key); } catch {} }
  };
})();
