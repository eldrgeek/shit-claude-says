#!/bin/bash
# scs-moderator.sh — Run on Mac to moderate pending quotes via HUD
# Usage: ./scs-moderator.sh
# Set SCS_API and SCS_MOD_TOKEN env vars first

SCS_API="${SCS_API:-https://vpsmikewolf.duckdns.org/api/scs}"
MOD_TOKEN="${SCS_MOD_TOKEN:-change-me-in-production}"
CC="/opt/homebrew/bin/python3 $HOME/Projects/mac-controller/cc.py"

echo "SCS Moderator running. Polling for pending quotes..."

while true; do
  pending=$(curl -s -H "x-mod-token: $MOD_TOKEN" "$SCS_API/mod/pending")
  count=$(echo "$pending" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)

  if [ "$count" -gt 0 ] 2>/dev/null; then
    echo "$pending" | python3 - <<'PYEOF'
import sys, json, subprocess, os

quotes = json.load(sys.stdin)
api = os.environ.get('SCS_API', 'https://vpsmikewolf.duckdns.org/api/scs')
token = os.environ.get('SCS_MOD_TOKEN', 'change-me-in-production')
cc = ['/opt/homebrew/bin/python3', os.path.expanduser('~/Projects/mac-controller/cc.py')]

for q in quotes:
    setup = f"\nSetup: {q['prompt'][:100]}" if q.get('prompt') else ""
    msg = f"Approve SCS quote?{setup}\nClaude: {q['response'][:200]}"
    r = subprocess.run(cc + ['hud-ask', msg, '--timeout', '60'],
                       capture_output=True, text=True)
    result = 'timeout'
    try:
        result = __import__('json').loads(r.stdout).get('response', 'timeout')
    except Exception: pass

    action = 'approve' if result == 'confirm' else 'reject'
    import urllib.request, urllib.error
    req = urllib.request.Request(
        f"{api}/mod/{q['id']}",
        data=__import__('json').dumps({'action': action}).encode(),
        headers={'Content-Type': 'application/json', 'x-mod-token': token},
        method='POST'
    )
    try:
        urllib.request.urlopen(req, timeout=5)
        print(f"  {'✅ Approved' if action=='approve' else '❌ Rejected'}: {q['response'][:60]}...")
    except Exception as e:
        print(f"  Error posting moderation: {e}")
PYEOF
  fi

  sleep 30
done
