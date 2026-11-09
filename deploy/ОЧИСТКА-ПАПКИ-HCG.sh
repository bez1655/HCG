#!/usr/bin/env bash
exec "$(cd "$(dirname "$0")" && pwd)/cleanup-hcg-dir.sh" "$@"
