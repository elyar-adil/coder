#!/usr/bin/env python3
"""Test harness: runs all Python + TypeScript tests and reports results."""
import subprocess
import sys
import os
import platform

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IS_WIN = platform.system() == "Windows"

def run(cmd_list, cwd=ROOT, label=None):
    label = label or " ".join(cmd_list) if isinstance(cmd_list, list) else cmd_list
    print(f"\n{'='*60}")
    print(f"RUNNING: {label}")
    print(f"{'='*60}")
    result = subprocess.run(cmd_list, cwd=cwd, capture_output=False, text=True, shell=IS_WIN)
    status = "PASSED" if result.returncode == 0 else f"FAILED (exit code {result.returncode})"
    print(f"  {status}")
    return result.returncode

exit_codes = []

exit_codes.append(run(
    [sys.executable, "-m", "unittest", "tests/tetris_test.py"],
    label="Tetris Python tests"
))

exit_codes.append(run(
    ["npm", "run", "typecheck"],
    label="TypeScript typecheck"
))

exit_codes.append(run(
    ["npm", "test"],
    label="TypeScript unit tests"
))

print(f"\n{'='*60}")
if any(exit_codes):
    print(f"FAILED: {sum(1 for c in exit_codes if c != 0)} of {len(exit_codes)} suites failed")
    sys.exit(1)
else:
    print(f"ALL {len(exit_codes)} TEST SUITES PASSED")
    sys.exit(0)
