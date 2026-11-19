/** 设置页逻辑 */
(function () {
  'use strict';
  var API = window.PasswordAPI;
  var $ = function (id) { return document.getElementById(id); };

  function status(msg, ok) {
    var el = $('serviceStatus');
    el.textContent = msg;
    el.className = 'status ' + (ok ? 'ok' : 'err');
  }

  async function loadServerConfig() {
    try {
      var cfg = await API.getConfig();
      $('optPort').value = cfg.port;
      $('optDataFile').value = cfg.dataFile;
      $('optLogEnabled').checked = !!cfg.logEnabled;
      var health = await API.health();
      status('本地服务已连接 · 数据文件：' + health.dataFile + ' · 共 ' + health.count + ' 条凭证', true);
    } catch (e) {
      status('本地服务未连接：' + e.message, false);
    }
  }

  async function loadPrefs() {
    var s = await API.getSettings();
    $('optAutoFill').checked = !!s.autoFill;
    $('optIncognito').checked = !!s.incognitoAllowed;
    $('optClearClipboard').checked = !!s.clearClipboard;
    $('optBackupReminder').checked = !!s.backupReminder;
    $('optBlacklist').value = s.blacklist || '';
  }

  function bind() {
    $('btnTest').addEventListener('click', async function () {
      try {
        var h = await API.health();
        status('连接成功 · ' + h.dataFile + ' · ' + h.count + ' 条凭证', true);
      } catch (e) {
        status('连接失败：' + e.message, false);
      }
    });

    $('btnSaveServer').addEventListener('click', async function () {
      var patch = {
        port: parseInt($('optPort').value, 10),
        dataFile: $('optDataFile').value.trim(),
        logEnabled: $('optLogEnabled').checked
      };
      if (!patch.dataFile) { alert('请填写 password.json 完整路径'); return; }
      try {
        var res = await API.updateConfig(patch);
        if (res.restartRequired) {
          status('配置已保存。端口号已变更，请停止并重新启动本地服务后生效。', true);
        } else {
          status('配置已保存 · 数据文件：' + res.config.dataFile, true);
        }
      } catch (e) {
        status('保存失败：' + e.message, false);
      }
    });

    $('btnSavePrefs').addEventListener('click', async function () {
      await API.setSettings({
        autoFill: $('optAutoFill').checked,
        incognitoAllowed: $('optIncognito').checked,
        clearClipboard: $('optClearClipboard').checked,
        backupReminder: $('optBackupReminder').checked,
        blacklist: $('optBlacklist').value.trim()
      });
      var btn = $('btnSavePrefs');
      var old = btn.textContent;
      btn.textContent = '已保存 ✓';
      setTimeout(function () { btn.textContent = old; }, 1500);
    });

    $('btnClearSelectors').addEventListener('click', async function () {
      if (!confirm('确定清除所有网站的手动框选记录吗？清除后需重新框选。')) return;
      await API.setSettings({ manualSelectors: {}, lastFillIndex: -1 });
      alert('已清除');
    });
  }

  bind();
  loadServerConfig();
  loadPrefs();
})();
