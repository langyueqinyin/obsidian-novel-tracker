#!/bin/bash
# 把构建产物复制到 vault 的插件目录。
# 目标路径写在 .deploy-target 文件里（不入 git），内容为 vault 根目录的绝对路径。
set -e
if [ ! -f .deploy-target ]; then
  echo "缺少 .deploy-target 文件。创建它并写入你的 vault 绝对路径，例如："
  echo '  echo "/path/to/YourVault" > .deploy-target'
  exit 1
fi
VAULT="$(cat .deploy-target)"
DEST="$VAULT/.obsidian/plugins/novel-tracker"
mkdir -p "$DEST"
cp main.js manifest.json "$DEST/"
[ -f styles.css ] && cp styles.css "$DEST/"
echo "已部署到 $DEST"
