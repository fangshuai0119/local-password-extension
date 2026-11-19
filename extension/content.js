/**
 * 内容脚本：表单识别 / 填充 / 手动框选
 * 注入到所有页面与所有 iframe；填充消息会广播到各 frame，由真正含表单的 frame 完成填充。
 */
(function () {
  'use strict';

  var ORIGIN = window.location.origin;
  var detectedPairs = [];
  var manualEls = null; // { usernameEl, passwordEl } 当前页面会话内的手动选择（支持 ShadowDOM）
  var selecting = false;
  var highlightEl = null;
  var scanTimer = null;

  /* ------------------------- 深度查询（含 ShadowDOM） ------------------------- */
  function deepQueryAll(root, selector) {
    var out = [];
    function walk(node) {
      var found = [];
      try { found = Array.prototype.slice.call(node.querySelectorAll(selector)); } catch (e) { /* ignore */ }
      found.forEach(function (el) { if (out.indexOf(el) === -1) out.push(el); });
      var all = [];
      try { all = Array.prototype.slice.call(node.querySelectorAll('*')); } catch (e) { /* ignore */ }
      all.forEach(function (el) {
        if (el.shadowRoot) walk(el.shadowRoot);
      });
    }
    walk(root);
    return out;
  }

  function isTextLikeInput(el) {
    if (!el || el.tagName !== 'INPUT') return false;
    var type = (el.type || 'text').toLowerCase();
    if (['password', 'hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset'].indexOf(type) !== -1) return false;
    return true;
  }

  function fieldScore(el) {
    var s = 0;
    var text = [el.name || '', el.id || '', el.getAttribute('placeholder') || '', el.getAttribute('autocomplete') || '', el.getAttribute('aria-label') || ''].join(' ').toLowerCase();
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac.indexOf('username') !== -1) s += 8;
    if (ac === 'email' || ac.indexOf('email') !== -1) s += 6;
    if (/user|login|account|uname|email|mail|phone|mobile|账号|用户名|手机号/.test(text)) s += 4;
    if (el.type === 'email') s += 3;
    if (el.type === 'tel') s += 2;
    if (el.required) s += 1;
    return s;
  }

  function findUsernameFor(passwordEl) {
    var form = null;
    try { form = passwordEl.closest('form'); } catch (e) { /* ignore */ }
    var containers = [];
    if (form) containers.push(form);
    var parent = passwordEl.parentElement;
    for (var i = 0; i < 3 && parent; i++) {
      containers.push(parent);
      parent = parent.parentElement;
    }

    var candidates = [];
    containers.forEach(function (container) {
      var inputs = [];
      try { inputs = Array.prototype.slice.call(container.querySelectorAll('input')); } catch (e) { /* ignore */ }
      inputs.forEach(function (el) {
        if (!isTextLikeInput(el) || el === passwordEl) return;
        candidates.push(el);
      });
    });

    // 去重后按分数排序
    var unique = [];
    candidates.forEach(function (el) { if (unique.indexOf(el) === -1) unique.push(el); });
    unique.sort(function (a, b) { return fieldScore(b) - fieldScore(a); });
    return unique[0] || null;
  }

  function scanForms() {
    var passwords = deepQueryAll(document, 'input[type="password"]');
    detectedPairs = passwords.map(function (pw) {
      return { usernameEl: findUsernameFor(pw), passwordEl: pw };
    }).filter(function (pair) { return pair.passwordEl; });
    return detectedPairs;
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(function () { scanForms(); }, 250);
  }

  /* ------------------------- 填充 ------------------------- */
  function setNativeValue(el, value) {
    if (!el) return;
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) {
      setter.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // 部分框架监听 keyup / compositionend
    try {
      el.dispatchEvent(new Event('keyup', { bubbles: true, key: 'Enter' }));
    } catch (e) { /* ignore */ }
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var tag = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(tag + '#' + cssEscape(node.id));
        break;
      }
      var cls = '';
      try {
        cls = Array.prototype.slice.call(node.classList || [])
          .filter(function (c) { return c && c.indexOf(' ') === -1; })
          .slice(0, 2)
          .map(function (c) { return '.' + cssEscape(c); })
          .join('');
      } catch (e) { /* ignore */ }
      var seg = tag + cls;
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.prototype.slice.call(parent.children).filter(function (x) { return x.tagName === node.tagName; });
        if (siblings.length > 1) seg += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      node = parent;
    }
    return parts.join(' > ');
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  // 从 document 穿透各级 shadowRoot 的选择器路径
  function shadowPath(el) {
    var segments = [];
    var node = el;
    while (node && node.nodeType === 1) {
      segments.unshift(cssPath(node));
      var root = node.getRootNode ? node.getRootNode() : document;
      if (!root || root.nodeType === 9 || !root.host) break;
      node = root.host;
    }
    return segments;
  }

  function resolveByPath(path) {
    if (!path) return null;
    try { return document.querySelector(path); } catch (e) { return null; }
  }

  function getManualFromStorage(callback) {
    try {
      chrome.storage.local.get({ manualSelectors: {} }, function (data) {
        var entry = (data.manualSelectors || {})[ORIGIN] || null;
        callback(entry);
      });
    } catch (e) {
      callback(null);
    }
  }

  function fill(username, password) {
    var userEl = null;
    var pwEl = null;

    // 优先：本次会话手动选择的元素（可跨 ShadowDOM）
    if (manualEls && manualEls.usernameEl.isConnected && manualEls.passwordEl.isConnected) {
      userEl = manualEls.usernameEl;
      pwEl = manualEls.passwordEl;
    }

    // 其次：持久化在配置里的 CSS 选择器（页面刷新后仍可用）
    if (!userEl || !pwEl) {
      getManualFromStorage(function (entry) {
        if (entry) {
          userEl = userEl || resolveByPath(entry.usernamePath);
          pwEl = pwEl || resolveByPath(entry.passwordPath);
        }
        doFill();
      });
      return;
    }
    doFill();

    function doFill() {
      var pairs = detectedPairs.length ? detectedPairs : scanForms();
      if (!userEl) {
        var pair = pairs.filter(function (p) { return p.usernameEl; })[0];
        if (pair) userEl = pair.usernameEl;
      }
      if (!pwEl) {
        pwEl = pairs.length ? pairs[0].passwordEl : deepQueryAll(document, 'input[type="password"]')[0];
      }
      if (!pwEl && !userEl) return false;
      if (userEl) setNativeValue(userEl, username);
      if (pwEl) setNativeValue(pwEl, password);
      return true;
    }
  }

  /* ------------------------- 手动框选 ------------------------- */
  function startSelection() {
    if (selecting) return;
    selecting = true;

    var bar = document.createElement('div');
    bar.id = '__lp_select_bar__';
    bar.setAttribute('style', [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
      'background:#1d4ed8', 'color:#fff', 'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'padding:10px 16px', 'display:flex', 'align-items:center', 'gap:14px',
      'box-shadow:0 2px 12px rgba(0,0,0,.3)'
    ].join(';'));
    bar.innerHTML = '<span id="__lp_select_tip__" style="flex:1">手动选择模式：请依次点击 <b>账号输入框</b> 和 <b>密码输入框</b></span>' +
      '<button id="__lp_cancel__" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,.7);border-radius:5px;padding:4px 12px;cursor:pointer;font-size:13px">取消</button>';
    (document.body || document.documentElement).appendChild(bar);

    var step = 0;
    var pickedUser = null;

    function onMove(e) {
      var el = e.target;
      if (!el || el === bar || bar.contains(el)) return;
      if (highlightEl && highlightEl.style) {
        highlightEl.style.setProperty('outline', highlightEl.__lpOldOutline || '', 'important');
      }
      highlightEl = el;
      if (el.style) {
        highlightEl.__lpOldOutline = el.style.getPropertyValue('outline') || '';
        el.style.setProperty('outline', '3px solid ' + (step === 0 ? '#22c55e' : '#f97316'), 'important');
      }
    }

    function onClick(e) {
      var el = e.target;
      if (!el || el === bar || bar.contains(el)) return;
      e.preventDefault();
      e.stopPropagation();
      if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
        var tip0 = document.getElementById('__lp_select_tip__');
        if (tip0) tip0.innerHTML = '<b>请点击输入框（input / textarea）</b>';
        return;
      }
      if (step === 0) {
        pickedUser = el;
        step = 1;
        var tip1 = document.getElementById('__lp_select_tip__');
        if (tip1) tip1.innerHTML = '已选账号框 ✔ 现在点击 <b>密码输入框</b>';
      } else {
        manualEls = { usernameEl: pickedUser, passwordEl: el };
        // 持久化 CSS 路径（跨页面刷新兜底）
        var entry = {
          usernamePath: cssPath(pickedUser),
          passwordPath: cssPath(el),
          usernameShadowPath: shadowPath(pickedUser),
          passwordShadowPath: shadowPath(el),
          time: Date.now()
        };
        chrome.storage.local.get({ manualSelectors: {} }, function (data) {
          var all = data.manualSelectors || {};
          all[ORIGIN] = entry;
          chrome.storage.local.set({ manualSelectors: all });
        });
        finish();
        try {
          chrome.runtime.sendMessage({ type: 'SELECTION_DONE', origin: ORIGIN, selectors: entry });
        } catch (err) { /* ignore */ }
      }
    }

    function onKey(e) {
      if (e.key === 'Escape') finish();
    }

    function finish() {
      selecting = false;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      if (highlightEl && highlightEl.style) highlightEl.style.setProperty('outline', highlightEl.__lpOldOutline || '', 'important');
      highlightEl = null;
      if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    }

    document.getElementById('__lp_cancel__').addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      finish();
    });

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  /* ------------------------- 消息处理 ------------------------- */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return;
    if (msg.type === 'FILL_FIELDS') {
      var ok = fill(msg.username, msg.password);
      sendResponse({ ok: !!ok, origin: ORIGIN });
      return;
    }
    if (msg.type === 'FILL_PASSWORD_ONLY') {
      var pairs0 = detectedPairs.length ? detectedPairs : scanForms();
      var pwEl0 = pairs0.length ? pairs0[0].passwordEl : deepQueryAll(document, 'input[type="password"]')[0];
      if (pwEl0) {
        setNativeValue(pwEl0, msg.password || '');
        sendResponse({ ok: true, origin: ORIGIN });
      } else {
        sendResponse({ ok: false, origin: ORIGIN });
      }
      return;
    }
    if (msg.type === 'START_SELECT') {
      startSelection();
      sendResponse({ ok: true, origin: ORIGIN });
      return;
    }
    if (msg.type === 'CANCEL_SELECT') {
      var b = document.getElementById('__lp_select_bar__');
      if (b && b.parentNode) b.parentNode.removeChild(b);
      selecting = false;
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'PING_CONTENT') {
      var pairs = detectedPairs.length ? detectedPairs : scanForms();
      sendResponse({
        ok: true,
        origin: ORIGIN,
        passwordCount: pairs.length,
        hasUsername: pairs.some(function (p) { return !!p.usernameEl; })
      });
      return;
    }
  });

  /* ------------------------- 初始化 ------------------------- */
  scanForms();

  var observer = new MutationObserver(function (mutations) {
    var needScan = mutations.some(function (m) {
      if (m.addedNodes && m.addedNodes.length) {
        for (var i = 0; i < m.addedNodes.length; i++) {
          var n = m.addedNodes[i];
          if (n.nodeType === 1 && (n.tagName === 'INPUT' || n.tagName === 'FORM' || (n.querySelector && (n.querySelector('input') || n.querySelector('[shadowroot]'))))) return true;
          if (n.nodeType === 1 && n.shadowRoot) return true;
        }
      }
      return false;
    });
    if (needScan) scheduleScan();
  });
  try {
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
  } catch (e) { /* ignore */ }
})();
