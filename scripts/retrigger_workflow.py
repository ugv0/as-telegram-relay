#!/usr/bin/env python3
import os
import sys
import time
import json
import urllib.request
import urllib.error

GITHUB_API_URL = "https://api.github.com"

def retrigger():
    pat = os.getenv("GH_PAT") or os.getenv("GITHUB_TOKEN")
    repo = os.getenv("GITHUB_REPOSITORY", "ugv0/as-telegram-relay")
    workflow_id = "workflow.yml"
    ref = os.getenv("GITHUB_REF_NAME", "main")

    if not pat or not repo:
        print("[INFO] No token or repository specified. Skipping dispatch.")
        return

    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {pat}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "AS-Relay-Supervisor",
    }

    # Check for in-progress runs to avoid duplicates
    runs_url = f"{GITHUB_API_URL}/repos/{repo}/actions/workflows/{workflow_id}/runs?status=in_progress&per_page=5"
    try:
        req = urllib.request.Request(runs_url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            in_prog = data.get("workflow_runs", [])
            curr_run_id = os.getenv("GITHUB_RUN_ID")
            other_active = [r for r in in_prog if str(r.get("id")) != str(curr_run_id)]
            if other_active:
                print(f"[GUARD] Active workflow run already in progress (Run ID: {other_active[0]['id']}). Skipping duplicate.")
                return
    except Exception as e:
        print(f"[WARN] Could not check active runs: {e}")

    dispatch_url = f"{GITHUB_API_URL}/repos/{repo}/actions/workflows/{workflow_id}/dispatches"
    print(f"Triggering next 5-hour cycle for {repo}...")
    try:
        payload = json.dumps({"ref": ref}).encode("utf-8")
        post_headers = dict(headers)
        post_headers["Content-Type"] = "application/json"
        req = urllib.request.Request(dispatch_url, data=payload, headers=post_headers, method="POST")
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status == 204:
                print("[SUCCESS] Next 5-hour cycle dispatched successfully.")
            else:
                print(f"[ERROR] Dispatch returned HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        print(f"[ERROR] Dispatch HTTPError {e.code}: {e.read().decode('utf-8')}")
    except Exception as e:
        print(f"[ERROR] Exception during workflow retrigger: {e}")

if __name__ == "__main__":
    retrigger()
