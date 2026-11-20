#!/usr/bin/env python3
"""Provision an ordinary, rule-checked machine session; never distribute minting authority."""
import json, pathlib, urllib.request, os
root=pathlib.Path('/var/lib/ansuz-recordings/auth')
token=(root/'service-token').read_text().strip()
principal='operator:ansuz-recorder'
req=urllib.request.Request('http://127.0.0.1:4431/auth/session',data=json.dumps({'principal':principal,'kind':'account','days':30}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},method='POST')
with urllib.request.urlopen(req,timeout=15) as response: session=json.load(response)['session']
assert session['principal']==principal
path=root/'recorder-agent.json'
os.umask(0o077)
path.write_text(json.dumps({'origin':'https://ansuz.jera.ink','mode':'operator-session','session':session},indent=2)+'\n')
path.chmod(0o600)
print('Issued an ordinary recorder-agent session; file remains private on the server.')
