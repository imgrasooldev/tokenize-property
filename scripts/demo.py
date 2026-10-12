"""One command for team presentations: start or stop the whole local demo.

    python scripts/demo.py up            # chain, PostgreSQL, website (3100) and Live Demo Console (4800)
    python scripts/demo.py up --trade    # ... plus demo trading in the market (about 5 minutes)
    python scripts/demo.py status
    python scripts/demo.py down          # stop website and demo trading; chain and DB keep running
    python scripts/demo.py down --all    # stop everything

LOCAL DEVELOPMENT ONLY. One-time setup first: see chain/README.md and backend/README.md
(net.py setup, pg.py setup, flow.py) and `npm run setup:demo` in web/.
"""

import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"
RUN = ROOT / "chain" / "data" / "demo"  # git-ignored
URL = "http://127.0.0.1:3100"
CONSOLE = "http://127.0.0.1:4800"
BACKEND = ROOT / "backend"


def run(*args):
    subprocess.run([sys.executable, *args], cwd=ROOT, check=True)


def up_ok(url, timeout=3):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def start_bg(name, cmd, cwd=WEB):
    """Starts a detached process with its output in chain/data/demo/<name>.log."""
    RUN.mkdir(parents=True, exist_ok=True)
    log = open(RUN / f"{name}.log", "ab")
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    proc = subprocess.Popen(cmd, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, creationflags=flags,
                            start_new_session=os.name != "nt")
    (RUN / f"{name}.pid").write_text(str(proc.pid))
    return proc


def stop_bg(name):
    pid_file = RUN / f"{name}.pid"
    if not pid_file.exists():
        return False
    pid = int(pid_file.read_text())
    if os.name == "nt":
        # /T: the whole tree (npm/npx start Next.js as a child process).
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    pid_file.unlink()
    return True


def cmd_up(args):
    if not (WEB / ".env.local").exists():
        sys.exit("web/.env.local is missing: run `npm run setup:demo` in web/ once.")
    if not (ROOT / "contracts" / "broadcast" / "Deploy.s.sol" / "586586" / "run-latest.json").exists():
        sys.exit("No deployment on the local chain yet: run `python chain/flow.py` once.")
    print("1/4 chain")
    run("chain/net.py", "start")
    print("2/4 PostgreSQL")
    run("backend/scripts/pg.py", "start")
    print("3/4 website")
    if up_ok(f"{URL}/login"):
        print(f"    already running on {URL}")
    else:
        npx = shutil.which("npx") or "npx"
        start_bg("web", [npx, "next", "dev", "--hostname", "127.0.0.1", "--port", "3100"])
        deadline = time.time() + 180
        while time.time() < deadline and not up_ok(f"{URL}/login", timeout=10):
            time.sleep(2)
        if not up_ok(f"{URL}/login"):
            sys.exit("Website did not start; see chain/data/demo/web.log")
        # Compile the main pages now, so the audience never waits for the first compile.
        for path in ("/", "/market", "/properties/GPF3", "/login", "/signup"):
            up_ok(f"{URL}{path}", timeout=120)
        print(f"    ready on {URL}  (log: chain/data/demo/web.log)")
    print("4/4 Live Demo Console")
    if up_ok(CONSOLE):
        print(f"    already running on {CONSOLE}")
    else:
        npm = shutil.which("npm") or "npm"
        start_bg("console", [npm, "run", "demo"], cwd=BACKEND)
        deadline = time.time() + 60
        while time.time() < deadline and not up_ok(CONSOLE):
            time.sleep(1)
        print(f"    {'ready on ' + CONSOLE if up_ok(CONSOLE) else 'did not start; see chain/data/demo/console.log'}")
    if "--trade" in args:
        npm = shutil.which("npm") or "npm"
        start_bg("trade", [npm, "run", "demo:market", "--", "40", "8"])
        print("    demo trading started (40 trades, 8 s apart; log: chain/data/demo/trade.log)")
    print(f"\nWebsite {URL}  -  Console {CONSOLE}  -  sign in as Alice or Bob  -  guide: docs/demo-guide.md")


def cmd_down(args):
    for name in ("trade", "console", "web"):
        print(f"{name}: {'stopped' if stop_bg(name) else 'not started by this script'}")
    if "--all" in args:
        run("backend/scripts/pg.py", "stop")
        run("chain/net.py", "stop")


def cmd_status(_args):
    run("chain/net.py", "status")
    run("backend/scripts/pg.py", "status")
    print(f"website: {'up' if up_ok(f'{URL}/login') else 'down'} ({URL})")
    print(f"console: {'up' if up_ok(CONSOLE) else 'down'} ({CONSOLE})")


COMMANDS = {"up": cmd_up, "down": cmd_down, "status": cmd_status}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.exit(__doc__)
    COMMANDS[sys.argv[1]](sys.argv[2:])
