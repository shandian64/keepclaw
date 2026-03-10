---
name: imagegen
description: >-
  本机 AIGC 生图/改图统一入口。复用 `IMAGEGEN_TOOLS_ROOT` 或 `IMAGEGEN_SHARED_ROOT` 指定的 ComfyUI + FLUX.2-dev-NVFP4 工作流，支持 txt2img、img2img、reference 三种模式。用户要求生成图片、改图、参考图出图、sprite/icon 变体、换背景等，并且机器上已有本地 FLUX/ComfyUI 环境时使用。
---

# ImageGen

把现有 `sa_final` 项目里的本地生图能力迁成当前 OpenClaw 可用的本机技能。

## 目标

- 不走在线图像接口。
- 复用现成环境：`IMAGEGEN_TOOLS_ROOT/aigc_flux1_schnell`
- 默认后端：ComfyUI + `FLUX.2-dev-NVFP4`
- 支持三种模式：
  - `txt2img`
  - `img2img`
  - `reference`

## 前置条件

以下路径需要通过本地环境变量提供并存在：

- `IMAGEGEN_TOOLS_ROOT` 或 `IMAGEGEN_SHARED_ROOT`
- 其中的脚本：
  - `skill_flux2_nvfp4.sh`
  - `skill_flux2_nvfp4_img2img.sh`
  - `skill_flux2_nvfp4_reference.sh`

如果缺失，不要猜，先检查路径或让用户确认。

## 入口脚本

使用本 skill 自带脚本：

```bash
python3 <openclaw-source>/skills/imagegen/scripts/image_gen.py --help
```

## 用法

### 1. 文本生图

```bash
python3 <openclaw-source>/skills/imagegen/scripts/image_gen.py txt2img \
  --prompt "a quiet countryside landscape, cinematic, detailed" \
  --width 1024 --height 576 \
  --steps 20 --seed 1
```

### 2. 图生图

```bash
python3 <openclaw-source>/skills/imagegen/scripts/image_gen.py img2img \
  --init-image "/abs/path/to/input.png" \
  --prompt "turn it into a clean game icon, flat shading" \
  --denoise 0.7 --steps 20 --seed 1
```

### 3. 参考图引导

```bash
python3 <openclaw-source>/skills/imagegen/scripts/image_gen.py reference \
  --init-image "/abs/path/to/ref.png" \
  --prompt "generate a matching icon in the same style" \
  --ref-method offset \
  --steps 20 --seed 1
```

## 输出

- 默认输出目录：`IMAGEGEN_OUT_DIR`，如果未设置则使用 `IMAGEGEN_SHARED_ROOT/_patches/imagegen`
- 可用 `--out-dir` 覆盖
- 可用 `--prefix` 控制输出文件名前缀

## 行为约束

- 默认要求 GPU；只有明确需要时才加 `--allow-cpu`
- 默认允许脚本自动拉起 ComfyUI；如果已知服务在跑，可加 `--no-start-server`
- 默认空闲 `120` 秒后触发 ComfyUI idle unload；可用环境变量 `IMAGEGEN_IDLE_TIMEOUT_S` 覆盖
- 宽高必须是 16 的倍数；`img2img/reference` 传 `0` 时表示从输入图自动推断
- 生成产物默认当作外部资源，不自动提交到 git，除非用户明确要求

## 迁移说明

这个 skill 是从 `sa_final` 项目级 `.codex/skills/imagegen` 迁过来的 OpenClaw 本机版。
当前 skill 只做一件事：把 OpenClaw 引到你已经存在的本地 FLUX/ComfyUI 工具链上。
