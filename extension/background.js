/**
 * 后台 Service Worker
 * - 代理本地服务请求（统一入口，所有页面/内容脚本共用）
 * - 可选自动填充、快捷键
 * - 不存储任何密码，配置仅存开关
 */
importScripts('api.js');

var API = self.PasswordAPI;

/* ------------------------- 服务请求代理 ------------------------- */
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'SERVICE_API') {
    return;
  }
  API.rawRequest(msg.method, msg.path, msg.body)
    .then(function (data) { sendResponse({ ok: true, data: data }); })
    .catch(function (err) { sendResponse({ ok: false, error: err.message }); });
  return true; // 保持消息通道，等待异步响应
});

/* ------------------------- 剪贴板延时清空 ------------------------- */
chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.type !== 'SCHEDULE_CLIPBOARD_CLEAR') return;
  setTimeout(async function () {
    try {
      var tab = await chrome.tabs.get(msg.tabId);
      if (!tab || tab.id == null) return;
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () {
          try { navigator.clipboard.writeText('').catch(function () {}); } catch (e) { /* ignore */ }
        }
      });
    } catch (e) {
      // 页面不允许注入时忽略
    }
  }, 10000);
});

/* ------------------------- 工具函数 ------------------------- */
function isHttpUrl(url) {
  return /^https?:\/\//i.test(url || '');
}

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return '';
  }
}

function isBlacklisted(origin, blacklist) {
  var list = String(blacklist || '')
    .split(/[\n,;，；]+/)
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean);
  if (!list.length) return false;
  var host = '';
  try { host = new URL(origin).hostname.toLowerCase(); } catch (e) { /* ignore */ }
  return list.some(function (item) {
    if (item.indexOf('*.') === 0) return host.endsWith(item.slice(1));
    return host === item || String(origin).toLowerCase().indexOf(item) !== -1;
  });
}

/** 按 origin 取凭证，返回数组 */
async function credentialsFor(tab, settings) {
  if (!tab || !isHttpUrl(tab.url)) return [];
  if (tab.incognito && !settings.incognitoAllowed) return [];
  var origin = getOrigin(tab.url);
  if (isBlacklisted(origin, settings.blacklist)) return [];
  var result = await API.rawRequest('GET', '/api/credentials');
  return (result.data || []).filter(function (x) {
    return x.domain === origin && x.username && x.password;
  });
}

async function fillInto(tab, items, silent) {
  if (!items.length || !tab || tab.id == null) return false;
  await chrome.tabs.sendMessage(tab.id, {
    type: 'FILL_FIELDS',
    username: items[0].username,
    password: items[0].password,
    silent: !!silent
  });
  return true;
}

/* ------------------------- 可选：导航完成后自动填充 ------------------------- */
chrome.tabs.onUpdated.addListener(async function (tabId, changeInfo, tab) {
  if (changeInfo.status !== 'complete' || !tab || !isHttpUrl(tab.url)) return;
  try {
    var settings = await API.getSettings();
    if (!settings.autoFill) return;
    var items = await credentialsFor(tab, settings);
    if (items.length) {
      await fillInto(tab, items, true);
    }
  } catch (e) {
    // 自动填充失败保持静默，避免打扰；用户仍可手动填充
  }
});

/* ------------------------- 快捷键 ------------------------- */
chrome.commands.onCommand.addListener(async function (command) {
  if (command === 'open-manager') {
    if (chrome.action && typeof chrome.action.openPopup === 'function') {
      try {
        await chrome.action.openPopup();
        return;
      } catch (e) {
        // 部分 Chrome 版本不支持，降级为打开标签页
      }
    }
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
    return;
  }

  if (command === 'fill-current') {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      var tab = tabs[0];
      if (!tab || !isHttpUrl(tab.url)) return;
      var settings = await API.getSettings();
      var items = await credentialsFor(tab, settings);
      if (!items.length) return;

      // 连续按快捷键可在多条账号间轮换
      var stored = await chrome.storage.local.get({ lastFillIndex: -1 });
      var next = (Number(stored.lastFillIndex) + 1) % items.length;
      await chrome.storage.local.set({ lastFillIndex: next });
      var rotated = items.slice(next).concat(items.slice(0, next));

      await chrome.tabs.sendMessage(tab.id, {
        type: 'FILL_FIELDS',
        username: rotated[0].username,
        password: rotated[0].password,
        silent: false
      });
    } catch (e) {
      // 快捷键场景静默失败
    }
  }
});

/* ------------------------- 初始化默认配置 ------------------------- */
chrome.runtime.onInstalled.addListener(async function () {
  var current = await API.getSettings();
  await chrome.storage.local.set(current);
});
