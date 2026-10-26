(() => {
  const $ = selector => document.querySelector(selector);
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const OFFSET = 8 * 3600000;
  const localTime = value => value === undefined ? '' : new Date(value + OFFSET).toISOString().slice(0, 16);
  const timestamp = value => value ? Date.parse(value + ':00+08:00') : NaN;
  const date = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  window.KivoCustomNodes = {
    create({ api, onChange, onMessage }) {
      let active = false, life = 0, revision = 0, editRevision = 0, page = 1, query = '', saving = false, editing = null, conflict = false;
      const form = $('#custom-node-form'), dialog = $('#custom-node-dialog');
      const fields = ['account', 'nodeNumber', 'startsAt', 'endsAt', 'note', 'node'];
      function lock(value) { for (const name of fields) form.elements[name].disabled = value; $('#custom-node-save').disabled = value || conflict; }
      function render(data) {
        const body = $('#custom-node-rows'); body.replaceChildren();
        for (const entry of data.items) {
          const row = el('tr');
          for (const value of [entry.account, entry.nodeNumber, date(entry.startsAt), date(entry.endsAt), entry.note || '—']) row.append(el('td', '', value));
          const nodeCell = el('td'), preview = el('div', 'custom-node-preview', entry.nodePreview); preview.title = '点击编辑查看完整节点内容';
          nodeCell.append(preview); const action = el('td'), edit = el('button', 'button small secondary', '编辑'); edit.type = 'button'; edit.onclick = () => editRecord(entry.id); action.append(edit); row.append(nodeCell, action); body.append(row);
        }
        page = data.page; $('#custom-node-empty').hidden = data.total > 0;
        $('#custom-node-count').textContent = `共 ${data.total.toLocaleString('zh-CN')} 条 · 第 ${page} / ${data.pages} 页`;
        $('#custom-node-prev').disabled = page <= 1; $('#custom-node-next').disabled = page >= data.pages;
      }
      async function load() {
        if (!active) return;
        const current = ++revision; $('#custom-node-refresh').disabled = true; $('#custom-node-loading').hidden = false; $('#custom-node-error').textContent = '';
        try {
          const data = await api('/api/admin/custom-nodes?' + new URLSearchParams({ q: query, page }));
          if (current === revision && active) render(data);
        } catch (error) { if (current === revision && active) $('#custom-node-error').textContent = '加载失败：' + error.message + '，点击刷新可重试。'; }
        finally { if (current === revision) { $('#custom-node-loading').hidden = true; $('#custom-node-refresh').disabled = false; } }
      }
      function showEditor(record) {
        form.reset(); editing = record || null; conflict = false;
        for (const name of fields) form.elements[name].value = name === 'startsAt' ? localTime(record?.startsAt ?? Date.now()) : name === 'endsAt' ? localTime(record?.endsAt) : record?.[name] || '';
        $('#custom-node-title').textContent = record ? '编辑定制节点' : '添加定制节点';
        $('#custom-node-form-error').textContent = ''; $('#custom-node-reload').hidden = true; lock(false); if (!dialog.open) dialog.showModal(); form.elements.account.focus();
      }
      async function editRecord(id) {
        if (saving) { onMessage('正在保存，请稍候'); return; }
        const epoch = life, sequence = ++editRevision;
        try { const record = await api('/api/admin/custom-nodes/' + id); if (epoch === life && sequence === editRevision && active) showEditor(record); }
        catch (error) { if (epoch === life && sequence === editRevision && active) onMessage(error.message); }
      }
      function close() { editRevision++; dialog.close(); }
      $('#custom-node-add').onclick = () => { if (saving) { onMessage('正在保存，请稍候'); return; } editRevision++; showEditor(); };
      $('#custom-node-close').onclick = $('#custom-node-cancel').onclick = close;
      dialog.addEventListener('cancel', () => { editRevision++; });
      $('#custom-node-reload').onclick = () => { if (editing) editRecord(editing.id); };
      form.onsubmit = async event => {
        event.preventDefault(); if (!active || saving || conflict) return;
        const epoch = life, sequence = editRevision, record = editing;
        const data = Object.fromEntries(fields.map(name => [name, form.elements[name].value]));
        data.startsAt = timestamp(data.startsAt); data.endsAt = timestamp(data.endsAt);
        if (!Number.isFinite(data.startsAt) || !Number.isFinite(data.endsAt) || data.endsAt <= data.startsAt) { $('#custom-node-form-error').textContent = '结束时间须晚于开始时间'; return; }
        if (record) data.updatedAt = record.updatedAt;
        saving = true; lock(true); $('#custom-node-form-error').textContent = '';
        try {
          await api('/api/admin/custom-nodes' + (record ? '/' + record.id : ''), { method: record ? 'PUT' : 'POST', body: JSON.stringify(data) });
          if (epoch !== life || sequence !== editRevision || !active) return;
          dialog.close(); page = 1; await load(); onMessage(record ? '节点记录已更新' : '定制节点已添加');
        } catch (error) {
          if (epoch === life && sequence === editRevision && active) { conflict = error.status === 409; $('#custom-node-form-error').textContent = error.message; $('#custom-node-reload').hidden = !conflict; }
        } finally { if (epoch === life) { saving = false; lock(false); } }
      };
      $('#custom-node-search-form').onsubmit = event => { event.preventDefault(); query = $('#custom-node-search').value.trim(); page = 1; onChange(); load(); };
      $('#custom-node-refresh').onclick = load;
      for (const [name, change] of [['prev', -1], ['next', 1]]) $('#custom-node-' + name).onclick = () => { page += change; load(); };
      function stop() { active = false; life++; revision++; editRevision++; saving = false; editing = null; conflict = false; dialog.close(); form.reset(); lock(false); $('#custom-node-loading').hidden = true; $('#custom-node-refresh').disabled = false; }
      return {
        activate() { if (!active) { active = true; life++; load(); } }, deactivate: stop,
        refresh() { if (active) load(); },
        getFilters: () => ({ nodeQuery: query }),
        setFilters(saved) { query = saved.nodeQuery || ''; $('#custom-node-search').value = query; },
        reset() { stop(); page = 1; query = ''; $('#custom-node-search').value = ''; $('#custom-node-rows').replaceChildren(); $('#custom-node-count').textContent = ''; $('#custom-node-error').textContent = ''; }
      };
    }
  };
})();
