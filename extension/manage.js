/** 全部凭证管理页逻辑 */
(function () {
  'use strict';
  var API = window.PasswordAPI;
  var state = { all: [], filtered: [], editingKey: null };
  var $ = function (id) { return document.getElementById(id); };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setStatus(msg, ok) {
    $('status').textContent = msg;
    $('status').className = 'status ' + (ok ? 'ok' : 'err');
  }

  async function load() {
    try {
      var h = await API.health();
      setStatus('本地服务已连接 · ' + h.dataFile + ' · 共 ' + h.count + ' 条凭证', true);
      state.all = await API.getCredentials();
      render();
    } catch (e) {
      setStatus('本地服务未连接：' + e.message + '（请确认 start.bat 正在运行）', false);
      state.all = [];
      render();
    }
  }

  function render() {
    var q = ($('search').value || '').trim().toLowerCase();
    state.filtered = q ? state.all.filter(function (x) {
      return [x.domain, x.username, x.note, x.title, x.loginUrl, x.totp].join(' ').toLowerCase().indexOf(q) !== -1;
    }) : state.all.slice();

    state.filtered.sort(function (a, b) {
      return String(a.domain).localeCompare(String(b.domain)) || String(a.username).localeCompare(String(b.username));
    });

    $('count').textContent = '显示 ' + state.filtered.length + ' / ' + state.all.length + ' 条';
    $('empty').classList.toggle('hidden', state.filtered.length > 0);

    $('tbody').innerHTML = state.filtered.map(function (x, i) {
      return '<tr data-index="' + i + '">' +
        '<td>' + escapeHtml(x.domain) + '</td>' +
        '<td><div class="user">' + escapeHtml(x.username) + '</div></td>' +
        '<td><div>' + escapeHtml(x.note || '-') + '</div><div class="meta">' + escapeHtml(x.title || '') + '</div></td>' +
        '<td><div class="meta">' + escapeHtml(x.loginUrl || '') + '</div><div class="meta">' + escapeHtml(x.totp || '') + '</div></td>' +
        '<td><div class="meta">' + escapeHtml(x.createTime || '') + '</div></td>' +
        '<td class="ops">' +
          '<button class="btn btn-sm" data-act="copyUser">账号</button>' +
          '<button class="btn btn-sm" data-act="copyPwd">密码</button>' +
          '<button class="btn btn-sm" data-act="edit">编辑</button>' +
          '<button class="btn btn-sm btn-danger" data-act="del">删除</button>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      var old = $('status').textContent;
      setStatus('已复制' + label, true);
      setTimeout(function () { setStatus(old, true); }, 1500);
    } catch (e) {
      setStatus('复制失败：' + e.message, false);
    }
  }

  function openEditor(item) {
    state.editingKey = { domain: item.domain, username: item.username };
    $('editorTitle').textContent = '编辑凭证';
    $('fDomain').value = item.domain || '';
    $('fTitle').value = item.title || '';
    $('fUsername').value = item.username || '';
    $('fPassword').value = item.password || '';
    $('fNote').value = item.note || '';
    $('fLoginUrl').value = item.loginUrl || '';
    $('fTotp').value = item.totp || '';
    $('editor').classList.remove('hidden');
  }

  function closeEditor() { $('editor').classList.add('hidden'); state.editingKey = null; }

  async function saveEditor() {
    var domain = $('fDomain').value.trim();
    var username = $('fUsername').value.trim();
    if (!domain || !username) { alert('域名和账号不能为空'); return; }
    var item = {
      domain: domain,
      title: $('fTitle').value.trim(),
      username: username,
      password: $('fPassword').value,
      note: $('fNote').value.trim(),
      loginUrl: $('fLoginUrl').value.trim(),
      totp: $('fTotp').value.trim()
    };
    try {
      var oldKey = state.editingKey;
      if (oldKey && (oldKey.domain !== domain || oldKey.username !== username)) {
        await API.deleteCredential(oldKey);
        oldKey = null;
      }
      await API.saveCredential(item, oldKey);
      closeEditor();
      await load();
    } catch (e) {
      setStatus('保存失败：' + e.message, false);
    }
  }

  async function del(item) {
    if (!confirm('确定删除「' + item.domain + ' / ' + item.username + '」吗？硬盘文件中对应记录会一并删除。')) return;
    try {
      await API.deleteCredential({ domain: item.domain, username: item.username });
      await load();
    } catch (e) {
      setStatus('删除失败：' + e.message, false);
    }
  }

  async function exportBackup() {
    try {
      var res = await API.request('GET', '/api/export');
      var blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'password-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      setStatus('备份文件已导出', true);
    } catch (e) { setStatus('导出失败：' + e.message, false); }
  }

  async function importFile() {
    var file = $('importFile').files && $('importFile').files[0];
    if (!file) { alert('请先选择一个 JSON 文件'); return; }
    var mode = $('importMode').value;
    if (mode === 'overwrite' && !confirm('覆盖模式会清空现有全部凭证，确定继续吗？')) return;
    try {
      var text = await file.text();
      var items = JSON.parse(text);
      if (!Array.isArray(items)) throw new Error('JSON 顶层必须是数组');
      var res = await API.importCredentials(items, mode);
      setStatus('导入成功，当前共 ' + res.count + ' 条凭证', true);
      await load();
    } catch (e) {
      setStatus('导入失败：' + e.message, false);
    }
  }

  function bind() {
    $('btnRefresh').addEventListener('click', load);
    $('search').addEventListener('input', render);
    $('btnExport').addEventListener('click', exportBackup);
    $('btnImport').addEventListener('click', importFile);
    $('btnOptions').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
    $('editorClose').addEventListener('click', closeEditor);
    $('editorCancel').addEventListener('click', closeEditor);
    $('editor').querySelector('.modal-mask').addEventListener('click', closeEditor);
    $('editorSave').addEventListener('click', saveEditor);

    $('tbody').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var idx = parseInt(btn.closest('tr').getAttribute('data-index'), 10);
      var item = state.filtered[idx];
      if (!item) return;
      var act = btn.getAttribute('data-act');
      if (act === 'copyUser') copy(item.username || '', '账号');
      else if (act === 'copyPwd') copy(item.password || '', '密码');
      else if (act === 'edit') openEditor(item);
      else if (act === 'del') del(item);
    });
  }

  bind();
  load();
})();
