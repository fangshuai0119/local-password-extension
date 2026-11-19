# -*- coding: utf-8 -*-
"""
本地明文密码读写服务
- 仅监听 127.0.0.1，拒绝外部访问
- 所有凭证以明文 JSON 存在硬盘，插件不负责文件读写
- Python 标准库实现，无第三方依赖
"""
import json
import os
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "service_config.json")
LOG_FILE = os.path.join(BASE_DIR, "server.log")

DEFAULT_CONFIG = {
    "port": 8765,
    "dataFile": os.path.join(BASE_DIR, "password.json"),
    "logEnabled": True,
}

CONFIG = {}
FILE_LOCK = threading.Lock()
LOG_LOCK = threading.Lock()


# ----------------------------- 基础工具 -----------------------------

def log(message):
    line = "[%s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), message)
    print(line, flush=True)
    if CONFIG.get("logEnabled"):
        try:
            with LOG_LOCK:
                with open(LOG_FILE, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
        except Exception:
            pass


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                user_cfg = json.load(f)
            if isinstance(user_cfg, dict):
                cfg.update({k: v for k, v in user_cfg.items() if k in DEFAULT_CONFIG})
        except Exception as e:
            print("读取配置失败，使用默认配置：%s" % e, flush=True)
    else:
        save_config(cfg)
    return cfg


def save_config(cfg):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def normalize_path(path):
    if not path or not isinstance(path, str):
        return CONFIG["dataFile"]
    path = os.path.expanduser(path)
    if not os.path.isabs(path):
        path = os.path.join(BASE_DIR, path)
    return os.path.normpath(path)


def ensure_data_file():
    path = normalize_path(CONFIG["dataFile"])
    parent = os.path.dirname(path)
    if parent and not os.path.exists(parent):
        os.makedirs(parent, exist_ok=True)
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump([], f, ensure_ascii=False, indent=2)
        log("已新建数据文件：%s" % path)
    return path


def read_all():
    path = normalize_path(CONFIG["dataFile"])
    if not os.path.exists(path):
        ensure_data_file()
    with FILE_LOCK:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read().strip()
    if not content:
        return []
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        raise ValueError("password.json 不是合法的 JSON，请检查文件格式")
    if not isinstance(data, list):
        raise ValueError("password.json 顶层必须是数组 []")
    return data


def write_all(data):
    path = normalize_path(CONFIG["dataFile"])
    parent = os.path.dirname(path)
    if parent and not os.path.exists(parent):
        os.makedirs(parent, exist_ok=True)
    tmp = path + ".tmp"
    with FILE_LOCK:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    return path


def normalize_credential(raw):
    """补全字段，保证结构一致；不修改用户已有值。"""
    if not isinstance(raw, dict):
        raise ValueError("凭证必须是对象")
    item = {
        "domain": str(raw.get("domain", "") or ""),
        "title": str(raw.get("title", "") or ""),
        "username": str(raw.get("username", "") or ""),
        "password": str(raw.get("password", "") or ""),
        "note": str(raw.get("note", "") or ""),
        "loginUrl": str(raw.get("loginUrl", "") or ""),
        "totp": str(raw.get("totp", "") or ""),
        "createTime": str(raw.get("createTime", "") or ""),
    }
    if not item["createTime"]:
        item["createTime"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return item


def same_key(a, b):
    return (a.get("domain", ""), a.get("username", "")) == (b.get("domain", ""), b.get("username", ""))


# ----------------------------- HTTP 处理 -----------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "LocalPasswordService/1.0"
    protocol_version = "HTTP/1.1"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Content-Length 无效")
        if length <= 0:
            return {}
        if length > 5 * 1024 * 1024:
            raise ValueError("请求体过大")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            raise ValueError("请求体不是合法的 JSON")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path == "/health":
                data = read_all()
                self._send(200, {
                    "ok": True,
                    "version": "1.0.0",
                    "dataFile": normalize_path(CONFIG["dataFile"]),
                    "count": len(data),
                })
            elif path == "/api/credentials":
                self._send(200, {"ok": True, "data": read_all()})
            elif path == "/api/export":
                self._send(200, {"ok": True, "data": read_all()})
            elif path == "/api/config":
                self._send(200, {
                    "ok": True,
                    "config": {
                        "port": CONFIG["port"],
                        "dataFile": normalize_path(CONFIG["dataFile"]),
                        "logEnabled": bool(CONFIG["logEnabled"]),
                    },
                })
            else:
                self._send(404, {"ok": False, "error": "未找到接口"})
        except ValueError as e:
            self._send(400, {"ok": False, "error": str(e)})
        except Exception as e:
            log("GET %s 异常：%s" % (path, e))
            self._send(500, {"ok": False, "error": "服务内部错误：%s" % e})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self._read_body()

            if path == "/api/credentials":
                raw = body.get("credential")
                if not isinstance(raw, dict):
                    raise ValueError("凭证必须是对象")
                old_key = body.get("oldKey")
                data = read_all()
                idx = -1
                if isinstance(old_key, dict) and old_key:
                    for i, existing in enumerate(data):
                        if same_key(existing, old_key):
                            idx = i
                            break
                if idx < 0:
                    for i, existing in enumerate(data):
                        if same_key(existing, {k: raw.get(k, "") for k in ("domain", "username")}):
                            idx = i
                            break
                if idx >= 0:
                    # 更新：以旧记录为底，仅覆盖请求中出现的字段，避免丢备注等信息
                    merged = dict(data[idx])
                    for k in merged:
                        if k in raw:
                            merged[k] = raw[k]
                    item = normalize_credential(merged)
                    item["createTime"] = data[idx].get("createTime") or item["createTime"]
                    data[idx] = item
                    action = "更新"
                else:
                    data.append(normalize_credential(raw))
                    item = data[-1]
                    action = "新增"
                write_all(data)
                log("%s凭证：%s / %s" % (action, item["domain"], item["username"]))
                self._send(200, {"ok": True, "count": len(data), "action": action})
                return

            if path == "/api/credentials/delete":
                key = body.get("key") or body
                data = read_all()
                kept = [x for x in data if not same_key(x, key)]
                deleted = len(data) - len(kept)
                if deleted:
                    write_all(kept)
                log("删除凭证 %d 条：%s / %s" % (deleted, key.get("domain", ""), key.get("username", "")))
                self._send(200, {"ok": True, "deleted": deleted, "count": len(kept)})
                return

            if path == "/api/import":
                items = body.get("items")
                mode = body.get("mode", "merge")
                if not isinstance(items, list):
                    raise ValueError("items 必须是数组")
                cleaned = [normalize_credential(x) for x in items if isinstance(x, dict)]
                if mode == "overwrite":
                    result = cleaned
                else:
                    result = read_all()
                    for item in cleaned:
                        replaced = False
                        for i, existing in enumerate(result):
                            if same_key(existing, item):
                                result[i] = item
                                replaced = True
                                break
                        if not replaced:
                            result.append(item)
                write_all(result)
                log("导入凭证 %d 条，模式=%s，当前共 %d 条" % (len(cleaned), mode, len(result)))
                self._send(200, {"ok": True, "count": len(result)})
                return

            if path == "/api/config":
                restart_required = False
                if "port" in body:
                    try:
                        port = int(body["port"])
                        if port < 1 or port > 65535:
                            raise ValueError()
                    except Exception:
                        raise ValueError("端口号必须是 1-65535 的整数")
                    if port != CONFIG["port"]:
                        CONFIG["port"] = port
                        restart_required = True
                if "dataFile" in body:
                    CONFIG["dataFile"] = normalize_path(body["dataFile"])
                    ensure_data_file()
                if "logEnabled" in body:
                    CONFIG["logEnabled"] = bool(body["logEnabled"])
                save_config(CONFIG)
                log("配置已更新")
                self._send(200, {
                    "ok": True,
                    "restartRequired": restart_required,
                    "config": {
                        "port": CONFIG["port"],
                        "dataFile": normalize_path(CONFIG["dataFile"]),
                        "logEnabled": bool(CONFIG["logEnabled"]),
                    },
                })
                return

            self._send(404, {"ok": False, "error": "未找到接口"})
        except ValueError as e:
            self._send(400, {"ok": False, "error": str(e)})
        except Exception as e:
            log("POST %s 异常：%s" % (path, e))
            self._send(500, {"ok": False, "error": "服务内部错误：%s" % e})

    def log_message(self, fmt, *args):
        # 不输出每个 HTTP 请求，避免刷屏；关键操作用 log() 输出
        pass


def main():
    global CONFIG
    CONFIG = load_config()
    ensure_data_file()

    port = int(CONFIG["port"])
    # 关键安全约束：只绑定本机回环地址，外部 IP 无法访问
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True

    print("=" * 58)
    print(" 本地明文密码服务已启动")
    print(" 监听地址：http://127.0.0.1:%d （仅本机可访问）" % port)
    print(" 数据文件：%s" % normalize_path(CONFIG["dataFile"]))
    print(" 按 Ctrl+C 停止服务")
    print("=" * 58, flush=True)
    log("服务启动，端口=%d" % port)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n正在停止服务...", flush=True)
        log("服务停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
