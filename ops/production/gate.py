"""Validate a short-lived, exact-SHA release decision. No network or side effects."""
import re, time
CHECKS=("source_review","tests","build","dev_browser","dev_telegram","database_isolation","production_config","database_backup","migration_plan","rollback","customer_readiness","next_steps")
def validate(report, sha, now=None):
    now=time.time() if now is None else now
    if not re.fullmatch(r"[0-9a-f]{40}",sha or ""): raise ValueError("FULL_SHA_REQUIRED")
    if report.get("mainSha")!=sha: raise ValueError("APPROVAL_SHA_MISMATCH")
    if not re.fullmatch(r"[0-9a-f]{40}",report.get("devSha","")): raise ValueError("DEV_SHA_REQUIRED")
    if report.get("ownerCommand")!="обнови main": raise ValueError("OWNER_COMMAND_REQUIRED")
    if not isinstance(report.get("approvedAt"),(int,float)) or not 0<=now-report["approvedAt"]<=86400: raise ValueError("APPROVAL_EXPIRED")
    if report.get("blockers")!=[]: raise ValueError("UNRESOLVED_BLOCKERS")
    checks=report.get("checks",{})
    for name in CHECKS:
        item=checks.get(name,{})
        if item.get("passed") is not True or not isinstance(item.get("evidence"),str) or not item["evidence"].strip():
            raise ValueError("CHECK_REQUIRED:"+name)
    return True
