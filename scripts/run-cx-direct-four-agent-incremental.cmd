@echo off
cd /d C:\code\TagContactBridgeParalell
"C:\Program Files\nodejs\node.exe" scripts\cx-direct-four-agent-feeder.js --mode incremental --domain WYNN --per-agent 1000 --batch-size 250 --max-scan 10000 --apply >> logs\cx-direct-four-agent-feeder.log 2>&1
