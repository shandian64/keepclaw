#!/usr/bin/env python3
"""Control Windows Chrome/Edge from WSL via Chrome DevTools Protocol."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import os
from pathlib import Path
from typing import Any

import websockets


def load_local_env() -> None:
    state_dir = Path(
        os.environ.get("OPENCLAW_STATE_DIR")
        or os.environ.get("CLAWDBOT_STATE_DIR")
        or (Path.home() / ".openclaw")
    ).expanduser()
    env_path = Path(os.environ.get("OPENCLAW_LOCAL_ENV", str(state_dir / "local.env"))).expanduser()
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = value


load_local_env()


def configured_candidates(env_name: str) -> list[Path]:
    raw = os.environ.get(env_name, "").strip()
    return [Path(raw).expanduser()] if raw else []


BROWSER_PATHS = {
    "chrome": [
        *configured_candidates("OPENCLAW_WINDOWS_CHROME_PATH"),
        Path("/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"),
    ],
    "edge": [
        *configured_candidates("OPENCLAW_WINDOWS_EDGE_PATH"),
        Path("/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"),
        Path("/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe"),
    ],
}

DEFAULT_PROFILE_ROOT = Path(
    os.environ.get("OPENCLAW_WINDOWS_BROWSER_PROFILE_ROOT", str(Path.home() / ".openclaw" / "browser-profiles"))
).expanduser()


def json_out(payload: Any) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


def fail(message: str, *, details: Any | None = None, exit_code: int = 1) -> None:
    payload: dict[str, Any] = {"ok": False, "error": message}
    if details is not None:
        payload["details"] = details
    json_out(payload)
    raise SystemExit(exit_code)


def detect_windows_host() -> str:
    route = subprocess.run(
        ["ip", "route", "show", "default"],
        check=False,
        capture_output=True,
        text=True,
    )
    if route.returncode == 0:
        parts = route.stdout.strip().split()
        if "via" in parts:
            return parts[parts.index("via") + 1]

    resolv_conf = Path("/etc/resolv.conf")
    if resolv_conf.exists():
        for line in resolv_conf.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("nameserver "):
                return line.split()[1].strip()
    return "127.0.0.1"


def resolve_debug_host(host: str, listen: str | None = None) -> str:
    if host != "auto":
        return host
    if listen and listen not in {"0.0.0.0", "::"}:
        return "127.0.0.1"
    return detect_windows_host()


def ensure_portproxy(host: str, port: int) -> dict[str, Any]:
    delete_cmd = [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        f"netsh interface portproxy delete v4tov4 listenaddress={host} listenport={port}",
    ]
    add_cmd = [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        (
            "netsh interface portproxy add v4tov4 "
            f"listenaddress={host} listenport={port} "
            f"connectaddress=127.0.0.1 connectport={port}"
        ),
    ]
    firewall_name = f"OpenClaw Windows Browser CDP {port}"
    firewall_cmd = [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        (
            "netsh advfirewall firewall add rule "
            f'name="{firewall_name}" dir=in action=allow protocol=TCP localport={port}'
        ),
    ]

    subprocess.run(delete_cmd, check=False, capture_output=True, text=True)
    add_proc = subprocess.run(add_cmd, check=False, capture_output=True, text=True)
    firewall_proc = subprocess.run(firewall_cmd, check=False, capture_output=True, text=True)

    if add_proc.returncode != 0:
        fail(
            "Failed to create a Windows portproxy for the browser debugging port",
            details={
                "host": host,
                "port": port,
                "stdout": add_proc.stdout.strip(),
                "stderr": add_proc.stderr.strip(),
            },
        )

    return {
        "host": host,
        "port": port,
        "firewallRule": firewall_name,
        "firewallReturnCode": firewall_proc.returncode,
    }


def http_request(
    host: str,
    port: int,
    path: str,
    *,
    method: str = "GET",
    timeout: float = 10.0,
) -> Any:
    url = f"http://{host}:{port}{path}"
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
        if not data:
            return None
        return json.loads(data.decode("utf-8"))


def wait_for_debugger(host: str, port: int, timeout: float) -> dict[str, Any]:
    deadline = time.time() + timeout
    last_error: str | None = None
    while time.time() < deadline:
        try:
            data = http_request(host, port, "/json/version", timeout=1.0)
            if isinstance(data, dict):
                return data
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            time.sleep(0.25)
    fail(
        f"Timed out waiting for a browser on {host}:{port}",
        details={"lastError": last_error},
    )


def resolve_browser_path(browser: str) -> tuple[str, Path]:
    if browser == "auto":
        for candidate in ("chrome", "edge"):
            try:
                return resolve_browser_path(candidate)
            except SystemExit:
                continue
        fail("No supported Windows browser executable was found")

    for candidate in BROWSER_PATHS.get(browser, []):
        if candidate.exists():
            return browser, candidate

    fail(
        f"Browser executable not found for {browser}",
        details={"checked": [str(p) for p in BROWSER_PATHS.get(browser, [])]},
    )


def to_windows_path(raw: str) -> str:
    if raw.startswith("\\\\"):
        return raw
    if len(raw) > 2 and raw[1] == ":":
        return raw

    proc = subprocess.run(
        ["wslpath", "-w", raw],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        fail("Failed to convert path with wslpath", details=proc.stderr.strip())
    return proc.stdout.strip()


def list_targets(host: str, port: int) -> list[dict[str, Any]]:
    data = http_request(host, port, "/json/list")
    if not isinstance(data, list):
        fail("Unexpected response from /json/list", details=data)
    return data


def open_target(host: str, port: int, url: str) -> dict[str, Any]:
    query = urllib.parse.quote(url, safe=":/?&=%#")
    path = f"/json/new?{query}"
    try:
        data = http_request(host, port, path, method="PUT")
    except urllib.error.HTTPError as exc:
        if exc.code != 405:
            raise
        data = http_request(host, port, path, method="GET")
    if not isinstance(data, dict):
        fail("Unexpected response from /json/new", details=data)
    return data


def choose_target(
    host: str,
    port: int,
    *,
    target_id: str | None = None,
    match: str | None = None,
    create_if_missing: bool = False,
) -> dict[str, Any]:
    targets = [target for target in list_targets(host, port) if target.get("type") == "page"]
    if target_id:
        for target in targets:
            if target.get("id") == target_id:
                return target
        fail(f"No page target found for id {target_id}")

    if match:
        needle = match.lower()
        for target in targets:
            hay = f"{target.get('title', '')} {target.get('url', '')}".lower()
            if needle in hay:
                return target
        fail(f"No page target matched {match!r}")

    if targets:
        return targets[0]

    if create_if_missing:
        return open_target(host, port, "about:blank")

    fail(f"No page targets found on {host}:{port}")


class CDPClient:
    def __init__(self, ws_url: str):
        self.ws_url = ws_url
        self.websocket: websockets.WebSocketClientProtocol | None = None
        self.next_id = 1
        self.events: list[dict[str, Any]] = []

    async def __aenter__(self) -> "CDPClient":
        self.websocket = await websockets.connect(self.ws_url, max_size=None)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self.websocket is not None:
            await self.websocket.close()

    async def command(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if self.websocket is None:
            raise RuntimeError("CDP websocket is not connected")
        message_id = self.next_id
        self.next_id += 1
        await self.websocket.send(
            json.dumps({"id": message_id, "method": method, "params": params or {}})
        )
        while True:
            raw = await self.websocket.recv()
            message = json.loads(raw)
            if message.get("id") == message_id:
                if "error" in message:
                    raise RuntimeError(
                        f"{method} failed: {message['error'].get('message', 'unknown error')}"
                    )
                return message.get("result", {})
            self.events.append(message)


async def wait_for_ready(client: CDPClient, timeout: float) -> str:
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = await client.command(
            "Runtime.evaluate",
            {"expression": "document.readyState", "returnByValue": True},
        )
        value = result.get("result", {}).get("value")
        if isinstance(value, str):
            if value == "complete":
                return value
            if value == "interactive":
                return value
        await asyncio.sleep(0.2)
    return "timeout"


async def evaluate(
    client: CDPClient,
    expression: str,
    *,
    await_promise: bool = True,
) -> Any:
    result = await client.command(
        "Runtime.evaluate",
        {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": await_promise,
        },
    )
    if "exceptionDetails" in result:
        details = result["exceptionDetails"]
        text = details.get("text", "JavaScript evaluation failed")
        raise RuntimeError(text)

    remote = result.get("result", {})
    if "value" in remote:
        return remote["value"]
    return {
        "type": remote.get("type"),
        "subtype": remote.get("subtype"),
        "description": remote.get("description"),
    }


def selector_probe_expression(selector: str) -> str:
    quoted = json.dumps(selector)
    return f"""
(() => {{
  const el = document.querySelector({quoted});
  if (!el) {{
    return {{ok: false, error: "selector not found"}};
  }}
  el.scrollIntoView({{block: "center", inline: "center"}});
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) {{
    return {{ok: false, error: "element has zero size"}};
  }}
  el.focus();
  return {{
    ok: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  }};
}})()
""".strip()


async def selector_box(client: CDPClient, selector: str) -> dict[str, float]:
    result = await evaluate(client, selector_probe_expression(selector))
    if not isinstance(result, dict) or not result.get("ok"):
        fail("Selector lookup failed", details=result)
    return result


async def mouse_click(client: CDPClient, x: float, y: float) -> None:
    await client.command(
        "Input.dispatchMouseEvent",
        {"type": "mouseMoved", "x": x, "y": y, "button": "none"},
    )
    await client.command(
        "Input.dispatchMouseEvent",
        {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1},
    )
    await client.command(
        "Input.dispatchMouseEvent",
        {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1},
    )


async def clear_active_element(client: CDPClient) -> None:
    expression = """
(() => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) {
    el.textContent = "";
  } else if ("value" in el) {
    el.value = "";
  } else {
    return false;
  }
  el.dispatchEvent(new Event("input", {bubbles: true}));
  el.dispatchEvent(new Event("change", {bubbles: true}));
  return true;
})()
""".strip()
    await evaluate(client, expression)


async def session_for_args(args: argparse.Namespace, *, create_if_missing: bool = False) -> tuple[CDPClient, dict[str, Any]]:
    host = resolve_debug_host(args.host)
    target = choose_target(
        host,
        args.port,
        target_id=getattr(args, "target_id", None),
        match=getattr(args, "match", None),
        create_if_missing=create_if_missing,
    )
    client = CDPClient(target["webSocketDebuggerUrl"])
    return client, target


async def handle_navigate(args: argparse.Namespace) -> None:
    client, target = await session_for_args(args, create_if_missing=True)
    async with client:
        await client.command("Page.enable")
        await client.command("Runtime.enable")
        await client.command("Page.navigate", {"url": args.url})
        ready = await wait_for_ready(client, args.timeout)
    json_out({"ok": True, "targetId": target["id"], "url": args.url, "readyState": ready})


async def handle_eval(args: argparse.Namespace) -> None:
    client, target = await session_for_args(args, create_if_missing=True)
    async with client:
        await client.command("Runtime.enable")
        value = await evaluate(client, args.expression)
    json_out({"ok": True, "targetId": target["id"], "value": value})


async def handle_click(args: argparse.Namespace) -> None:
    client, target = await session_for_args(args, create_if_missing=True)
    async with client:
        await client.command("Page.enable")
        await client.command("Runtime.enable")
        box = await selector_box(client, args.selector)
        await mouse_click(client, box["x"], box["y"])
        if args.wait > 0:
            await asyncio.sleep(args.wait)
    json_out({"ok": True, "targetId": target["id"], "selector": args.selector})


async def handle_type(args: argparse.Namespace) -> None:
    client, target = await session_for_args(args, create_if_missing=True)
    async with client:
        await client.command("Page.enable")
        await client.command("Runtime.enable")
        box = await selector_box(client, args.selector)
        await mouse_click(client, box["x"], box["y"])
        if args.clear:
            await clear_active_element(client)
        await client.command("Input.insertText", {"text": args.text})
        if args.wait > 0:
            await asyncio.sleep(args.wait)
    json_out({"ok": True, "targetId": target["id"], "selector": args.selector, "chars": len(args.text)})


async def handle_screenshot(args: argparse.Namespace) -> None:
    client, target = await session_for_args(args, create_if_missing=True)
    async with client:
        await client.command("Page.enable")
        await client.command("Runtime.enable")
        await wait_for_ready(client, args.timeout)
        params: dict[str, Any] = {
            "format": args.format,
            "captureBeyondViewport": True,
            "fromSurface": True,
        }
        if args.selector:
            box = await selector_box(client, args.selector)
            params["clip"] = {
                "x": box["left"],
                "y": box["top"],
                "width": box["width"],
                "height": box["height"],
                "scale": 1,
            }
        result = await client.command("Page.captureScreenshot", params)
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(base64.b64decode(result["data"]))
    json_out({"ok": True, "targetId": target["id"], "output": str(output)})


def command_launch(args: argparse.Namespace) -> None:
    browser_name, browser_path = resolve_browser_path(args.browser)
    profile_root = Path(args.user_data_dir).expanduser() if args.user_data_dir else DEFAULT_PROFILE_ROOT / f"{browser_name}-{args.port}"
    profile_root.mkdir(parents=True, exist_ok=True)
    profile_path = to_windows_path(str(profile_root))
    debug_host = resolve_debug_host(args.host, args.listen)

    command = [
        str(browser_path),
        f"--remote-debugging-port={args.port}",
        f"--remote-debugging-address={args.listen}",
        f"--user-data-dir={profile_path}",
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
    ]
    if args.headless:
        command.append("--headless=new")
    if args.url:
        command.append(args.url)

    try:
        subprocess.Popen(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except PermissionError as exc:
        fail(
            "Launching the Windows browser was denied in this shell",
            details={
                "command": command,
                "hint": "Run the same command in a normal WSL shell if this environment is sandboxed.",
                "reason": str(exc),
            },
        )

    proxy = None
    if args.portproxy == "on" or (args.portproxy == "auto" and debug_host != "127.0.0.1"):
        proxy = ensure_portproxy(debug_host, args.port)

    version = wait_for_debugger(debug_host, args.port, args.timeout)
    json_out(
        {
            "ok": True,
            "browser": browser_name,
            "host": debug_host,
            "listen": args.listen,
            "port": args.port,
            "profileDir": str(profile_root),
            "browserPath": str(browser_path),
            "portproxy": proxy,
            "version": version,
        }
    )


def command_status(args: argparse.Namespace) -> None:
    host = resolve_debug_host(args.host)
    version = http_request(host, args.port, "/json/version")
    json_out({"ok": True, "host": host, "port": args.port, "version": version})


def command_tabs(args: argparse.Namespace) -> None:
    host = resolve_debug_host(args.host)
    tabs = [
        {
            "id": target.get("id"),
            "type": target.get("type"),
            "title": target.get("title"),
            "url": target.get("url"),
            "attached": target.get("attached"),
        }
        for target in list_targets(host, args.port)
    ]
    json_out({"ok": True, "host": host, "port": args.port, "targets": tabs})


def command_open(args: argparse.Namespace) -> None:
    host = resolve_debug_host(args.host)
    target = open_target(host, args.port, args.url)
    json_out(
        {
            "ok": True,
            "host": host,
            "port": args.port,
            "targetId": target.get("id"),
            "title": target.get("title"),
            "url": target.get("url"),
        }
    )


def add_port(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--port", type=int, default=9222, help="Chrome DevTools port")
    parser.add_argument("--host", default="auto", help='Debugging host. Use "auto" to detect the Windows host IP from WSL.')


def add_target_args(parser: argparse.ArgumentParser) -> None:
    add_port(parser)
    parser.add_argument("--target-id", help="Specific page target id from the tabs command")
    parser.add_argument("--match", help="Pick the first page target whose title or URL contains this string")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    launch = subparsers.add_parser("launch", help="Launch Windows Chrome or Edge with remote debugging enabled")
    launch.add_argument("--browser", choices=["auto", "chrome", "edge"], default="auto")
    launch.add_argument("--port", type=int, default=9222)
    launch.add_argument("--host", default="auto", help='Host to probe after launch. "auto" detects the Windows host IP from WSL.')
    launch.add_argument("--listen", default="0.0.0.0", help="Address for the Windows browser to bind its debugging port to")
    launch.add_argument("--portproxy", choices=["auto", "on", "off"], default="auto", help="Create a Windows portproxy so WSL can reach the browser debugging port")
    launch.add_argument("--url", default="about:blank")
    launch.add_argument("--user-data-dir", help="Browser profile directory. Linux paths are converted with wslpath.")
    launch.add_argument("--timeout", type=float, default=20.0)
    launch.add_argument("--headless", action="store_true")
    launch.set_defaults(func=command_launch)

    status = subparsers.add_parser("status", help="Read the remote debugging version endpoint")
    add_port(status)
    status.set_defaults(func=command_status)

    tabs = subparsers.add_parser("tabs", help="List current debugging targets")
    add_port(tabs)
    tabs.set_defaults(func=command_tabs)

    open_cmd = subparsers.add_parser("open", help="Open a new page target")
    add_port(open_cmd)
    open_cmd.add_argument("--url", required=True)
    open_cmd.set_defaults(func=command_open)

    navigate = subparsers.add_parser("navigate", help="Navigate an existing page target")
    add_target_args(navigate)
    navigate.add_argument("--url", required=True)
    navigate.add_argument("--timeout", type=float, default=15.0)
    navigate.set_defaults(func=lambda args: asyncio.run(handle_navigate(args)))

    eval_cmd = subparsers.add_parser("eval", help="Evaluate JavaScript in a page target")
    add_target_args(eval_cmd)
    eval_cmd.add_argument("--expression", required=True)
    eval_cmd.set_defaults(func=lambda args: asyncio.run(handle_eval(args)))

    click = subparsers.add_parser("click", help="Click an element by CSS selector")
    add_target_args(click)
    click.add_argument("--selector", required=True)
    click.add_argument("--wait", type=float, default=0.5)
    click.set_defaults(func=lambda args: asyncio.run(handle_click(args)))

    type_cmd = subparsers.add_parser("type", help="Focus an element and insert text")
    add_target_args(type_cmd)
    type_cmd.add_argument("--selector", required=True)
    type_cmd.add_argument("--text", required=True)
    type_cmd.add_argument("--clear", action="store_true", help="Clear the focused element before typing")
    type_cmd.add_argument("--wait", type=float, default=0.5)
    type_cmd.set_defaults(func=lambda args: asyncio.run(handle_type(args)))

    screenshot = subparsers.add_parser("screenshot", help="Capture a screenshot of the current page or selector")
    add_target_args(screenshot)
    screenshot.add_argument("--output", required=True)
    screenshot.add_argument("--selector", help="Optional CSS selector to crop before capture")
    screenshot.add_argument("--format", choices=["png", "jpeg", "webp"], default="png")
    screenshot.add_argument("--timeout", type=float, default=15.0)
    screenshot.set_defaults(func=lambda args: asyncio.run(handle_screenshot(args)))

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except urllib.error.URLError as exc:
        fail("Browser debugging endpoint is unavailable", details=str(exc))
    except RuntimeError as exc:
        fail(str(exc))


if __name__ == "__main__":
    main()
