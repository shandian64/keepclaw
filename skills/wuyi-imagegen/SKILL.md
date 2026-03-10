---
name: wuyi-imagegen
description: >-
  乌衣专用的本地生图技能。使用本机 FLUX/ComfyUI 工具链完成 txt2img、img2img、reference 三类任务，并且强制把输出写到 `WUYI_IMAGEGEN_OUT_DIR` 或 `WUYI_WORKSPACE/outputs/imagegen`。仅当 agent 是“乌衣”且用户明确要求生成图片、改图、参考图出图、角色图、封面图、插画或其他本地生图任务时使用；图生图和参考图只接受乌衣工作区内的输入图片。
---

# Wuyi Imagegen

使用乌衣专用脚本：

```bash
python3 <openclaw-source>/skills/wuyi-imagegen/scripts/wuyi_imagegen.py --help
```

## 规则

- 只为乌衣使用这个技能。
- 始终把输出写到：`WUYI_IMAGEGEN_OUT_DIR`，如果未设置则使用 `WUYI_WORKSPACE/outputs/imagegen`
- `img2img` / `reference` 的 `--init-image` 必须位于：`WUYI_WORKSPACE`
- 不要把结果写到共享目录、主工作区或其他 agent 工作区。
- 默认要求 GPU；只有用户明确要求时才加 `--allow-cpu`

## 用法

### 文本生图

```bash
python3 <openclaw-source>/skills/wuyi-imagegen/scripts/wuyi_imagegen.py txt2img \
  --prompt "a cinematic portrait" \
  --width 1024 --height 1024 \
  --steps 20 --seed 1
```

### 图生图

```bash
python3 <openclaw-source>/skills/wuyi-imagegen/scripts/wuyi_imagegen.py img2img \
  --init-image "<WUYI_WORKSPACE>/input.png" \
  --prompt "turn it into a polished game icon" \
  --denoise 0.7 --steps 20 --seed 1
```

### 参考图引导

```bash
python3 <openclaw-source>/skills/wuyi-imagegen/scripts/wuyi_imagegen.py reference \
  --init-image "<WUYI_WORKSPACE>/ref.png" \
  --prompt "generate a matching portrait in the same style" \
  --ref-method offset --steps 20 --seed 1
```

## 输出处理

- 成功后脚本会输出**最终图片文件路径**。
- 当用户明确要图片结果本身时，优先使用 `message` 工具把该图片直接发回当前 Telegram 聊天，然后回复 `NO_REPLY`。
- 在 Telegram 中绝对不要输出 `<qqimg>`、`<qqfile>` 或其他非 Telegram 富媒体标签；那不算真实发送。
- 只有在 `message` 工具真实发送成功后，才能表述为“已发送到 Telegram”。
- 如果没有实际执行消息/媒体发送工具并确认成功，只能说“已生成并保存在某路径”，不能说“已发送到 Telegram”。
- 生成产物默认不提交 git，除非用户明确要求。

## Telegram 发送

如果当前对话就是 Telegram 私聊，且用户要的是图片本身：

- 使用 `message` 工具
- `action=send`
- `channel=telegram`
- `accountId=wuyi`
- `target` 使用当前聊天 id
- `filePath` 使用脚本返回的最终图片文件路径
- `message` 可留一句简短说明

发送成功后，只回复：

```text
NO_REPLY
```
