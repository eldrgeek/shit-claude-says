#!/usr/bin/env python3
"""
SCS Moderator — polls VPS for pending quotes, pops HUD for approval.
Run via pm2: pm2 start scs-moderator.py --name scs-moderator --interpreter /opt/homebrew/bin/python3
"""
import json, os, subprocess, time, urllib.request, urllib.error

API       = os.environ.get('SCS_API',       'https://vpsmikewolf.duckdns.org/api/scs')
MOD_TOKEN = os.environ.get('SCS_MOD_TOKEN', 'cdecddce0fa7d016b9e778e101d600cf')
CC        = ['/opt/homebrew/bin/python3', os.path.expanduser('~/Projects/mac-controller/cc.py')]
POLL_SECS = 30

def get(path):
    req = urllib.request.Request(f'{API}{path}',
          headers={'x-mod-token': MOD_TOKEN})
    try:
        r = urllib.request.urlopen(req, timeout=8)
        return json.loads(r.read())
    except Exception as e:
        print(f'  GET {path} failed: {e}')
        return None

def post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f'{API}{path}', data=data,
          headers={'Content-Type': 'application/json', 'x-mod-token': MOD_TOKEN},
          method='POST')
    try:
        urllib.request.urlopen(req, timeout=8)
        return True
    except Exception as e:
        print(f'  POST {path} failed: {e}')
        return False

def hud_ask(message):
    r = subprocess.run(CC + ['hud-ask', message, '--timeout', '120'],
                       capture_output=True, text=True)
    try:
        return json.loads(r.stdout).get('response', 'timeout')
    except Exception:
        return 'timeout'

print(f'SCS Moderator started. Polling {API} every {POLL_SECS}s...')

while True:
    quotes = get('/mod/pending')
    if quotes and isinstance(quotes, list) and len(quotes) > 0:
        print(f'  {len(quotes)} pending quote(s)')
        for q in quotes:
            setup = f'\nSetup: {q["prompt"][:100]}' if q.get('prompt') else ''
            tags  = ', '.join(q.get('tags') or [])
            tag_line = f'\nTags: {tags}' if tags else ''
            msg = f'Approve SCS quote?{setup}\nClaude: {q["response"][:200]}{tag_line}'

            result = hud_ask(msg)
            action = 'approve' if result == 'confirm' else 'reject'
            if post(f'/mod/{q["id"]}', {'action': action}):
                icon = '✅' if action == 'approve' else '❌'
                print(f'  {icon} {action.capitalize()}: {q["response"][:60]}...')
            else:
                print(f'  Failed to moderate {q["id"]}')

    time.sleep(POLL_SECS)
