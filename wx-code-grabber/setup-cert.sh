#!/usr/bin/env bash
# 一次性: 把 mitmproxy 的根证书装入系统钥匙串并设为信任 (需要输入密码)。
# 只需执行一次。之后 run.sh 就能解密 HTTPS/WSS 流量。
set -uo pipefail

CERT="$HOME/.mitmproxy/mitmproxy-ca-cert.pem"

if [ ! -f "$CERT" ]; then
  echo "未找到证书 $CERT"
  echo "请先运行一次 mitmdump 生成证书:  /opt/homebrew/bin/mitmdump --version >/dev/null; (随后 Ctrl-C)"
  echo "或直接执行 ./run.sh 让它生成后再来跑本脚本。"
  exit 1
fi

echo "将信任 mitmproxy 根证书: $CERT"
echo "需要管理员密码..."
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$CERT"
echo "完成。已把 mitmproxy CA 设为系统信任。"
