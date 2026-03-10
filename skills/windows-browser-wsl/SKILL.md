---
name: windows-browser-wsl
description: Launch and control Windows Chrome or Edge from WSL via the Chrome DevTools Protocol. Use when OpenClaw is running inside WSL and needs deterministic browser automation on the Windows desktop, especially when the built-in browser tool cannot detect Windows browsers.
metadata:
  { "openclaw": { "emoji": "🪟", "os": ["linux"], "requires": { "bins": ["python3", "wslpath"] } } }
---

# Windows Browser Control from WSL

Use this skill when OpenClaw is inside WSL but the browser you need to automate is installed on Windows.

Prefer this skill over the built-in `browser` tool when:

- the built-in tool says no supported browser was found
- you need a repeatable CDP session on Windows Chrome or Edge
- you want a dedicated browser profile instead of touching the user's main browser session

Do not use this skill for simple page fetches. Use `web_fetch` for static content when a real browser is unnecessary.

## Script

Use the bundled helper:

```bash
python3 <openclaw-source>/skills/windows-browser-wsl/scripts/win_browser.py --help
```

The helper prints JSON to stdout so it is easy to inspect and script.

## Quick Start

Launch Chrome with a dedicated profile and open a page:

```bash
python3 <openclaw-source>/skills/windows-browser-wsl/scripts/win_browser.py \
  launch --browser chrome --port 9222 --url 'https://example.com'
```

On this WSL machine the helper defaults to:

- `--listen 0.0.0.0` for the Windows browser CDP listener
- `--host auto`, which resolves to the Windows host IP from the WSL default route
- `--portproxy auto`, which creates a Windows `netsh interface portproxy` rule and firewall opening for the chosen port when WSL cannot reach Windows `127.0.0.1`

List tabs on the debugging port:

```bash
python3 <openclaw-source>/skills/windows-browser-wsl/scripts/win_browser.py tabs --port 9222
```

Open a new tab:

```bash
python3 <openclaw-source>/skills/windows-browser-wsl/scripts/win_browser.py \
  open --port 9222 --url 'https://news.ycombinator.com'
```

Navigate the first page tab:

```bash
python3 <openclaw-source>/skills/windows-browser-wsl/scripts/win_browser.py \
  navigate --port 9222 --url 'https://openai.com'
```

Click and type:

```bash
python3 <openclaw-source>/skills/windows-browser-wsl/scripts/win_browser.py \
  click --port 9222 --selector 'button[type=submit]'

python3 <openclaw-source>/skills/windows-browser-wsl/scripts/win_browser.py \
  type --port 9222 --selector 'textarea' --text 'hello from wsl'
```

Capture a screenshot:

```bash
python3 <openclaw-source>/skills/windows-browser-wsl/scripts/win_browser.py \
  screenshot --port 9222 --output /tmp/browser.png
```

Run JavaScript:

```bash
python3 <openclaw-source>/skills/windows-browser-wsl/scripts/win_browser.py \
  eval --port 9222 --expression 'document.title'
```

## Target Selection

- By default the script uses the first `page` target on the port.
- Use `tabs` first if multiple tabs exist.
- Pass `--target-id` to pin a specific tab.
- Pass `--match` to pick the first tab whose URL or title contains a substring.

## Local Notes

- Default Windows executables can be overridden with `OPENCLAW_WINDOWS_CHROME_PATH` and `OPENCLAW_WINDOWS_EDGE_PATH`.
- The helper creates a dedicated profile under `OPENCLAW_WINDOWS_BROWSER_PROFILE_ROOT/<browser>-<port>` unless `--user-data-dir` is supplied.
- If you need stricter binding, override `--listen` and `--host` explicitly.
- On WSL2, the helper may add a Windows portproxy and firewall rule for the chosen debugging port so CDP is reachable from Linux.
- If Windows browser launching fails from a restricted sandbox, run the same command in a normal WSL shell. The CDP workflow remains the same.
