"""Client Marionette minimal (bibliothèque standard seulement) et lanceur d'une
instance Gecko (Zen ou Firefox) sans interface, sur un profil temporaire.

Le profil de l'utilisateur n'est jamais utilisé : tout se passe dans un dossier
jetable passé en argument."""

import json
import os
import socket
import subprocess
import time


class MarionetteError(Exception):
    pass


class Marionette:
    def __init__(self, port, timeout=600, connect_timeout=90):
        deadline = time.time() + connect_timeout
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.4)
        self.buf = b""
        self.msgid = 0
        self.hello = self._recv()

    def _recv(self):
        while b":" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise MarionetteError("connexion fermée")
            self.buf += chunk
        size, rest = self.buf.split(b":", 1)
        size = int(size)
        while len(rest) < size:
            chunk = self.sock.recv(max(65536, size - len(rest)))
            if not chunk:
                raise MarionetteError("connexion fermée")
            rest += chunk
        data, self.buf = rest[:size], rest[size:]
        return json.loads(data.decode("utf-8"))

    def cmd(self, name, params=None):
        self.msgid += 1
        payload = json.dumps([0, self.msgid, name, params or {}]).encode("utf-8")
        self.sock.sendall(str(len(payload)).encode() + b":" + payload)
        while True:
            msg = self._recv()
            if msg[0] == 1 and msg[1] == self.msgid:
                if msg[2]:
                    raise MarionetteError(f"{name}: {msg[2]}")
                return msg[3]

    # Raccourcis
    def js(self, script, args=None, sandbox=None):
        params = {"script": script, "args": args or []}
        if sandbox:
            params["sandbox"] = sandbox
        return self.cmd("WebDriver:ExecuteScript", params).get("value")

    def navigate(self, url):
        self.cmd("WebDriver:Navigate", {"url": url})

    def handles(self):
        return self.cmd("WebDriver:GetWindowHandles")

    def handle(self):
        return self.cmd("WebDriver:GetWindowHandle").get("value")

    def switch(self, handle, focus=True):
        self.cmd("WebDriver:SwitchToWindow", {"handle": handle, "focus": focus})

    def new_tab(self):
        return self.cmd("WebDriver:NewWindow", {"type": "tab", "focus": False}).get("handle")


def launch(binary, profile_dir, port, prefs, headless=True, log_path=None):
    os.makedirs(profile_dir, exist_ok=True)
    with open(os.path.join(profile_dir, "user.js"), "w", encoding="utf-8") as f:
        for key, value in prefs.items():
            f.write(f"user_pref({json.dumps(key)}, {json.dumps(value)});\n")
    args = [binary, "-no-remote", "-profile", profile_dir, "-marionette", "-remote-allow-system-access"]
    if headless:
        args.append("-headless")
    env = dict(os.environ)
    env.update({"MOZ_CRASHREPORTER_DISABLE": "1", "MOZ_HEADLESS_WIDTH": "1440", "MOZ_HEADLESS_HEIGHT": "1000"})
    if headless:
        env["MOZ_HEADLESS"] = "1"
    log = open(log_path or os.devnull, "w")
    return subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, env=env)
