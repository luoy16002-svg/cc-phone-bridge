"""Keeps the 值班台 server running on Windows without a console window (started by the scheduled task that
install-task.ps1 registers).

The server is restarted when it exits: after 5 s normally, after 60 s when it keeps failing or the port is taken.
Node is found on PATH, else in the default install folder; set CCPB_NODE to use another one.
"""
import os
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
NODE = (os.environ.get('CCPB_NODE') or shutil.which('node')
        or str(Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'nodejs' / 'node.exe'))
DATA = Path(os.environ.get('CCPB_DATA') or Path(os.environ.get('LOCALAPPDATA', str(HERE))) / 'cc-phone-bridge')
DATA.mkdir(parents=True, exist_ok=True)
LOG = DATA / 'launcher.log'
OUT = DATA / 'server.out.log'
CREATE_NO_WINDOW = 0x08000000


def log(msg):
    try:
        if LOG.exists() and LOG.stat().st_size > 1_000_000:
            LOG.replace(LOG.with_suffix('.log.1'))
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(f'{datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n')
    except OSError:
        pass


recent = []
while True:
    if OUT.exists() and OUT.stat().st_size > 1_000_000:
        OUT.replace(OUT.with_suffix('.log.1'))
    started = time.time()
    log('starting server')
    with open(OUT, 'ab') as out:
        proc = subprocess.Popen([NODE, str(HERE / 'server.mjs')], cwd=str(HERE), stdout=out, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
        code = proc.wait()
    ran = time.time() - started
    log(f'server exited with code {code} after {ran:.0f} s')
    recent = [t for t in recent if time.time() - t < 300] + [time.time()]
    time.sleep(60 if code == 3 or len(recent) >= 3 else 5)
