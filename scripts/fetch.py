#!/usr/bin/env python3
"""Fetch only the official commits declared in upstream.json."""
from pathlib import Path
import subprocess
from upstream import load_pins
ROOT=Path(__file__).resolve().parent.parent
pin=load_pins()
for kind in ('engine','game'):
    target=ROOT/'work'/kind
    if not target.exists():
        target.mkdir(parents=True)
        subprocess.run(['git','init',str(target)],check=True)
        subprocess.run(['git','-C',str(target),'remote','add','origin',f'https://github.com/flareteam/flare-{kind}.git'],check=True)
    subprocess.run(['git','-C',str(target),'fetch','--depth','1','origin',pin[kind]],check=True)
    subprocess.run(['git','-C',str(target),'checkout','--detach',pin[kind]],check=True)
