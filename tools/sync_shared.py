"""Copy the shared front end (ranking, profiles, UI) from the local evaluator repo into this one.

    python tools/sync_shared.py [--from DIR]      copy and record the source commit
    python tools/sync_shared.py --check           exit 1 if a shared file differs from the record

ONE SOURCE OF TRUTH. The shared files are edited in the local repo (CheatingChicken/x4-ship-evaluator,
default path below, or $X4EVAL_LOCAL) and only copied here. evaluator/SHARED_FROM records the source
commit and a SHA-256 per file; --check (also run by tests/test_shared.js) catches edits made here by
mistake, which the next sync would silently overwrite. Wiki-only files (wiki.js, savereader.js once it
moves, anything not listed in SHARED) are never touched.

The local repo must be committed: a sync from a dirty tree would record a commit that does not
contain what was copied, so it is refused.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_LOCAL = os.environ.get("X4EVAL_LOCAL",
                               r"G:\SteamLibrary\steamapps\common\X4 Foundations\extensions\_x4catalogue")
RECORD = os.path.join(HERE, "evaluator", "SHARED_FROM")

# Same relative paths on both sides.
SHARED = [
    "evaluator/index.html", "evaluator/style.css", "evaluator/app.js", "evaluator/optimiser.js",
    "evaluator/profile.js", "evaluator/presets.js", "evaluator/setup.js", "evaluator/livereload.js",
    "tests/test_optimiser.js", "tests/test_profile.js", "tests/baseline.js",
]


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def git(repo, *args):
    return subprocess.run(["git", "-C", repo] + list(args), capture_output=True, text=True, check=True).stdout.strip()


def sync(src):
    if git(src, "status", "--porcelain", "--", *SHARED):
        sys.exit("refused: shared files are uncommitted in %s; commit them there first" % src)
    commit = git(src, "rev-parse", "HEAD")
    files = {}
    for rel in SHARED:
        a, b = os.path.join(src, rel), os.path.join(HERE, rel)
        if not os.path.isfile(a):
            sys.exit("missing in the local repo: " + rel)
        os.makedirs(os.path.dirname(b), exist_ok=True)
        shutil.copyfile(a, b)
        files[rel] = sha(b)
    with open(RECORD, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"repo": "CheatingChicken/x4-ship-evaluator", "commit": commit, "files": files}, f, indent=1)
        f.write("\n")
    print("synced %d files from %s at %s" % (len(files), src, commit[:7]))


def check():
    if not os.path.isfile(RECORD):
        print("no evaluator/SHARED_FROM: run a sync first")
        return 1
    rec = json.load(open(RECORD, encoding="utf-8"))
    bad = [rel for rel, h in rec["files"].items()
           if not os.path.isfile(os.path.join(HERE, rel)) or sha(os.path.join(HERE, rel)) != h]
    missing = [rel for rel in SHARED if rel not in rec["files"]]
    for rel in bad:
        print("changed here, not synced: " + rel)
    for rel in missing:
        print("not in SHARED_FROM (sync again): " + rel)
    if bad or missing:
        print("Edit shared files in the local repo, commit, then run tools/sync_shared.py.")
        return 1
    print("shared files match %s at %s" % (rec["repo"], rec["commit"][:7]))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--from", dest="src", default=DEFAULT_LOCAL)
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    if a.check:
        sys.exit(check())
    sync(a.src)


if __name__ == "__main__":
    main()
