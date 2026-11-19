/** 弹窗主逻辑 */
(function () {
  'use strict';

  var API = window.PasswordAPI;
  var state = {
    tab: null,
    origin: '',
    incognito: false,
    settings: {},
    all: [],
    editingKey: null,
    toastTimer: null
  };

  var $ = function (id) { return document.getElementById(id); };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(msg, type) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (type ? ' ' + type : '');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2800);
  }

  function guardIncognito() {
    if (state.incognito && !state.settings.incognitoAllowed) {
      toast('无痕模式下已禁用读取 / 保存（可在设置中开启）', 'err');
      return false;
    }
    return true;
  }

  function sameKey(a, b) {
    return a && b && a.domain === b.domain && a.username === b.username;
  }

  /* ------------------------- 渲染 ------------------------- */
  function cardHtml(item, domainText, index, showDomain) {
    return '' +
      '<div class="card" data-index="' + index + '">' +
        '<div class="card-head">' +
          '<div>' +
            '<div class="card-user">' + escapeHtml(item.username || '(空账号)') + '</div>' +
            (item.note ? '<div class="card-note">📝 ' + escapeHtml(item.note) + '</div>' : '') +
            (item.loginUrl ? '<div class="card-note">🔗 ' + escapeHtml(item.loginUrl) + '</div>' : '') +
            (showDomain ? '<div class="card-domain">' + escapeHtml(item.domain || '') + '</div>' : '') +
          '</div>' +
          '<div class="card-time">' + escapeHtml((item.createTime || '').slice(5)) + '</div>' +
        '</div>' +
        '<div class="card-actions">' +
          '<button class="btn btn-sm fill-btn" data-act="fill">填充</button>' +
          '<button class="btn btn-sm" data-act="copyUser">复制账号</button>' +
          '<button class="btn btn-sm" data-act="copyPwd">复制密码</button>' +
          '<button class="btn btn-sm" data-act="edit">编辑</button>' +
          '<button class="btn btn-sm btn-danger" data-act="del">删除</button>' +
        '</div>' +
      '</div>';
  }

  function render() {
    var siteItems = state.all.filter(function (x) { return x.domain === state.origin; });
    var siteList = $('siteList');
    siteList.innerHTML = siteItems.length
      ? siteItems.map(function (x, i) { return cardHtml(x, state.origin, i, false); }).join('')
      : '<div class="empty">当前网站暂无凭证<br>先在页面输入账号密码，再点「读取表单」保存</div>';

    var q = ($('globalSearch').value || '').trim().toLowerCase();
    var filtered = q ? state.all.filter(function (x) {
      return [x.domain, x.username, x.note, x.title, x.loginUrl].join(' ').toLowerCase().indexOf(q) !== -1;
    }) : state.all;

    $('allCount').textContent = '共 ' + state.all.length + ' 条' + (q ? '，匹配 ' + filtered.length + ' 条' : '');
    $('allList').innerHTML = filtered.length
      ? filtered.map(function (x, i) { return cardHtml(x, x.domain, i, false); }).join('')
      : '<div class="empty">' + (state.all.length ? '没有匹配的凭证' : '硬盘 JSON 中还没有凭证') + '</div>';

    // 保存当前渲染顺序，供事件委托取用
    siteList.__items = siteItems;
    $('allList').__items = filtered;
  }

  async function loadCredentials() {
    if (!guardIncognito()) {
      state.all = [];
      render();
      return;
    }
    try {
      state.all = await API.getCredentials();
      render();
    } catch (e) {
      toast('读取失败：' + e.message, 'err');
      $('siteList').innerHTML = '<div class="empty">读取失败：' + escapeHtml(e.message) + '</div>';
    }
  }

  async function checkHealth() {
    try {
      var info = await API.health();
      $('connDot').className = 'dot dot-green';
      $('connText').textContent = '本地服务已连接 · ' + info.count + ' 条凭证';
      $('connText').title = '数据文件：' + info.dataFile;
      return true;
    } catch (e) {
      $('connDot').className = 'dot dot-red';
      $('connText').textContent = '本地服务未连接';
      $('connText').title = e.message;
      return false;
    }
  }

  /* ------------------------- 操作 ------------------------- */
  async function getManualSelectors() {
    var data = await chrome.storage.local.get({ manualSelectors: {} });
    return (data.manualSelectors || {})[state.origin] || {};
  }

  /** 跨所有 frame 填充，聚合结果，兼容 iframe 与 ShadowDOM */
  async function pageFill(username, password, passwordOnly) {
    if (!state.tab || state.tab.id == null) return false;
    var manual = await getManualSelectors();
    var results = await chrome.scripting.executeScript({
      target: { tabId: state.tab.id, allFrames: true },
      func: function (args) {
        function setVal(el, v) {
          if (!el) return false;
          var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var d = Object.getOwnPropertyDescriptor(proto, 'value');
          if (d && d.set) d.set.call(el, v); else el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        function deep(sel) {
          var out = [];
          (function walk(root) {
            var a = [];
            try { a = root.querySelectorAll(sel); } catch (e) { /* ignore */ }
            for (var i = 0; i < a.length; i++) if (out.indexOf(a[i]) === -1) out.push(a[i]);
            var all = [];
            try { all = root.querySelectorAll('*'); } catch (e) { /* ignore */ }
            for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) walk(all[j].shadowRoot);
          })(document);
          return out;
        }
        function resolvePath(segs) {
          if (!segs || !segs.length) return null;
          var root = document, el = null;
          for (var i = 0; i < segs.length; i++) {
            try { el = root.querySelector(segs[i]); } catch (e) { return null; }
            if (!el) return null;
            if (i < segs.length - 1) {
              if (!el.shadowRoot) return null;
              root = el.shadowRoot;
            }
          }
          return el;
        }
        function bySimplePath(path) {
          try { return path ? document.querySelector(path) : null; } catch (e) { return null; }
        }

        var m = args.manual || {};
        var userEl = args.passwordOnly ? null : (resolvePath(m.usernameShadowPath) || bySimplePath(m.usernamePath));
        var pwEl = resolvePath(m.passwordShadowPath) || bySimplePath(m.passwordPath);
        var pws = deep('input[type="password"]');
        var visible = pws.filter(function (el) { return el.getClientRects().length > 0; });
        if (!pwEl) pwEl = visible[0] || pws[0];

        if (!args.passwordOnly && !userEl && pwEl) {
          var containers = [];
          var form = pwEl.closest ? pwEl.closest('form') : null;
          if (form) containers.push(form);
          var p = pwEl.parentElement;
          for (var i = 0; i < 3 && p; i++) { containers.push(p); p = p.parentElement; }
          var cand = [];
          containers.forEach(function (c) {
            var ins = c.querySelectorAll('input');
            for (var k = 0; k < ins.length; k++) {
              var el = ins[k], t = (el.type || 'text').toLowerCase();
              if (['password', 'hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'].indexOf(t) !== -1) continue;
              if (cand.indexOf(el) === -1) cand.push(el);
            }
          });
          function score(el) {
            var s = 0;
            var text = [el.name || '', el.id || '', el.getAttribute('placeholder') || '', el.getAttribute('autocomplete') || ''].join(' ').toLowerCase();
            if ((el.getAttribute('autocomplete') || '').indexOf('username') !== -1) s += 8;
            if (/user|login|account|uname|email|mail|phone|账号|用户名/.test(text)) s += 4;
            return s;
          }
          cand.sort(function (a, b) { return score(b) - score(a); });
          userEl = cand[0];
        }

        var did = false;
        if (pwEl && typeof args.password === 'string') { setVal(pwEl, args.password); did = true; }
        if (!args.passwordOnly && userEl && typeof args.username === 'string') { setVal(userEl, args.username); did = true; }
        return { did: did, user: !!userEl, pwd: !!pwEl };
      },
      args: [{
        username: username || '',
        password: password || '',
        passwordOnly: !!passwordOnly,
        manual: manual
      }]
    });
    return (results || []).some(function (r) { return r && r.result && r.result.did; });
  }

  async function doFill(item) {
    if (!state.tab || state.tab.id == null) return;
    try {
      var ok = await pageFill(item.username, item.password, false);
      toast(ok ? '已填充「' + item.username + '」' : '未找到表单，试试「手动框选」', ok ? 'ok' : 'err');
    } catch (e) {
      toast('填充失败：' + e.message, 'err');
    }
  }

  async function copyText(text, isPassword) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制' + (isPassword ? '密码' : '账号'), 'ok');
      if (isPassword && state.settings.clearClipboard) {
        chrome.runtime.sendMessage({ type: 'SCHEDULE_CLIPBOARD_CLEAR', tabId: state.tab && state.tab.id });
        toast('已复制密码，10 秒后自动清空剪贴板', 'ok');
      }
    } catch (e) {
      toast('复制失败：' + e.message, 'err');
    }
  }

  function openEditor(item, defaultDomain) {
    $('editorTitle').textContent = item ? '编辑凭证' : '新增凭证';
    state.editingKey = item ? { domain: item.domain, username: item.username } : null;
    $('fDomain').value = item ? item.domain : (defaultDomain || state.origin || '');
    $('fTitle').value = item ? (item.title || '') : (state.tab ? state.tab.title || '' : '');
    $('fUsername').value = item ? item.username || '' : '';
    $('fPassword').value = item ? item.password || '' : '';
    $('fNote').value = item ? item.note || '' : '';
    $('fLoginUrl').value = item ? item.loginUrl || '' : '';
    $('fTotp').value = item ? item.totp || '' : '';
    $('fPassword').type = 'password';
    $('editor').classList.remove('hidden');
    setTimeout(function () { $('fUsername').focus(); }, 50);
  }

  function closeEditor() {
    $('editor').classList.add('hidden');
    state.editingKey = null;
  }

  async function saveEditor() {
    if (!guardIncognito()) return;
    var domain = $('fDomain').value.trim();
    var username = $('fUsername').value.trim();
    var password = $('fPassword').value;
    if (!domain) { toast('请填写网站域名', 'err'); return; }
    if (!username) { toast('请填写用户名', 'err'); return; }

    var item = {
      domain: domain,
      title: $('fTitle').value.trim(),
      username: username,
      password: password,
      note: $('fNote').value.trim(),
      loginUrl: $('fLoginUrl').value.trim(),
      totp: $('fTotp').value.trim()
    };
    if (!item.createTime) delete item.createTime;

    try {
      var oldKey = state.editingKey;
      if (oldKey && (oldKey.domain !== domain || oldKey.username !== username)) {
        // 键发生变化：先删旧再加新（由服务保证原子性更好，这里两步足以满足自用场景）
        await API.deleteCredential(oldKey);
        oldKey = null;
      }
      var res = await API.saveCredential(item, oldKey);
      closeEditor();
      toast((res.action === '更新' ? '已更新' : '已保存') + '到本地硬盘 JSON', 'ok');
      await checkHealth();
      await loadCredentials();
    } catch (e) {
      toast('保存失败：' + e.message, 'err');
    }
  }

  async function deleteItem(item) {
    if (!guardIncognito()) return;
    if (!window.confirm('确定删除「' + item.domain + ' / ' + item.username + '」吗？此操作会同步删除硬盘文件中的记录。')) return;
    try {
      var res = await API.deleteCredential({ domain: item.domain, username: item.username });
      toast('已删除 ' + res.deleted + ' 条', 'ok');
      await checkHealth();
      await loadCredentials();
    } catch (e) {
      toast('删除失败：' + e.message, 'err');
    }
  }

  async function readForm() {
    if (!state.tab || state.tab.id == null) return;
    if (!guardIncognito()) return;
    try {
      var results = await chrome.scripting.executeScript({
        target: { tabId: state.tab.id, allFrames: true },
        func: function () {
          var pwList = [];
          (function walk(root) {
            var arr = [];
            try { arr = root.querySelectorAll('input[type="password"]'); } catch (e) { /* ignore */ }
            for (var i = 0; i < arr.length; i++) if (pwList.indexOf(arr[i]) === -1) pwList.push(arr[i]);
            var all = [];
            try { all = root.querySelectorAll('*'); } catch (e) { /* ignore */ }
            for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) walk(all[j].shadowRoot);
          })(document);

          var out = [];
          pwList.forEach(function (pw) {
            var containers = [];
            var form = pw.closest ? pw.closest('form') : null;
            if (form) containers.push(form);
            var p = pw.parentElement;
            for (var i = 0; i < 3 && p; i++) { containers.push(p); p = p.parentElement; }
            var candidates = [];
            containers.forEach(function (c) {
              var ins = c.querySelectorAll('input');
              for (var k = 0; k < ins.length; k++) {
                var el = ins[k];
                var t = (el.type || 'text').toLowerCase();
                if (['password', 'hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'].indexOf(t) !== -1) continue;
                if (el.value && candidates.indexOf(el) === -1) candidates.push(el);
              }
            });
            var pick = candidates[0];
            if (pick && pw.value) {
              out.push({ username: pick.value, password: pw.value, domain: location.origin, title: document.title });
            }
          });

          if (!out.length) {
            var texts = document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"]');
            var u = '';
            for (var i = 0; i < texts.length; i++) if (texts[i].value) { u = texts[i].value; break; }
            var p = pwList.length ? (pwList[0].value || '') : '';
            if (u || p) out.push({ username: u, password: p, domain: location.origin, title: document.title });
          }
          return out;
        }
      });

      var found = [];
      results.forEach(function (r) {
        if (r && r.result && Array.isArray(r.result)) found = found.concat(r.result);
      });

      if (!found.length) {
        toast('未读取到表单内容，请先填写账号密码；或用「手动框选」指定输入框', 'err');
        return;
      }
      var first = found[0];
      first.domain = first.domain || state.origin;
      openEditor(first);
      toast('已读取表单内容，请确认后保存', 'ok');
    } catch (e) {
      toast('读取表单失败：' + e.message, 'err');
    }
  }

  async function manualSelect() {
    if (!state.tab || state.tab.id == null) return;
    try {
      await chrome.tabs.sendMessage(state.tab.id, { type: 'START_SELECT' }, { frameId: 0 });
      toast('已进入手动框选：依次点击账号框和密码框', 'ok');
    } catch (e) {
      toast('无法进入框选模式：' + e.message, 'err');
    }
  }

  /* ------------------------- 生成器 ------------------------- */
  function generatePassword() {
    var len = parseInt($('genLength').value, 10) || 16;
    var pools = [];
    if ($('genUpper').checked) pools.push('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    if ($('genLower').checked) pools.push('abcdefghijklmnopqrstuvwxyz');
    if ($('genDigit').checked) pools.push('0123456789');
    if ($('genSymbol').checked) pools.push('!@#$%^&*()-_=+[]{};:,.?');
    if (!pools.length) { toast('至少勾选一种字符类型', 'err'); return ''; }
    var all = pools.join('');
    var chars = [];
    pools.forEach(function (p) { chars.push(p[Math.floor(Math.random() * p.length)]); });
    while (chars.length < len) chars.push(all[Math.floor(Math.random() * all.length)]);
    for (var i = chars.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = chars[i]; chars[i] = chars[j]; chars[j] = t;
    }
    var pwd = chars.join('');
    $('genResult').value = pwd;
    return pwd;
  }

  async function exportBackup() {
    try {
      var data = await API.request('GET', '/api/export');
      var blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'password-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      toast('备份文件已导出', 'ok');
    } catch (e) {
      toast('导出失败：' + e.message, 'err');
    }
  }

  /* ------------------------- 事件绑定 ------------------------- */
  function bindList(listId, getItems) {
    $(listId).addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var index = parseInt(btn.closest('.card').getAttribute('data-index'), 10);
      var item = (getItems() || [])[index];
      if (!item) return;
      var act = btn.getAttribute('data-act');
      if (act === 'fill') doFill(item);
      else if (act === 'copyUser') copyText(item.username || '', false);
      else if (act === 'copyPwd') copyText(item.password || '', true);
      else if (act === 'edit') openEditor(item);
      else if (act === 'del') deleteItem(item);
    });
  }

  function bind() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
        document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
        tab.classList.add('active');
        $('panel-' + tab.getAttribute('data-tab')).classList.add('active');
      });
    });

    $('btnRefresh').addEventListener('click', async function () {
      await checkHealth();
      await loadCredentials();
      toast('已从硬盘重新加载', 'ok');
    });
    $('btnReadForm').addEventListener('click', readForm);
    $('btnManualSelect').addEventListener('click', manualSelect);
    $('btnAddSite').addEventListener('click', function () { openEditor(null, state.origin); });
    $('btnManage').addEventListener('click', function () { chrome.tabs.create({ url: chrome.runtime.getURL('manage.html') }); });
    $('btnOptions').addEventListener('click', function () { chrome.runtime.openOptionsPage(); });
    $('btnExport').addEventListener('click', exportBackup);
    $('globalSearch').addEventListener('input', render);

    $('editorClose').addEventListener('click', closeEditor);
    $('editorCancel').addEventListener('click', closeEditor);
    $('editor').querySelector('.modal-mask').addEventListener('click', closeEditor);
    $('editorSave').addEventListener('click', saveEditor);
    $('btnTogglePwd').addEventListener('click', function () {
      var input = $('fPassword');
      input.type = input.type === 'password' ? 'text' : 'password';
    });

    $('genLength').addEventListener('input', function () { $('lenValue').textContent = $('genLength').value; });
    $('btnGenerate').addEventListener('click', generatePassword);
    $('btnGenCopy').addEventListener('click', function () {
      var v = $('genResult').value || generatePassword();
      copyText(v, true);
    });
    $('btnGenFill').addEventListener('click', async function () {
      var v = $('genResult').value || generatePassword();
      if (!state.tab || state.tab.id == null) return;
      try {
        var ok = await pageFill('', v, true);
        toast(ok ? '已填入密码框' : '未找到密码框', ok ? 'ok' : 'err');
      } catch (e) { toast('填充失败：' + e.message, 'err'); }
    });
    $('btnGenSave').addEventListener('click', function () {
      var v = $('genResult').value || generatePassword();
      openEditor({ domain: state.origin, username: '', password: v, title: state.tab ? state.tab.title || '' : '' });
    });

    bindList('siteList', function () { return $('siteList').__items; });
    bindList('allList', function () { return $('allList').__items; });

    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'SELECTION_DONE') {
        toast('已记录输入框位置，现在可以点「填充」了', 'ok');
      }
    });
  }

  /* ------------------------- 初始化 ------------------------- */
  async function init() {
    bind();
    state.settings = await API.getSettings();

    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      state.tab = tabs[0] || null;
      if (state.tab && state.tab.url) {
        try { state.origin = new URL(state.tab.url).origin; } catch (e) { state.origin = ''; }
      }
      state.incognito = !!(state.tab && state.tab.incognito);
    } catch (e) { /* ignore */ }

    $('domainText').textContent = state.origin || '—';
    $('domainText').title = state.origin || '当前页面不是普通 http(s) 网站';
    if (state.incognito) $('incognitoWarn').classList.remove('hidden');

    await checkHealth();
    await loadCredentials();

    if (state.tab && state.tab.id != null) {
      try {
        var ping = await new Promise(function (resolve) {
          chrome.tabs.sendMessage(state.tab.id, { type: 'PING_CONTENT' }, function (r) { resolve(r); });
        });
        if (ping && ping.ok) {
          var hint = $('formHint');
          hint.classList.remove('hidden');
          hint.textContent = ping.passwordCount
            ? '检测到 ' + ping.passwordCount + ' 个密码框' + (ping.hasUsername ? '及对应账号框' : '（未找到账号框，可手动框选）')
            : '未自动识别到表单，可点「手动框选」指定输入框';
        }
      } catch (e) { /* 页面未注入内容脚本时忽略 */ }
    }
  }

  init();
})();
