#!/bin/bash
# supervisor에 플러그인 리로드 요청
SUP_SOCK="${HOME}/.easyclaude/sup/.supervisor.sock"
if [ ! -S "$SUP_SOCK" ]; then
  echo "supervisor socket not found: $SUP_SOCK" >&2
  exit 1
fi
echo '{"op":"reload-plugins"}' | nc -U "$SUP_SOCK"
echo "reload-plugins sent"
