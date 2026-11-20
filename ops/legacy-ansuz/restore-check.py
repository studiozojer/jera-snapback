#!/usr/bin/env python3
"""Read an authenticated synthetic trace from a disposable restored deployment."""
import hashlib, json, os, pathlib, shutil, subprocess, tempfile, time, urllib.request
BASE=pathlib.Path('/var/lib/ansuz-recordings')
CLI='/opt/ansuz-recordings/node_modules/.bin/snapback4'
ENV=dict(os.environ, PATH='/opt/ansuz-recordings/runtime/bin:'+os.environ['PATH'])
PROBE=BASE/'restore-probe-atproto.json'
service_token=(BASE/'auth/service-token').read_text().strip()
def post(origin,path,body,token=None):
    headers={'Content-Type':'application/json'}
    if token: headers['Authorization']='Bearer '+token
    req=urllib.request.Request(origin+path,data=json.dumps(body).encode(),headers=headers,method='POST')
    with urllib.request.urlopen(req,timeout=30) as r: result=json.load(r)
    if 'denied' in result or result.get('state')=='failed': raise RuntimeError('Probe operation refused')
    return result
origin='http://127.0.0.1:4431'
if not PROBE.exists():
    import secrets
    principal='did:web:restore-check.invalid'
    # Synthetic evidence belongs to this probe account, never the user's library.
    session=post(origin,'/auth/session',{'principal':principal,'days':1},service_token)['session']
    trace=json.dumps({'schema':'ansuz.gesture-take','version':3,'hz':120,'expected':'Synthetic restore proof','element':3,'element_model':'ansuz.elements/1','viewport':[390,500],'mode':0,'reduced_motion':False,'initial':{'orientation':[0,0,0,1],'velocity':[0,0],'position':[0,0],'down':False,'pointer':0,'quiet':0},'observed':[],'frames':[[0,0,False,0,0,0,0,0,0,0,0,0,1,0,0,390,500,False,0,0,0,0] for _ in range(2400)]},separators=(',',':')).encode()
    req=urllib.request.Request(origin+'/assets?as=file&name=restore-proof.json',data=trace,headers={'Authorization':'Bearer '+session['token'],'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(req) as r: asset=json.load(r)['asset']
    digest=hashlib.sha256(trace).hexdigest()
    args={'digest':digest,'label':'Synthetic restore proof','expected':'Synthetic restore proof','element':3,'captured':0,'frames':2400,'model':'ansuz.elements/1','trace':{'id':asset['id']}}
    row=post('http://127.0.0.1:4433','/m/archive',{'id':secrets.token_hex(16),'args':args},session['token'])['result']
    PROBE.write_text(json.dumps({'owner':session['principal'],'digest':digest,'asset':row['trace']['id'],'recording':row['id']}))
    PROBE.chmod(0o600)
probe=json.loads(PROBE.read_text())
subprocess.run(['systemctl','start','ansuz-recordings-backup.service'],check=True)
archive=max(pathlib.Path('/var/backups/ansuz-recordings').glob('*.tar.gz'),key=lambda p:p.name)
subprocess.run(['sha256sum','--check',str(archive)+'.sha256'],check=True,stdout=subprocess.DEVNULL)
directory=tempfile.mkdtemp(prefix='ansuz-restore-',dir='/var/lib/ansuz-recordings')
process=None
try:
    subprocess.run(['tar','-xzf',str(archive),'-C',directory],check=True)
    subprocess.run(['chown','-R','ansuz-recordings:ansuz-recordings',directory],check=True)
    process=subprocess.Popen(['runuser','-u','ansuz-recordings','--',CLI,'serve',directory+'/deployment','--bind','127.0.0.1','--port','4432'],env=ENV,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    restored='http://127.0.0.1:4432'
    for attempt in range(40):
        try:
            urllib.request.urlopen(restored+'/auth/config',timeout=2).close();break
        except Exception:
            if attempt==39: raise
            time.sleep(.25)
    restored_token=(pathlib.Path(directory)/'auth/service-token').read_text().strip()
    session=post(restored,'/auth/session',{'principal':probe['owner'],'days':1},restored_token)['session']
    row=post(restored,'/q/findTake',{'args':{'owner':probe['owner'],'digest':probe['digest']}},session['token'])['data']
    assert row['id']==probe['recording']
    req=urllib.request.Request(restored+'/assets/'+probe['asset'],headers={'Authorization':'Bearer '+session['token']})
    with urllib.request.urlopen(req) as r: trace=r.read()
    assert hashlib.sha256(trace).hexdigest()==probe['digest']
    print(json.dumps({'restored':True,'authenticated_trace_checksum':True,'backup':archive.name}))
finally:
    if process:
        process.terminate()
        try: process.wait(timeout=15)
        except subprocess.TimeoutExpired: process.kill();process.wait()
    shutil.rmtree(directory)
