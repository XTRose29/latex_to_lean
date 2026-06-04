#!/usr/bin/env python3
from __future__ import annotations

import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FRONTEND = ROOT / "frontend"
HOST = "127.0.0.1"
DEFAULT_API_PORT = 8000
DEFAULT_WEB_PORT = 5173


def main() -> int:
    if not (FRONTEND / "package.json").exists():
        print("ERROR: frontend/package.json not found.")
        return 1
    if shutil.which("npm") is None:
        print("ERROR: npm is not installed. Install Node.js, then rerun: python3 run.py")
        return 1

    _ensure_frontend_deps()

    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("LATEX_TO_LEAN_EFFICIENT_LLM", "true")
    (ROOT / "backend" / "data").mkdir(parents=True, exist_ok=True)

    api_port = _choose_port(DEFAULT_API_PORT)
    web_port = _choose_port(DEFAULT_WEB_PORT, reserved={api_port})
    api_url = f"http://{HOST}:{api_port}"
    web_url = f"http://{HOST}:{web_port}"
    env["VITE_API_TARGET"] = api_url

    if api_port != DEFAULT_API_PORT:
        print(f"Port {DEFAULT_API_PORT} is busy; using API port {api_port}.")
    if web_port != DEFAULT_WEB_PORT:
        print(f"Port {DEFAULT_WEB_PORT} is busy; using web port {web_port}.")

    procs: list[subprocess.Popen] = []
    try:
        api = _start(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "backend.main:app",
                "--host",
                HOST,
                "--port",
                str(api_port),
                "--no-access-log",
            ],
            cwd=ROOT,
            env=env,
            name="api",
        )
        procs.append(api)

        if not _wait_for_port(HOST, api_port, api, "FastAPI"):
            return 1

        web = _start(
            ["npm", "run", "dev", "--", "--host", HOST, "--port", str(web_port)],
            cwd=FRONTEND,
            env=env,
            name="web",
        )
        procs.append(web)

        if not _wait_for_port(HOST, web_port, web, "Vite"):
            return 1

        print("")
        print(f"Local web app: {web_url}")
        print(f"Backend API:   {api_url}")
        print("Press Ctrl+C to stop both servers.")
        print("")
        webbrowser.open(web_url)

        while all(proc.poll() is None for proc in procs):
            time.sleep(0.5)
        for proc in procs:
            if proc.poll() is not None and proc.returncode:
                print(f"ERROR: a server exited with code {proc.returncode}.")
                return proc.returncode
        return 0
    except KeyboardInterrupt:
        print("\nStopping local web app...")
        return 0
    finally:
        _stop_all(procs)


def _ensure_frontend_deps() -> None:
    if (FRONTEND / "node_modules").exists():
        return
    print("Installing frontend dependencies with npm install...")
    subprocess.check_call(["npm", "install"], cwd=FRONTEND)


def _start(cmd: list[str], cwd: Path, env: dict[str, str], name: str) -> subprocess.Popen:
    print(f"Starting {name}: {' '.join(cmd)}")
    return subprocess.Popen(cmd, cwd=cwd, env=env)


def _choose_port(preferred: int, reserved: set[int] | None = None) -> int:
    reserved = reserved or set()
    for port in range(preferred, preferred + 100):
        if port in reserved:
            continue
        if _port_available(HOST, port):
            return port
    raise RuntimeError(f"No available port found near {preferred}.")


def _port_available(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex((host, port)) != 0


def _wait_for_port(host: str, port: int, proc: subprocess.Popen, label: str) -> bool:
    deadline = time.time() + 45
    while time.time() < deadline:
        if proc.poll() is not None:
            print(f"ERROR: {label} exited before it was ready.")
            if label == "FastAPI":
                print("Run this if dependencies are missing: python3 -m pip install -r requirements.txt")
            return False
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            if sock.connect_ex((host, port)) == 0:
                return True
        time.sleep(0.5)
    print(f"ERROR: timed out waiting for {label} on {host}:{port}.")
    return False


def _stop_all(procs: list[subprocess.Popen]) -> None:
    for proc in procs:
        if proc.poll() is None:
            proc.send_signal(signal.SIGTERM)
    for proc in procs:
        if proc.poll() is None:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
