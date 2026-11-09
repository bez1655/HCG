#!/usr/bin/env bash
exec "$(cd "$(dirname "$0")" && pwd)/1-server.sh" "$@"
