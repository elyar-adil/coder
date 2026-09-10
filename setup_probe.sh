#!/bin/bash
cd "$(dirname "$0")"
mkdir -p /tmp/ghlog
cp cred.err setup_probe.txt 2>/dev/null || true
{ printf 'protocol=https\nhost=github.com\n\n'; sleep 2; } | git credential fill > /tmp/ghlog/cred.txt 2> /tmp/ghlog/cred.err
echo done
