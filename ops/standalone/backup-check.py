#!/usr/bin/env python3
"""Compatibility entrypoint: production backup with restore in a new offline container."""
from pathlib import Path
import runpy
import sys

if __name__ == "__main__":
    if len(sys.argv) != 1:
        raise SystemExit("Use database-backup.py backup production [--offsite]")
    target = Path(__file__).with_name("database-backup.py")
    sys.argv = [str(target), "backup", "production"]
    runpy.run_path(str(target), run_name="__main__")
