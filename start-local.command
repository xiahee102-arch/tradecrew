#!/bin/bash
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
 echo "请先安装 Node.js 22.13 或更新版本：https://nodejs.org/"
 read -r -p "按回车关闭…"
 exit 1
fi
if [ ! -d node_modules ]; then
 npm ci --cache .local/npm-cache --no-audit --no-fund || exit 1
fi
npm run local
read -r -p "按回车关闭…"
