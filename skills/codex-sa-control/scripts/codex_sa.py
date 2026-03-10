#!/usr/bin/env python3
import argparse
import fcntl
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def load_local_env():
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


STATE_DIR = Path(
    os.environ.get("OPENCLAW_STATE_DIR")
    or os.environ.get("CLAWDBOT_STATE_DIR")
    or (Path.home() / ".openclaw")
).expanduser().resolve()
TARGET_NAMES = ("codex", "sa1", "sa2", "sa3", "sa4", "sa5")
CODEX_WORKSPACE = Path(
    os.environ.get("OPENCLAW_CODEX_WORKSPACE", str(STATE_DIR / "codex-workspace"))
).expanduser().resolve()
SA_ROOT_RAW = os.environ.get("OPENCLAW_CODEX_SA_ROOT", "").strip()
RUNTIME_DIR = Path(
    os.environ.get("OPENCLAW_CODEX_JOBS_RUNTIME_DIR", str(STATE_DIR / "runtime" / "codex-sa-control"))
).expanduser().resolve()

CODEX_BIN = "codex"
TRUST_BYPASS_FLAG = "--skip-git-repo-check"
JOBS_DIR = RUNTIME_DIR / "jobs"
INDEX_PATH = JOBS_DIR / "index.json"
LEDGER_PATH = RUNTIME_DIR / "last_sessions.json"
LOCK_PATH = RUNTIME_DIR / "state.lock"
STATUS_VALUES = ["queued", "running", "completed", "failed", "canceled"]
LIST_LIMIT_DEFAULT = 50
SOURCE_VALUES = ["helper", "external"]
MANAGEABILITY_VALUES = ["full", "cancel_only", "observe_only"]
NOTIFY_POLICY_VALUES = ["telegram-last", "last-chat", "none"]
DEFAULT_NOTIFY_POLICY = "telegram-last"
EXTERNAL_NOTIFY_POLICY = "none"
UUID_RE = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")


def build_targets():
    targets = {"codex": CODEX_WORKSPACE}
    if SA_ROOT_RAW:
        sa_root = Path(SA_ROOT_RAW).expanduser().resolve()
        for idx in range(1, 6):
            targets[f"sa{idx}"] = (sa_root / f"sa{idx}").resolve()
    return targets


def resolve_target_path(target_name):
    return build_targets().get(target_name)


def target_not_configured_error(target_name):
    if target_name == "codex":
        return "codex workspace is not configured"
    return f"{target_name} is not configured; set OPENCLAW_CODEX_SA_ROOT in the local environment"


def require_target_path(target_name):
    target_path = resolve_target_path(target_name)
    if target_path is None:
        raise ValueError(target_not_configured_error(target_name))
    return target_path


def emit(payload, exit_code=0):
    json.dump(payload, sys.stdout, ensure_ascii=True)
    sys.stdout.write("\n")
    sys.exit(exit_code)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_iso(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return datetime.fromtimestamp(0, tz=timezone.utc)


def iso_from_lstart(value):
    try:
        return datetime.strptime(value, "%a %b %d %H:%M:%S %Y").replace(tzinfo=timezone.utc).isoformat(
            timespec="seconds"
        ).replace("+00:00", "Z")
    except Exception:
        return now_iso()


def ensure_runtime():
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    if not INDEX_PATH.exists():
        write_json_atomic(INDEX_PATH, {"jobs": []})


@contextmanager
def state_lock():
    ensure_runtime()
    with LOCK_PATH.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return default


def write_json_atomic(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temp_path.replace(path)


def load_index():
    data = load_json(INDEX_PATH, {"jobs": []})
    if not isinstance(data, dict) or not isinstance(data.get("jobs"), list):
        return {"jobs": []}
    return data


def save_index(index):
    write_json_atomic(INDEX_PATH, index)


def load_ledger():
    data = load_json(LEDGER_PATH, {})
    return data if isinstance(data, dict) else {}


def save_ledger(ledger):
    write_json_atomic(LEDGER_PATH, ledger)


def clean_legacy_temp_files():
    if not RUNTIME_DIR.exists():
        return
    for path in RUNTIME_DIR.glob("codex_last_*"):
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def job_dir(job_id):
    return JOBS_DIR / job_id


def job_meta_path(job_id):
    return job_dir(job_id) / "meta.json"


def job_input_path(job_id):
    return job_dir(job_id) / "input.txt"


def job_stdout_path(job_id):
    return job_dir(job_id) / "stdout.jsonl"


def job_stderr_path(job_id):
    return job_dir(job_id) / "stderr.log"


def job_result_path(job_id):
    return job_dir(job_id) / "result.txt"


def job_last_message_path(job_id):
    return job_dir(job_id) / "last_message.txt"


def job_worker_log_path(job_id):
    return job_dir(job_id) / "worker.log"


def process_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def run_ps_rows():
    probe = subprocess.run(
        ["ps", "-eo", "pid=,ppid=,pgid=,etimes=,lstart=,args="],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        return []

    rows = []
    for raw in probe.stdout.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split(None, 9)
        if len(parts) < 10:
            continue
        pid, ppid, pgid, etimes = parts[:4]
        lstart = " ".join(parts[4:9])
        args = parts[9]
        try:
            rows.append(
                {
                    "pid": int(pid),
                    "ppid": int(ppid),
                    "pgid": int(pgid),
                    "etimes": int(etimes),
                    "lstart": lstart,
                    "args": args,
                }
            )
        except ValueError:
            continue
    return rows


def args_look_like_codex(args_text):
    try:
        tokens = shlex.split(args_text)
    except ValueError:
        return "codex" in (args_text or "")
    if not tokens:
        return False
    return any(token == "codex" or token.endswith("/codex") or token == "/usr/bin/codex" for token in tokens)


def representative_process(rows):
    for row in rows:
        if row["pid"] == row["pgid"]:
            return row
    return sorted(rows, key=lambda item: item["pid"])[0]


def parse_cd_from_args(args_text):
    try:
        tokens = shlex.split(args_text)
    except ValueError:
        return None
    for idx, token in enumerate(tokens):
        if token in {"--cd", "-C"} and idx + 1 < len(tokens):
            return tokens[idx + 1]
    return None


def parse_session_id(args_text):
    match = UUID_RE.search(args_text or "")
    return match.group(0) if match else None


def parse_action_from_args(args_text):
    lowered = (args_text or "").lower()
    if " review " in f" {lowered} ":
        return "review"
    if " resume " in f" {lowered} ":
        return "resume"
    if re.search(r"(^| )codex($| )", lowered) or " codex exec " in f" {lowered} ":
        return "run"
    return "run"


def git_repo_ok(target_path):
    probe = subprocess.run(
        ["git", "-C", str(target_path), "rev-parse", "--show-toplevel"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    return probe.returncode == 0


def read_text(path):
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return ""


def preview_text(text, limit=280):
    compact = " ".join(text.strip().split())
    if not compact:
        return None
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3] + "..."


def parse_jsonl_events(text):
    events = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events


def parse_jsonl_file(path):
    return parse_jsonl_events(read_text(path))


def thread_id_from_events(events):
    for event in events:
        if event.get("type") == "thread.started" and event.get("thread_id"):
            return event["thread_id"]
    return None


def last_agent_message(events):
    message = None
    for event in events:
        if event.get("type") != "item.completed":
            continue
        item = event.get("item") or {}
        if item.get("type") == "agent_message" and item.get("text"):
            message = item["text"]
    return message


def usage_from_events(events):
    for event in reversed(events):
        if event.get("type") == "turn.completed":
            return event.get("usage")
    return None


def compact_stderr(stderr_text):
    lines = [
        line.strip()
        for line in stderr_text.splitlines()
        if line.strip() and "Resolved gitdir path" not in line
    ]
    if not lines:
        return None
    if len(lines) <= 8:
        return lines
    return lines[:4] + ["..."] + lines[-3:]


def derive_error(stderr_text, last_message, exit_code):
    lines = [line.strip() for line in stderr_text.splitlines() if line.strip()]
    if lines:
        return lines[-1]
    if last_message:
        return last_message
    return f"codex exited with code {exit_code}"


def looks_like_user_decision(text):
    if not text or not text.strip():
        return False
    compact = " ".join(text.strip().split())
    lowered = compact.lower()
    direct_markers = [
        "do you want",
        "would you like",
        "which option",
        "which one",
        "please confirm",
        "please choose",
        "please decide",
        "need more information",
        "what would you like",
        "what should i",
        "how would you like",
        "should i proceed",
        "should i continue",
        "want me to",
        "choose one",
        "confirm whether",
        "请确认",
        "请选择",
        "请决定",
        "请告诉我",
        "你希望",
        "要不要",
        "是否需要",
        "需要你",
        "继续的话请",
    ]
    if any(marker in lowered for marker in direct_markers):
        return True

    if "?" not in compact and "？" not in compact:
        return False

    question_markers = [
        "which",
        "what",
        "how",
        "whether",
        "prefer",
        "option",
        "confirm",
        "continue",
        "proceed",
        "next step",
        "接下来",
        "下一步",
        "哪个",
        "哪一个",
        "怎么",
        "是否",
        "还是",
    ]
    return any(marker in lowered for marker in question_markers)


def load_job_meta(job_id):
    return load_json(job_meta_path(job_id), {})


def write_job_meta(meta):
    write_json_atomic(job_meta_path(meta["job_id"]), meta)


def job_summary(meta):
    return {
        "job_id": meta["job_id"],
        "source": meta.get("source", "helper"),
        "action": meta["action"],
        "target": meta["target"],
        "target_label": meta.get("target_label") or meta["target"],
        "cwd": meta.get("cwd"),
        "status": meta["status"],
        "manageability": meta.get("manageability", "full"),
        "mode": meta.get("mode"),
        "created_at": meta.get("created_at"),
        "started_at": meta.get("started_at"),
        "finished_at": meta.get("finished_at"),
        "session_id": meta.get("session_id"),
        "pid": meta.get("pid"),
        "pgid": meta.get("pgid"),
        "cancel_requested_at": meta.get("cancel_requested_at"),
        "prompt_preview": meta.get("prompt_preview"),
        "result_preview": meta.get("result_preview"),
        "error": meta.get("error"),
        "awaiting_user": bool(meta.get("awaiting_user")),
        "continuation_available": bool(meta.get("continuation_available")),
        "parent_job_id": meta.get("parent_job_id"),
        "notify_policy": ((meta.get("notification") or {}).get("policy") or DEFAULT_NOTIFY_POLICY),
    }


def upsert_index_job(index, meta):
    summary = job_summary(meta)
    jobs = index["jobs"]
    for idx, item in enumerate(jobs):
        if item.get("job_id") == meta["job_id"]:
            jobs[idx] = summary
            return
    jobs.append(summary)


def remove_index_job(index, job_id):
    index["jobs"] = [job for job in index["jobs"] if job.get("job_id") != job_id]


def persist_job(index, meta):
    write_job_meta(meta)
    upsert_index_job(index, meta)
    save_index(index)


def queued_jobs_for_target(index, target):
    jobs = [job for job in index["jobs"] if job.get("target") == target and job.get("status") == "queued"]
    jobs.sort(key=lambda item: (parse_iso(item.get("created_at", "")).timestamp(), item.get("job_id", "")))
    return jobs


def running_job_for_target(index, target):
    for job in index["jobs"]:
        if job.get("target") == target and job.get("status") == "running":
            return job
    return None


def maybe_start_next_job(index, target):
    if running_job_for_target(index, target):
        return None
    queued = queued_jobs_for_target(index, target)
    if not queued:
        return None

    next_job_id = queued[0]["job_id"]
    meta = load_job_meta(next_job_id)
    worker_log_handle = job_worker_log_path(next_job_id).open("ab")
    try:
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "worker", "--job-id", next_job_id],
            cwd=str(SKILL_DIR),
            stdin=subprocess.DEVNULL,
            stdout=worker_log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            close_fds=True,
        )
    finally:
        worker_log_handle.close()

    meta["status"] = "running"
    meta["started_at"] = meta.get("started_at") or now_iso()
    meta["pid"] = process.pid
    meta["pgid"] = process.pid
    persist_job(index, meta)
    return meta


def reverse_ledger_map():
    ledger = load_ledger()
    return {session_id: target for target, session_id in ledger.items() if session_id}


def external_job_id(row):
    started = parse_iso(iso_from_lstart(row["lstart"]))
    return f"external-{row['pgid']}-{started.strftime('%Y%m%d%H%M%S')}"


def summarize_external_target(target, cwd, session_id):
    if target and target in TARGET_NAMES:
        return target
    if cwd:
        return cwd
    if session_id:
        return f"session:{session_id[:8]}"
    return "external"


def build_external_meta(job_id, row, target, target_label, cwd, session_id, manageability):
    job_root = job_dir(job_id)
    job_root.mkdir(parents=True, exist_ok=True)
    started_at = iso_from_lstart(row["lstart"])
    meta = {
        "job_id": job_id,
        "source": "external",
        "action": parse_action_from_args(row["args"]),
        "target": target,
        "target_label": target_label,
        "cwd": cwd,
        "status": "running",
        "manageability": manageability,
        "mode": None,
        "created_at": started_at,
        "started_at": started_at,
        "finished_at": None,
        "session_id": session_id,
        "pid": row["pid"],
        "pgid": row["pgid"],
        "prompt_preview": preview_text(row["args"], 240),
        "result_preview": None,
        "error": None,
        "cancel_requested_at": None,
        "options": {"command": row["args"], "pid": row["pid"], "ppid": row["ppid"], "etimes": row["etimes"]},
        "submission": None,
        "delivery": None,
        "notification": {"policy": EXTERNAL_NOTIFY_POLICY},
        "awaiting_user": False,
        "continuation_available": False,
        "parent_job_id": None,
        "paths": {
            "job_dir": str(job_root),
            "meta": str(job_meta_path(job_id)),
            "input": None,
            "stdout": None,
            "stderr": None,
            "result": None,
            "last_message": None,
            "worker_log": None,
        },
    }
    write_job_meta(meta)
    return meta


def discover_external_jobs(index):
    running_helper_pgids = {
        job.get("pgid")
        for job in index["jobs"]
        if job.get("source", "helper") == "helper" and job.get("status") == "running" and job.get("pgid")
    }
    groups = {}
    for row in run_ps_rows():
        if not args_look_like_codex(row["args"]):
            continue
        if row["pgid"] in running_helper_pgids:
            continue
        groups.setdefault(row["pgid"], []).append(row)

    reverse_ledger = reverse_ledger_map()
    seen_job_ids = set()
    changed = False

    for pgid, rows in groups.items():
        leader = representative_process(rows)
        job_id = external_job_id(leader)
        seen_job_ids.add(job_id)
        session_id = None
        cwd = None
        for row in rows:
            session_id = session_id or parse_session_id(row["args"])
            cwd = cwd or parse_cd_from_args(row["args"])

        target = reverse_ledger.get(session_id)
        target_label = summarize_external_target(target, cwd, session_id)
        manageability = "cancel_only" if leader.get("pgid") else "observe_only"

        meta = load_job_meta(job_id)
        if not meta:
            meta = build_external_meta(job_id, leader, target or "external", target_label, cwd, session_id, manageability)
            upsert_index_job(index, meta)
            changed = True
            continue

        updated = False
        if meta.get("status") != "running":
            meta["status"] = "running"
            meta["finished_at"] = None
            updated = True
        new_values = {
            "action": parse_action_from_args(leader["args"]),
            "target": target or "external",
            "target_label": target_label,
            "cwd": cwd,
            "session_id": session_id or meta.get("session_id"),
            "pid": leader["pid"],
            "pgid": leader["pgid"],
            "manageability": manageability,
        }
        for key, value in new_values.items():
            if value is not None and meta.get(key) != value:
                meta[key] = value
                updated = True
        notification = meta.get("notification") or {}
        if notification.get("policy") != EXTERNAL_NOTIFY_POLICY:
            meta["notification"] = {"policy": EXTERNAL_NOTIFY_POLICY}
            updated = True
        options = meta.get("options") or {}
        if options.get("command") != leader["args"] or options.get("etimes") != leader["etimes"]:
            options.update({"command": leader["args"], "pid": leader["pid"], "ppid": leader["ppid"], "etimes": leader["etimes"]})
            meta["options"] = options
            updated = True
        if updated:
            persist_job(index, meta)
            changed = True

    for summary in list(index["jobs"]):
        if summary.get("source") != "external" or summary.get("status") != "running":
            continue
        if summary.get("job_id") in seen_job_ids:
            continue
        meta = load_job_meta(summary["job_id"])
        meta["finished_at"] = meta.get("finished_at") or now_iso()
        meta.pop("pid", None)
        meta.pop("pgid", None)
        meta["awaiting_user"] = False
        meta["continuation_available"] = False
        if meta.get("cancel_requested_at"):
            meta["status"] = "canceled"
            meta["error"] = meta.get("error") or "canceled by user"
        else:
            meta["status"] = "completed"
            meta["result_preview"] = meta.get("result_preview") or "external codex process exited"
        persist_job(index, meta)
        changed = True

    return changed


def reconcile_state(index):
    changed = False
    clean_legacy_temp_files()

    for summary in list(index["jobs"]):
        if summary.get("status") != "running":
            continue
        pid = summary.get("pid")
        if process_alive(pid):
            continue

        meta = load_job_meta(summary["job_id"])
        if meta.get("status") != "running":
            upsert_index_job(index, meta)
            changed = True
            continue

        meta["finished_at"] = meta.get("finished_at") or now_iso()
        meta.pop("pid", None)
        meta.pop("pgid", None)
        if meta.get("cancel_requested_at"):
            meta["status"] = "canceled"
            meta["error"] = meta.get("error") or "canceled while worker was stopping"
        else:
            meta["status"] = "failed"
            meta["error"] = meta.get("error") or "worker process is not running"
        persist_job(index, meta)
        changed = True

    if discover_external_jobs(index):
        changed = True

    for target in sorted(TARGET_NAMES):
        if not running_job_for_target(index, target) and queued_jobs_for_target(index, target):
            maybe_start_next_job(index, target)
            changed = True

    if changed:
        save_index(index)


def add_target_arg(parser):
    parser.add_argument("--target", choices=sorted(TARGET_NAMES), required=True)


def add_prompt_args(parser, required):
    parser.add_argument("--prompt", help="Inline prompt text.")
    parser.add_argument("--prompt-file", help="Read prompt text from a file. Use - to read stdin.")
    parser.set_defaults(prompt_required=required)


def add_notify_args(parser):
    parser.add_argument(
        "--notify-policy",
        choices=NOTIFY_POLICY_VALUES,
        default=DEFAULT_NOTIFY_POLICY,
        help="Notification routing policy when no explicit route is attached.",
    )
    parser.add_argument("--notify-channel", help="Explicit notification channel.")
    parser.add_argument("--notify-target", help="Explicit notification target.")
    parser.add_argument("--notify-account", help="Explicit notification account.")
    parser.add_argument("--notify-thread-id", help="Explicit notification thread id.")


def add_origin_args(parser):
    parser.add_argument("--agent-id", help=argparse.SUPPRESS)
    parser.add_argument("--session-key", help=argparse.SUPPRESS)
    parser.add_argument("--origin-session-id", help=argparse.SUPPRESS)
    parser.add_argument("--message-channel", help=argparse.SUPPRESS)
    parser.add_argument("--agent-account-id", help=argparse.SUPPRESS)
    parser.add_argument("--requester-sender-id", help=argparse.SUPPRESS)
    parser.add_argument("--delivery-channel", help=argparse.SUPPRESS)
    parser.add_argument("--delivery-target", help=argparse.SUPPRESS)
    parser.add_argument("--delivery-account", help=argparse.SUPPRESS)
    parser.add_argument("--delivery-thread-id", help=argparse.SUPPRESS)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Dispatch work to the dedicated Codex workspace or to explicitly named sa1-sa5 workspaces with background jobs."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("targets", help="List the fixed target map.")

    status = subparsers.add_parser("status", help="Show target status and queue state.")
    add_target_arg(status)

    run = subparsers.add_parser("run", help="Submit a background Codex exec job.")
    add_target_arg(run)
    run.add_argument("--mode", choices=["ephemeral", "persistent"], default="ephemeral")
    add_prompt_args(run, required=True)
    add_notify_args(run)
    add_origin_args(run)

    review = subparsers.add_parser("review", help="Submit a background Codex review job.")
    add_target_arg(review)
    review.add_argument("--uncommitted", action="store_true")
    review.add_argument("--base")
    review.add_argument("--commit")
    review.add_argument("--title")
    add_prompt_args(review, required=False)
    add_notify_args(review)
    add_origin_args(review)

    resume = subparsers.add_parser("resume", help="Submit a background Codex resume job.")
    add_target_arg(resume)
    resume.add_argument("--mode", choices=["persistent", "ephemeral"], default="persistent")
    resume_group = resume.add_mutually_exclusive_group(required=True)
    resume_group.add_argument("--last", action="store_true")
    resume_group.add_argument("--session-id")
    add_prompt_args(resume, required=False)
    add_notify_args(resume)
    add_origin_args(resume)

    answer = subparsers.add_parser("answer", help="Continue a prior job with new user input.")
    answer.add_argument("--job-id", required=True)
    answer.add_argument("--mode", choices=["persistent", "ephemeral"], default="persistent")
    add_prompt_args(answer, required=True)
    add_notify_args(answer)
    add_origin_args(answer)

    jobs = subparsers.add_parser("jobs", help="Inspect, cancel, and clear background jobs.")
    job_subparsers = jobs.add_subparsers(dest="jobs_command", required=True)

    jobs_list = job_subparsers.add_parser("list", help="List jobs across all targets.")
    jobs_list.add_argument("--target")
    jobs_list.add_argument("--status", choices=STATUS_VALUES)
    jobs_list.add_argument("--source", choices=SOURCE_VALUES)
    jobs_list.add_argument("--manageable", choices=MANAGEABILITY_VALUES)
    jobs_list.add_argument("--limit", type=int, default=LIST_LIMIT_DEFAULT)

    jobs_show = job_subparsers.add_parser("show", help="Show details for one job.")
    jobs_show.add_argument("--job-id", required=True)

    jobs_cancel = job_subparsers.add_parser("cancel", help="Cancel a queued or running job.")
    jobs_cancel.add_argument("--job-id", required=True)

    jobs_clear = job_subparsers.add_parser("clear", help="Delete finished job history.")
    clear_group = jobs_clear.add_mutually_exclusive_group(required=True)
    clear_group.add_argument("--job-id")
    clear_group.add_argument("--finished", action="store_true")

    worker = subparsers.add_parser("worker", help=argparse.SUPPRESS)
    worker.add_argument("--job-id", required=True)

    return parser.parse_args()


def resolve_prompt(args):
    if args.prompt is not None and args.prompt_file is not None:
        raise ValueError("Use only one of --prompt or --prompt-file.")

    prompt = None
    if args.prompt is not None:
        prompt = args.prompt
    elif args.prompt_file is not None:
        if args.prompt_file == "-":
            prompt = sys.stdin.read()
        else:
            prompt = Path(args.prompt_file).read_text(encoding="utf-8")
    elif getattr(args, "prompt_required", False):
        raise ValueError("A prompt is required. Use --prompt or --prompt-file.")

    if prompt is not None and not prompt.strip():
        raise ValueError("Prompt cannot be empty.")
    return prompt


def target_payload(target_name, index=None, ledger=None):
    target_path = resolve_target_path(target_name)
    if index is None:
        index = load_index()
    if ledger is None:
        ledger = load_ledger()

    queued = queued_jobs_for_target(index, target_name)
    running = running_job_for_target(index, target_name)
    configured = target_path is not None
    config_path = target_path / ".codex" / "config.toml" if target_path else None
    return {
        "target": target_name,
        "configured": configured,
        "cwd": str(target_path) if target_path else None,
        "exists": bool(target_path and target_path.is_dir()),
        "codex_config": str(config_path) if config_path else None,
        "config_exists": bool(config_path and config_path.is_file()),
        "is_git_repo": git_repo_ok(target_path) if target_path else False,
        "review_supported": target_name == "sa1",
        "configuration_error": None if configured else target_not_configured_error(target_name),
        "last_session_id": ledger.get(target_name),
        "running_job_id": running.get("job_id") if running else None,
        "queue_depth": len(queued),
        "default_run_mode": "ephemeral",
        "default_resume_mode": "persistent",
    }


def submission_context_from_args(args):
    submission = {
        "agent_id": getattr(args, "agent_id", None),
        "session_key": getattr(args, "session_key", None),
        "session_id": getattr(args, "origin_session_id", None),
        "message_channel": getattr(args, "message_channel", None),
        "agent_account_id": getattr(args, "agent_account_id", None),
        "requester_sender_id": getattr(args, "requester_sender_id", None),
    }
    delivery = {
        "channel": getattr(args, "delivery_channel", None) or getattr(args, "notify_channel", None),
        "target": getattr(args, "delivery_target", None) or getattr(args, "notify_target", None),
        "account_id": getattr(args, "delivery_account", None) or getattr(args, "notify_account", None),
        "thread_id": getattr(args, "delivery_thread_id", None) or getattr(args, "notify_thread_id", None),
    }
    notification = {"policy": getattr(args, "notify_policy", DEFAULT_NOTIFY_POLICY)}
    submission = {key: value for key, value in submission.items() if value not in (None, "")}
    delivery = {key: value for key, value in delivery.items() if value not in (None, "")}
    if delivery:
        notification["explicit_route"] = True
    return submission or None, delivery or None, notification


def build_job_meta(
    action,
    target,
    prompt_text,
    *,
    mode=None,
    options=None,
    session_id=None,
    submission=None,
    delivery=None,
    notification=None,
    parent_job_id=None,
    source="helper",
    manageability="full",
    target_label=None,
    job_id=None,
):
    job_id = job_id or uuid.uuid4().hex
    job_root = job_dir(job_id)
    job_root.mkdir(parents=True, exist_ok=True)
    target_path = require_target_path(target)

    if prompt_text is not None:
        job_input_path(job_id).write_text(prompt_text, encoding="utf-8")

    meta = {
        "job_id": job_id,
        "source": source,
        "action": action,
        "target": target,
        "target_label": target_label or target,
        "cwd": str(target_path),
        "status": "queued",
        "manageability": manageability,
        "mode": mode,
        "created_at": now_iso(),
        "started_at": None,
        "finished_at": None,
        "session_id": session_id,
        "pid": None,
        "pgid": None,
        "prompt_preview": preview_text(prompt_text, 240),
        "result_preview": None,
        "error": None,
        "cancel_requested_at": None,
        "options": options or {},
        "submission": submission,
        "delivery": delivery,
        "notification": notification or {"policy": DEFAULT_NOTIFY_POLICY},
        "awaiting_user": False,
        "continuation_available": bool(session_id),
        "parent_job_id": parent_job_id,
        "paths": {
            "job_dir": str(job_root),
            "meta": str(job_meta_path(job_id)),
            "input": str(job_input_path(job_id)) if prompt_text is not None else None,
            "stdout": str(job_stdout_path(job_id)),
            "stderr": str(job_stderr_path(job_id)),
            "result": str(job_result_path(job_id)),
            "last_message": str(job_last_message_path(job_id)),
            "worker_log": str(job_worker_log_path(job_id)),
        },
    }
    write_job_meta(meta)
    return meta


def queued_position(index, job_id, target):
    queued = queued_jobs_for_target(index, target)
    for idx, item in enumerate(queued, start=1):
        if item.get("job_id") == job_id:
            return idx
    return None


def submit_job(
    action,
    target,
    prompt_text,
    *,
    mode=None,
    options=None,
    session_id=None,
    submission=None,
    delivery=None,
    notification=None,
    parent_job_id=None,
):
    with state_lock():
        index = load_index()
        reconcile_state(index)
        meta = build_job_meta(
            action,
            target,
            prompt_text,
            mode=mode,
            options=options,
            session_id=session_id,
            submission=submission,
            delivery=delivery,
            notification=notification,
            parent_job_id=parent_job_id,
        )
        upsert_index_job(index, meta)
        save_index(index)

        if not running_job_for_target(index, target):
            meta = maybe_start_next_job(index, target) or meta
            status = meta["status"]
            queue_position = 0 if status == "running" else queued_position(index, meta["job_id"], target)
        else:
            status = "queued"
            queue_position = queued_position(index, meta["job_id"], target)

    return {
        "ok": True,
        "action": action,
        "source": meta.get("source", "helper"),
        "target": target,
        "job_id": meta["job_id"],
        "status": status,
        "queue_position": queue_position,
        "notify_policy": ((meta.get("notification") or {}).get("policy") or DEFAULT_NOTIFY_POLICY),
    }


def build_codex_command(meta, prompt_text):
    action = meta["action"]
    if action == "run":
        command = [
            CODEX_BIN,
            "exec",
            "--json",
            TRUST_BYPASS_FLAG,
            "--output-last-message",
            str(job_last_message_path(meta["job_id"])),
        ]
        if meta.get("mode") == "ephemeral":
            command.append("--ephemeral")
    elif action == "resume":
        command = [
            CODEX_BIN,
            "exec",
            "resume",
            "--json",
            TRUST_BYPASS_FLAG,
            "--output-last-message",
            str(job_last_message_path(meta["job_id"])),
        ]
        if meta.get("mode") == "ephemeral":
            command.append("--ephemeral")
        command.append(meta["session_id"])
    elif action == "review":
        command = [
            CODEX_BIN,
            "exec",
            "review",
            "--json",
            TRUST_BYPASS_FLAG,
            "--ephemeral",
            "--output-last-message",
            str(job_last_message_path(meta["job_id"])),
        ]
        options = meta.get("options") or {}
        if options.get("uncommitted"):
            command.append("--uncommitted")
        if options.get("base"):
            command.extend(["--base", options["base"]])
        if options.get("commit"):
            command.extend(["--commit", options["commit"]])
        if options.get("title"):
            command.extend(["--title", options["title"]])
    else:
        raise ValueError(f"Unsupported job action: {action}")

    if prompt_text is not None:
        command.append("-")
    return command


def finalize_job(job_id, returncode):
    stdout_path = job_stdout_path(job_id)
    stderr_path = job_stderr_path(job_id)
    last_message_path = job_last_message_path(job_id)
    result_path = job_result_path(job_id)

    stdout_text = read_text(stdout_path)
    stderr_text = read_text(stderr_path)
    events = parse_jsonl_events(stdout_text)
    last_message = read_text(last_message_path).strip() or last_agent_message(events)
    if last_message:
        result_path.write_text(last_message, encoding="utf-8")

    session_id = thread_id_from_events(events)
    usage = usage_from_events(events)
    stderr_excerpt = compact_stderr(stderr_text)

    with state_lock():
        index = load_index()
        meta = load_job_meta(job_id)
        meta["exit_code"] = returncode
        meta["finished_at"] = now_iso()
        meta.pop("pid", None)
        meta.pop("pgid", None)
        if session_id:
            meta["session_id"] = session_id
        if usage:
            meta["usage"] = usage
        if last_message:
            meta["result_preview"] = preview_text(last_message, 360)
        if stderr_excerpt:
            meta["stderr_excerpt"] = stderr_excerpt
        meta["continuation_available"] = bool(meta.get("session_id"))

        if meta.get("cancel_requested_at"):
            meta["status"] = "canceled"
            meta["error"] = meta.get("error") or "canceled by user"
            meta["awaiting_user"] = False
        elif returncode == 0:
            meta["status"] = "completed"
            meta["error"] = None
            meta["awaiting_user"] = bool(meta.get("continuation_available") and looks_like_user_decision(last_message))
        else:
            meta["status"] = "failed"
            meta["error"] = derive_error(stderr_text, last_message, returncode)
            meta["awaiting_user"] = False

        persist_job(index, meta)

        if meta["status"] == "completed" and meta.get("mode") == "persistent" and meta.get("session_id"):
            ledger = load_ledger()
            ledger[meta["target"]] = meta["session_id"]
            save_ledger(ledger)

        maybe_start_next_job(index, meta["target"])


def handle_worker(args):
    meta = load_job_meta(args.job_id)
    if not meta:
        return
    if meta.get("status") != "running":
        return

    prompt_text = read_text(job_input_path(args.job_id)) if job_input_path(args.job_id).exists() else None
    command = build_codex_command(meta, prompt_text)

    with job_stdout_path(args.job_id).open("w", encoding="utf-8") as stdout_handle, job_stderr_path(args.job_id).open(
        "w", encoding="utf-8"
    ) as stderr_handle:
        completed = subprocess.run(
            command,
            cwd=meta["cwd"],
            input=prompt_text,
            stdout=stdout_handle,
            stderr=stderr_handle,
            text=True,
            check=False,
        )

    finalize_job(args.job_id, completed.returncode)


def handle_targets():
    with state_lock():
        index = load_index()
        reconcile_state(index)
        ledger = load_ledger()
        payload = {
            "ok": True,
            "targets": [target_payload(name, index=index, ledger=ledger) for name in sorted(TARGET_NAMES)],
        }
    emit(payload)


def handle_status(args):
    with state_lock():
        index = load_index()
        reconcile_state(index)
        ledger = load_ledger()
        payload = {"ok": True, **target_payload(args.target, index=index, ledger=ledger)}
    emit(payload)


def ensure_submit_target(target_name, action):
    target_path = resolve_target_path(target_name)
    if target_path is None:
        emit(
            {
                "ok": False,
                "action": action,
                "target": target_name,
                "error": target_not_configured_error(target_name),
            },
            exit_code=2,
        )
    return target_path


def handle_run(args):
    ensure_submit_target(args.target, "run")
    prompt_text = resolve_prompt(args)
    submission, delivery, notification = submission_context_from_args(args)
    payload = submit_job(
        "run",
        args.target,
        prompt_text,
        mode=args.mode,
        submission=submission,
        delivery=delivery,
        notification=notification,
    )
    emit(payload)


def handle_resume(args):
    ensure_submit_target(args.target, "resume")
    prompt_text = resolve_prompt(args)
    submission, delivery, notification = submission_context_from_args(args)
    with state_lock():
        if args.last:
            session_id = load_ledger().get(args.target)
            if not session_id:
                emit(
                    {
                        "ok": False,
                        "action": "resume",
                        "target": args.target,
                        "error": f"no recorded persistent session for {args.target}",
                    },
                    exit_code=1,
                )
        else:
            session_id = args.session_id

    payload = submit_job(
        "resume",
        args.target,
        prompt_text,
        mode=args.mode,
        session_id=session_id,
        submission=submission,
        delivery=delivery,
        notification=notification,
    )
    emit(payload)


def handle_review(args):
    if args.target != "sa1":
        emit(
            {
                "ok": False,
                "action": "review",
                "target": args.target,
                "error": "review is supported only for sa1",
            },
            exit_code=2,
        )
    ensure_submit_target(args.target, "review")

    prompt_text = resolve_prompt(args)
    submission, delivery, notification = submission_context_from_args(args)
    options = {
        "uncommitted": bool(args.uncommitted),
        "base": args.base,
        "commit": args.commit,
        "title": args.title,
    }
    payload = submit_job(
        "review",
        args.target,
        prompt_text,
        mode="ephemeral",
        options=options,
        submission=submission,
        delivery=delivery,
        notification=notification,
    )
    emit(payload)


def handle_answer(args):
    prompt_text = resolve_prompt(args)
    submission, delivery, notification = submission_context_from_args(args)
    with state_lock():
        index = load_index()
        reconcile_state(index)
        meta = load_job_meta(args.job_id)
        if not meta:
            emit({"ok": False, "action": "answer", "error": f"unknown job_id: {args.job_id}"}, exit_code=1)
        if meta.get("source") != "helper" or meta.get("manageability") != "full":
            emit(
                {
                    "ok": False,
                    "action": "answer",
                    "job_id": args.job_id,
                    "error": "only helper-managed jobs can be continued with answer",
                },
                exit_code=1,
            )
        if meta.get("status") in {"queued", "running"}:
            emit(
                {
                    "ok": False,
                    "action": "answer",
                    "job_id": args.job_id,
                    "error": f"job {args.job_id} is still {meta.get('status')}",
                },
                exit_code=1,
            )
        session_id = meta.get("session_id")
        if not session_id:
            emit(
                {
                    "ok": False,
                    "action": "answer",
                    "job_id": args.job_id,
                    "error": "job has no resumable session_id",
                },
                exit_code=1,
            )

    payload = submit_job(
        "resume",
        meta["target"],
        prompt_text,
        mode=args.mode,
        session_id=session_id,
        submission=submission,
        delivery=delivery,
        notification=notification,
        parent_job_id=args.job_id,
    )
    payload["continued_job_id"] = args.job_id
    emit(payload)


def status_priority(status):
    priorities = {
        "running": 0,
        "queued": 1,
        "failed": 2,
        "completed": 3,
        "canceled": 4,
    }
    return priorities.get(status, 99)


def handle_jobs_list(args):
    with state_lock():
        index = load_index()
        reconcile_state(index)
        jobs = list(index["jobs"])

    if args.target:
        jobs = [job for job in jobs if job.get("target") == args.target]
    if args.status:
        jobs = [job for job in jobs if job.get("status") == args.status]
    if args.source:
        jobs = [job for job in jobs if job.get("source", "helper") == args.source]
    if args.manageable:
        jobs = [job for job in jobs if job.get("manageability", "full") == args.manageable]

    jobs.sort(key=lambda item: parse_iso(item.get("created_at", "")), reverse=True)
    jobs.sort(key=lambda item: status_priority(item.get("status")))

    queue_positions = {}
    queued_by_target = {}
    for job in jobs:
        if job.get("status") != "queued":
            continue
        queued_by_target.setdefault(job["target"], [])
        queued_by_target[job["target"]].append(job["job_id"])
    for target, job_ids in queued_by_target.items():
        for idx, job_id in enumerate(reversed(job_ids), start=1):
            queue_positions[job_id] = len(job_ids) - idx + 1

    shaped_jobs = []
    for job in jobs[: args.limit]:
        shaped = dict(job)
        if job.get("status") == "queued":
            shaped["queue_position"] = queue_positions.get(job["job_id"])
        shaped_jobs.append(shaped)

    counts = {status: 0 for status in STATUS_VALUES}
    for job in jobs:
        status = job.get("status")
        if status in counts:
            counts[status] += 1

    emit(
        {
            "ok": True,
            "counts": counts,
            "returned": len(shaped_jobs),
            "total": len(jobs),
            "jobs": shaped_jobs,
        }
    )


def handle_jobs_show(args):
    with state_lock():
        index = load_index()
        reconcile_state(index)
        meta = load_job_meta(args.job_id)

    if not meta:
        emit({"ok": False, "error": f"unknown job_id: {args.job_id}"}, exit_code=1)

    emit(
        {
            "ok": True,
            "job": meta,
            "continuation_available": bool(meta.get("continuation_available")),
            "result_excerpt": read_text(job_result_path(args.job_id))[:4000] or None,
            "stderr_excerpt": read_text(job_stderr_path(args.job_id))[-4000:] or None,
        }
    )


def handle_jobs_cancel(args):
    with state_lock():
        index = load_index()
        reconcile_state(index)
        meta = load_job_meta(args.job_id)
        if not meta:
            emit({"ok": False, "error": f"unknown job_id: {args.job_id}"}, exit_code=1)

        if meta["status"] == "queued":
            meta["status"] = "canceled"
            meta["finished_at"] = now_iso()
            meta["error"] = "canceled before start"
            persist_job(index, meta)
            emit({"ok": True, "job_id": args.job_id, "status": "canceled"})

        if meta["status"] != "running":
            emit(
                {
                    "ok": False,
                    "job_id": args.job_id,
                    "error": f"cannot cancel job in status {meta['status']}",
                },
                exit_code=1,
            )

        if meta.get("source") == "external" and meta.get("manageability") == "observe_only":
            emit(
                {
                    "ok": False,
                    "job_id": args.job_id,
                    "error": "external observe-only job cannot be canceled",
                },
                exit_code=1,
            )

        pgid = meta.get("pgid") or meta.get("pid")
        if pgid:
            try:
                os.killpg(pgid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        meta["cancel_requested_at"] = now_iso()
        meta["error"] = meta.get("error") or "cancel requested"
        persist_job(index, meta)

    emit({"ok": True, "job_id": args.job_id, "status": "running", "cancel_requested": True})


def remove_job_artifacts(job_id):
    shutil.rmtree(job_dir(job_id), ignore_errors=True)


def handle_jobs_clear(args):
    with state_lock():
        index = load_index()
        reconcile_state(index)

        if args.job_id:
            meta = load_job_meta(args.job_id)
            if not meta:
                emit({"ok": False, "error": f"unknown job_id: {args.job_id}"}, exit_code=1)
            if meta.get("status") in {"queued", "running"}:
                emit(
                    {
                        "ok": False,
                        "error": f"cannot clear active job in status {meta['status']}",
                    },
                    exit_code=1,
                )
            remove_index_job(index, args.job_id)
            save_index(index)
            remove_job_artifacts(args.job_id)
            emit({"ok": True, "cleared": [args.job_id]})

        cleared = []
        for summary in list(index["jobs"]):
            if summary.get("status") in {"completed", "failed", "canceled"}:
                cleared.append(summary["job_id"])
                remove_index_job(index, summary["job_id"])
        save_index(index)
        for job_id in cleared:
            remove_job_artifacts(job_id)
        emit({"ok": True, "cleared": cleared, "count": len(cleared)})


def main():
    args = parse_args()
    try:
        if args.command == "worker":
            handle_worker(args)
            return
        if args.command == "targets":
            handle_targets()
        elif args.command == "status":
            handle_status(args)
        elif args.command == "run":
            handle_run(args)
        elif args.command == "resume":
            handle_resume(args)
        elif args.command == "answer":
            handle_answer(args)
        elif args.command == "review":
            handle_review(args)
        elif args.command == "jobs":
            if args.jobs_command == "list":
                handle_jobs_list(args)
            elif args.jobs_command == "show":
                handle_jobs_show(args)
            elif args.jobs_command == "cancel":
                handle_jobs_cancel(args)
            elif args.jobs_command == "clear":
                handle_jobs_clear(args)
            else:
                raise ValueError(f"Unsupported jobs subcommand: {args.jobs_command}")
        else:
            raise ValueError(f"Unsupported command: {args.command}")
    except Exception as exc:
        emit({"ok": False, "error": str(exc)}, exit_code=1)


if __name__ == "__main__":
    main()
