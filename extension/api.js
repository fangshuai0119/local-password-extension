/**
 * 公共通信层：扩展各页面与 content script 统一通过后台代理访问本地服务。
 * 同时提供配置读写（chrome.storage.local 仅作为开关缓存，不存密码）。
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    servicePort: 8765,
    autoFill: false,
    incognitoAllowed: false,
    clearClipboard: false,
    backupReminder: true,
    blacklist: '',
    lastCredentialKey: ''
  };

  function getSettings() {
    return chrome.storage.local.get(DEFAULTS);
  }

  function setSettings(patch) {
    return chrome.storage.local.set(patch);
  }

  /** 后台直接访问本地服务（不含插件间消息转发） */
  async function rawRequest(method, path, body) {
    var settings = await getSettings();
    var port = Number(settings.servicePort) || 8765;
    var url = 'http://127.0.0.1:' + port + path;
    var init = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (controller) {
      init.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, 5000);
    }

    var response;
    try {
      response = await fetch(url, init);
    } catch (e) {
      throw new Error('无法连接本地服务，请确认已运行 local-service/start.bat（或检查端口号）');
    } finally {
      if (timer) clearTimeout(timer);
    }

    var json;
    try {
      json = await response.json();
    } catch (e) {
      throw new Error('本地服务返回内容格式错误');
    }
    if (!response.ok || json.ok === false) {
      throw new Error(json.error || ('请求失败（HTTP ' + response.status + '）'));
    }
    return json;
  }

  /** 页面 / 内容脚本通过后台代理调用本地服务 */
  function request(method, path, body) {
    return new Promise(function (resolve, reject) {
      chrome.runtime.sendMessage(
        { type: 'SERVICE_API', method: method, path: path, body: body },
        function (resp) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!resp || !resp.ok) {
            reject(new Error((resp && resp.error) || '服务请求失败'));
            return;
          }
          resolve(resp.data);
        }
      );
    });
  }

  var api = {
    DEFAULTS: DEFAULTS,
    getSettings: getSettings,
    setSettings: setSettings,
    rawRequest: rawRequest,
    request: request,
    health: function () { return request('GET', '/health'); },
    getCredentials: async function () { return (await request('GET', '/api/credentials')).data; },
    saveCredential: function (credential, oldKey) {
      return request('POST', '/api/credentials', { credential: credential, oldKey: oldKey || null });
    },
    deleteCredential: function (key) { return request('POST', '/api/credentials/delete', { key: key }); },
    importCredentials: function (items, mode) { return request('POST', '/api/import', { items: items, mode: mode }); },
    getConfig: async function () { return (await request('GET', '/api/config')).config; },
    updateConfig: function (patch) { return request('POST', '/api/config', patch); }
  };

  global.PasswordAPI = api;
})(typeof window !== 'undefined' ? window : self);
