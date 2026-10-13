(function () {
  'use strict';
  function create({ api, form, input, saveButton, status, count, reloadButton }) {
    const entries = new Map();
    let activeId = null, generation = 0;
    const clean = value => value.replace(/\r\n?/g, '\n').trim();
    const dirty = state => clean(state.draft) !== state.note;
    function render() {
      const state = entries.get(activeId);
      const value = state?.draft || '';
      if (input.value !== value) input.value = value;
      input.disabled = !state?.loaded || state.loading;
      count.textContent = `${value.length}/2000`;
      saveButton.disabled = !state?.loaded || state.loading || state.saving || state.conflict || !dirty(state);
      saveButton.textContent = state?.saving ? '正在保存…' : '保存备注';
      reloadButton.hidden = !state?.conflict && !state?.error;
      reloadButton.disabled = !!state?.loading || !!state?.saving;
      status.textContent = !state ? '' : state.loading ? '正在载入备注…' : state.error || (state.conflict ? '其他客服已修改备注，请载入最新后再编辑' : dirty(state) ? '有修改尚未保存' : state.updatedAt ? '已保存，仅客服可见' : '仅客服可见');
    }
    function apply(state, data, own = false) {
      if (!data || typeof data.note !== 'string' || !Number.isSafeInteger(data.updatedAt) || data.updatedAt < state.updatedAt) return;
      const changed = data.updatedAt > state.updatedAt;
      const local = dirty(state);
      state.note = data.note; state.updatedAt = data.updatedAt; state.loaded = true;
      const savedHere = state.saving && data.note === state.pending;
      if (!local || own || (savedHere && clean(state.draft) === state.pending)) {
        state.draft = data.note; state.conflict = false;
      } else if (changed && !savedHere) state.conflict = true;
    }
    async function load(id, discard = false) {
      const state = entries.get(id), epoch = generation;
      if (!state || state.loading) return;
      state.loading = true; state.error = ''; if (activeId === id) render();
      try {
        const data = await api(`/api/admin/conversations/${id}/note`);
        if (generation !== epoch || entries.get(id) !== state) return;
        apply(state, data);
        if (discard) { state.draft = state.note; state.conflict = false; }
      } catch (error) {
        if (generation === epoch && entries.get(id) === state) state.error = error.message;
      } finally {
        if (generation === epoch && entries.get(id) === state) { state.loading = false; if (activeId === id) render(); }
      }
    }
    input.addEventListener('input', () => {
      const state = entries.get(activeId); if (!state) return;
      state.draft = input.value; state.error = ''; render();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const id = activeId, state = entries.get(id), epoch = generation;
      if (!state?.loaded || state.loading || state.saving || state.conflict || !dirty(state)) return;
      state.saving = true; state.pending = clean(state.draft); state.error = ''; render();
      try {
        const data = await api(`/api/admin/conversations/${id}/note`, { method: 'PUT', body: JSON.stringify({ note: state.pending, updatedAt: state.updatedAt }) });
        if (generation !== epoch || entries.get(id) !== state) return;
        // Keep any edits typed while the save was in flight.
        apply(state, data, clean(state.draft) === state.pending);
      } catch (error) {
        if (generation !== epoch || entries.get(id) !== state) return;
        if (error.status === 409) { state.conflict = true; await load(id); }
        else state.error = error.message;
      } finally {
        if (generation === epoch && entries.get(id) === state) {
          state.saving = false; state.pending = null; if (activeId === id) render();
        }
      }
    });
    reloadButton.addEventListener('click', () => { if (activeId) load(activeId, true); });
    render();
    return {
      select(id) {
        if (activeId === id) return;
        activeId = id;
        if (!entries.has(id)) entries.set(id, { note: '', draft: '', updatedAt: 0, loaded: false, loading: false, saving: false, conflict: false, error: '' });
        render(); load(id);
      },
      refresh() { if (activeId) load(activeId); },
      receive(data) {
        const state = entries.get(data?.conversationId); if (!state) return;
        apply(state, data); if (activeId === data.conversationId) render();
      },
      remove(id) { entries.delete(id); if (activeId === id) { activeId = null; render(); } },
      reset() { generation++; entries.clear(); activeId = null; render(); }
    };
  }
  window.KivoVisitorNotes = { create };
}());
