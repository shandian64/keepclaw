#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path


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


IDLE_TIMEOUT_S = int(os.environ.get("IMAGEGEN_IDLE_TIMEOUT_S", "120"))


def resolve_path_env(name: str) -> Path | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    return Path(raw).expanduser().resolve()


WUYI_WORKSPACE = resolve_path_env("WUYI_WORKSPACE")
OUT_DIR = resolve_path_env("WUYI_IMAGEGEN_OUT_DIR")
if OUT_DIR is None and WUYI_WORKSPACE is not None:
    OUT_DIR = (WUYI_WORKSPACE / "outputs" / "imagegen").resolve()

TOOLS_ROOT = resolve_path_env("IMAGEGEN_TOOLS_ROOT")
if TOOLS_ROOT is None:
    shared_root = resolve_path_env("IMAGEGEN_SHARED_ROOT")
    if shared_root is not None:
        TOOLS_ROOT = (shared_root / "Tools").resolve()
SCRIPTS_ROOT = (TOOLS_ROOT / "aigc_flux1_schnell").resolve() if TOOLS_ROOT is not None else None


def die(msg: str, code: int = 2) -> None:
    print(f"[wuyi-imagegen] {msg}", file=sys.stderr)
    raise SystemExit(code)


def ensure_inside_workspace(raw: str, *, label: str) -> Path:
    if WUYI_WORKSPACE is None:
        die("WUYI_WORKSPACE 未配置")
    p = Path(raw).expanduser().resolve()
    try:
        p.relative_to(WUYI_WORKSPACE)
    except ValueError:
        die(f"{label} 必须位于乌衣工作区内: {WUYI_WORKSPACE}")
    if not p.is_file():
        die(f"缺少 {label}: {p}")
    return p


def ensure_file(path: Path, label: str) -> Path:
    path = path.expanduser().resolve()
    if not path.is_file():
        die(f"缺少 {label}: {path}")
    return path


def ensure_dir(path: Path, label: str) -> Path:
    path = path.expanduser().resolve()
    if not path.is_dir():
        die(f"缺少 {label}: {path}")
    return path


def require_configured_dir(path: Path | None, label: str, env_hint: str) -> Path:
    if path is None:
        die(f"{label} 未配置，请设置环境变量 {env_hint}")
    return ensure_dir(path, label)


def ensure_multiple_of_16(v: int, *, name: str) -> None:
    if v <= 0:
        die(f"{name} 必须是正整数")
    if v % 16 != 0:
        die(f"{name} 必须是 16 的倍数，当前: {v}")


def build_env(*, prompt: str, negative: str, width: int, height: int, steps: int, seed: int,
              sampler: str, guidance: float, cfg: float, prefix: str, require_gpu: bool,
              listen: str, port: int, start_server: bool, extra: dict[str, str]) -> dict[str, str]:
    env = dict(os.environ)
    conda_candidates = [
        Path.home() / "miniconda3" / "bin",
        Path.home() / "anaconda3" / "bin",
        Path("/opt/conda/bin"),
        Path("/usr/local/miniconda3/bin"),
    ]
    path_entries = [str(p) for p in conda_candidates if p.is_dir()]
    if path_entries:
        env["PATH"] = ":".join(path_entries + [env.get("PATH", "")])
    env.update({
        "PROMPT": prompt,
        "NEGATIVE": negative,
        "WIDTH": str(width),
        "HEIGHT": str(height),
        "STEPS": str(steps),
        "SEED": str(seed),
        "SAMPLER": sampler,
        "GUIDANCE": str(guidance),
        "CFG": str(cfg),
            "OUT_DIR": str(OUT_DIR),
        "PREFIX": prefix,
        "REQUIRE_GPU": "1" if require_gpu else "0",
        "LISTEN": listen,
        "PORT": str(port),
        "START_SERVER": "1" if start_server else "0",
        "COMFY_IDLE_TIMEOUT_S": str(IDLE_TIMEOUT_S),
    })
    env.update(extra)
    return env


def run_script(script: Path, *, env: dict[str, str]) -> None:
    subprocess.run(["bash", str(script)], env=env, check=True)


def pick_latest_image(out_dir: Path) -> Path:
    candidates = []
    for pattern in ("*.png", "*.jpg", "*.jpeg", "*.webp"):
        candidates.extend(out_dir.glob(pattern))
    if not candidates:
        die(f"输出目录中未找到图片文件: {out_dir}")
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0].resolve()


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="乌衣专用本地生图入口")
    sub = ap.add_subparsers(dest="mode", required=True)

    def add_common(sp: argparse.ArgumentParser, *, require_size: bool) -> None:
        sp.add_argument("--prompt", required=True, help="正向提示词")
        sp.add_argument("--negative", default="", help="反向提示词（可选）")
        if require_size:
            sp.add_argument("--width", type=int, default=1024)
            sp.add_argument("--height", type=int, default=1024)
        else:
            sp.add_argument("--width", type=int, default=0, help="0=从输入图自动推断")
            sp.add_argument("--height", type=int, default=0, help="0=从输入图自动推断")
        sp.add_argument("--steps", type=int, default=20)
        sp.add_argument("--seed", type=int, default=0)
        sp.add_argument("--sampler", default="euler")
        sp.add_argument("--guidance", type=float, default=3.5)
        sp.add_argument("--cfg", type=float, default=1.0)
        sp.add_argument("--prefix", default="", help="输出文件名前缀（可选）")
        sp.add_argument("--allow-cpu", action="store_true")
        sp.add_argument("--listen", default="127.0.0.1")
        sp.add_argument("--port", type=int, default=8188)
        sp.add_argument("--no-start-server", action="store_true")

    sp_txt2img = sub.add_parser("txt2img", help="文本生图")
    add_common(sp_txt2img, require_size=True)

    sp_img2img = sub.add_parser("img2img", help="图生图")
    sp_img2img.add_argument("--init-image", required=True, help="必须位于乌衣工作区内")
    sp_img2img.add_argument("--denoise", type=float, default=0.75)
    add_common(sp_img2img, require_size=False)

    sp_ref = sub.add_parser("reference", help="参考图引导")
    sp_ref.add_argument("--init-image", required=True, help="必须位于乌衣工作区内")
    sp_ref.add_argument("--ref-method", default="offset")
    add_common(sp_ref, require_size=False)

    args = ap.parse_args(argv)

    if OUT_DIR is None:
        die("输出目录未配置，请设置 WUYI_IMAGEGEN_OUT_DIR 或 WUYI_WORKSPACE")

    ensure_dir(require_configured_dir(TOOLS_ROOT, "共享 Tools 目录", "IMAGEGEN_TOOLS_ROOT 或 IMAGEGEN_SHARED_ROOT"), "共享 Tools 目录")
    ensure_dir(require_configured_dir(SCRIPTS_ROOT, "AIGC 工具目录", "IMAGEGEN_TOOLS_ROOT 或 IMAGEGEN_SHARED_ROOT"), "AIGC 工具目录")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    require_gpu = not bool(getattr(args, "allow_cpu", False))
    start_server = not bool(getattr(args, "no_start_server", False))
    prefix = args.prefix or f"wuyi_{args.mode}_{time.strftime('%Y%m%d_%H%M%S')}"
    negative = getattr(args, "negative", "") or ""
    sampler = getattr(args, "sampler", "euler") or "euler"

    if args.mode == "txt2img":
        ensure_multiple_of_16(int(args.width), name="width")
        ensure_multiple_of_16(int(args.height), name="height")
        script = ensure_file(SCRIPTS_ROOT / "skill_flux2_nvfp4.sh", "txt2img 脚本")
        env = build_env(
            prompt=str(args.prompt), negative=str(negative), width=int(args.width), height=int(args.height),
            steps=int(args.steps), seed=int(args.seed), sampler=str(sampler), guidance=float(args.guidance),
            cfg=float(args.cfg), prefix=prefix, require_gpu=require_gpu, listen=str(args.listen),
            port=int(args.port), start_server=start_server, extra={}
        )
        run_script(script, env=env)
        print(str(pick_latest_image(OUT_DIR)))
        return 0

    init_image = ensure_inside_workspace(str(args.init_image), label="init-image")
    if int(args.width) != 0:
        ensure_multiple_of_16(int(args.width), name="width")
    if int(args.height) != 0:
        ensure_multiple_of_16(int(args.height), name="height")

    common_kwargs = dict(
        prompt=str(args.prompt), negative=str(negative), width=int(args.width), height=int(args.height),
        steps=int(args.steps), seed=int(args.seed), sampler=str(sampler), guidance=float(args.guidance),
        cfg=float(args.cfg), prefix=prefix, require_gpu=require_gpu, listen=str(args.listen),
        port=int(args.port), start_server=start_server,
    )

    if args.mode == "img2img":
        script = ensure_file(SCRIPTS_ROOT / "skill_flux2_nvfp4_img2img.sh", "img2img 脚本")
        env = build_env(**common_kwargs, extra={"INIT_IMAGE": str(init_image), "DENOISE": str(float(args.denoise))})
        run_script(script, env=env)
        print(str(pick_latest_image(OUT_DIR)))
        return 0

    if args.mode == "reference":
        script = ensure_file(SCRIPTS_ROOT / "skill_flux2_nvfp4_reference.sh", "reference 脚本")
        env = build_env(**common_kwargs, extra={"INIT_IMAGE": str(init_image), "REF_METHOD": str(args.ref_method)})
        run_script(script, env=env)
        print(str(pick_latest_image(OUT_DIR)))
        return 0

    die(f"未知 mode: {args.mode}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
