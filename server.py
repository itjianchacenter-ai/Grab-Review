#!/usr/bin/env python3
"""HTTP server for Grab Menu Dashboard with auth.

Endpoints:
  POST /api/login   - { username, password } → sets session cookie
  POST /api/logout  - clears session
  GET  /api/me      - returns current user (or 401)
  POST /api/sync    - orchestrators push data here (no auth — localhost only)
  GET  /api/data    - dashboard polls (auth required)

Static:
  /login.html       - public
  /dashboard.html   - auth required (redirects to /login.html if no session)
  others            - public (css/js/images)
"""

import hashlib
import hmac
import http.cookies
import http.server
import json
import os
import secrets
import sys
import tempfile
import time
from collections import deque
from pathlib import Path
from threading import RLock

ROOT = Path(__file__).resolve().parent
EXT_DIR = ROOT / "extension"
DATA_FILE = ROOT / "server-data.json"
REVIEWS_FILE = ROOT / "server-reviews.json"
USERS_FILE = ROOT / "users.json"
SESSIONS_FILE = ROOT / ".sessions.json"
AUDIT_LOG = ROOT / "logs" / "audit.log"
PORT = int(os.environ.get("PORT", "8765"))
# PREVIEW_MODE=1 bypasses auth for /reviews.html + /api/reviews (for design preview only — do not deploy with this set)
PREVIEW_MODE = os.environ.get("PREVIEW_MODE", "").strip() == "1"
HOST = os.environ.get("HOST", "localhost")
SESSION_TTL = int(os.environ.get("SESSION_TTL", str(8 * 3600)))  # 8 hours
SESSION_COOKIE = "jc_session"
# Set true behind HTTPS (Cloudflare Tunnel / nginx). Cookie won't transmit over HTTP.
SECURE_COOKIE = os.environ.get("SECURE_COOKIE", "false").lower() == "true"

# CORS — restrict to known origins (comma-separated list, or "*" for dev)
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", f"http://{HOST}:{PORT}").split(",")

# Login rate limiting — max 5 failed attempts per 15 min per IP
LOGIN_RATE_LIMIT = 5
LOGIN_RATE_WINDOW = 15 * 60  # seconds

# Max request body — protects against memory bombs
# Login: small (1KB). Sync: large (could be 5-10MB for 50 branches × 50 menus)
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(20 * 1024 * 1024)))  # 20 MB default
MAX_LOGIN_BYTES = 4 * 1024  # 4 KB for login

# Shared token for /api/sync (orchestrator → server). If unset, only localhost allowed.
SYNC_TOKEN = os.environ.get("SYNC_TOKEN", "").strip()
LOGIN_ATTEMPTS = {}  # ip → deque of failure timestamps

# Branch IDs to exclude — won't appear in dashboard
EXCLUDED_IDS = {
    "3-C6WJCULBLU2AL6",  # King Power Rangnam
    "3-C6VVMAKHLBNBET",  # Head office
    "3-C62EJCKTLFXJTX",  # G
    "3-C72TAKABAKE1V2",  # Groove @Central World (CTW — not actually operating)
}

# Session store (loaded from disk on boot, persisted on changes)
SESSIONS = {}
SESSIONS_LOCK = RLock()
DATA_LOCK = RLock()  # protects server-data.json writes
REVIEWS_LOCK = RLock()  # protects server-reviews.json writes

START_TIME = time.time()


# ════════════════════════════════════════════════════════════════
# Helpers
# ════════════════════════════════════════════════════════════════

def atomic_write(path: Path, content: str):
    """Write file atomically — write to temp + rename. Prevents corruption on crash."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try: os.unlink(tmp)
        except Exception: pass
        raise


def read_data():
    with DATA_LOCK:
        if not DATA_FILE.exists():
            return {"merchants": {}, "events": [], "syncedAt": None}
        try:
            return json.loads(DATA_FILE.read_text())
        except Exception:
            return {"merchants": {}, "events": [], "syncedAt": None}


def write_data(data: dict):
    with DATA_LOCK:
        atomic_write(DATA_FILE, json.dumps(data))


def read_reviews():
    with REVIEWS_LOCK:
        if not REVIEWS_FILE.exists():
            return {"branches": {}, "syncedAt": None}
        try:
            return json.loads(REVIEWS_FILE.read_text())
        except Exception:
            return {"branches": {}, "syncedAt": None}


def write_reviews(data: dict):
    with REVIEWS_LOCK:
        atomic_write(REVIEWS_FILE, json.dumps(data))


def load_sessions_from_disk():
    """Restore sessions on server boot (survives restart)."""
    global SESSIONS
    if not SESSIONS_FILE.exists():
        return
    try:
        data = json.loads(SESSIONS_FILE.read_text())
        now = time.time()
        SESSIONS = {t: s for t, s in data.items() if s.get("expires_at", 0) > now}
    except Exception:
        SESSIONS = {}


def save_sessions_to_disk():
    with SESSIONS_LOCK:
        try:
            atomic_write(SESSIONS_FILE, json.dumps(SESSIONS))
            try: os.chmod(SESSIONS_FILE, 0o600)
            except Exception: pass
        except Exception:
            pass


def check_login_rate(ip: str) -> bool:
    """Returns True if allowed; False if rate-limited."""
    now = time.time()
    dq = LOGIN_ATTEMPTS.setdefault(ip, deque())
    while dq and dq[0] < now - LOGIN_RATE_WINDOW:
        dq.popleft()
    return len(dq) < LOGIN_RATE_LIMIT


def record_login_failure(ip: str):
    LOGIN_ATTEMPTS.setdefault(ip, deque()).append(time.time())


def audit_log(event, **fields):
    """Append-only audit log for login/logout events."""
    try:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps({
            "ts": int(time.time() * 1000),
            "iso": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "event": event,
            **fields,
        }, ensure_ascii=False)
        with open(AUDIT_LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def origin_allowed(origin):
    """Return the Allow-Origin value to use for the response, or None to skip."""
    if not origin:
        return None
    if "*" in CORS_ORIGINS:
        return "*"
    if origin in CORS_ORIGINS:
        return origin
    return None


def load_users():
    if not USERS_FILE.exists():
        return []
    try:
        return json.loads(USERS_FILE.read_text())
    except Exception:
        return []


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, hash_hex = stored.split(":")
        salt = bytes.fromhex(salt_hex)
        expected = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100_000)
        return hmac.compare_digest(expected.hex(), hash_hex)
    except Exception:
        return False


def find_user(username: str):
    for u in load_users():
        if u.get("username") == username:
            return u
    return None


def public_user(u: dict) -> dict:
    return {k: v for k, v in u.items() if k != "password_hash"}


def make_session(user: dict) -> str:
    token = secrets.token_urlsafe(32)
    with SESSIONS_LOCK:
        SESSIONS[token] = {
            "user": public_user(user),
            "expires_at": time.time() + SESSION_TTL,
        }
    # Periodic cleanup of expired sessions
    now = time.time()
    expired = [t for t, s in SESSIONS.items() if s["expires_at"] < now]
    for t in expired:
        SESSIONS.pop(t, None)
    return token


# ════════════════════════════════════════════════════════════════
# Handler
# ════════════════════════════════════════════════════════════════

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(EXT_DIR), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {fmt % args}\n")

    # ─── Helpers ───────────────────────────────────────────────

    def _cors(self):
        origin = self.headers.get("Origin")
        allowed = origin_allowed(origin)
        if allowed:
            self.send_header("Access-Control-Allow-Origin", allowed)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            if allowed != "*":
                self.send_header("Access-Control-Allow-Credentials", "true")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def _read_json(self, max_bytes=None):
        if max_bytes is None:
            max_bytes = MAX_BODY_BYTES
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length > max_bytes:
            raise ValueError(f"request body too large ({length} > {max_bytes})")
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        return json.loads(raw) if raw else {}

    def _send_json(self, status, body, extra_headers=None):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self._cors()
        for k, v in extra_headers or []:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    def _get_session_user(self):
        cookie_header = self.headers.get("Cookie", "")
        if not cookie_header:
            return None
        c = http.cookies.SimpleCookie()
        try:
            c.load(cookie_header)
        except Exception:
            return None
        token = c.get(SESSION_COOKIE)
        if not token:
            return None
        sess = SESSIONS.get(token.value)
        if not sess:
            return None
        if sess["expires_at"] < time.time():
            SESSIONS.pop(token.value, None)
            return None
        return sess["user"]

    def _require_auth(self):
        user = self._get_session_user()
        if not user:
            self._send_json(401, {"ok": False, "error": "auth required"})
            return None
        return user

    def _get_real_ip(self):
        # Behind nginx, the direct peer is always 127.0.0.1 — fall back to
        # X-Real-IP (set by the trusted nginx config: proxy_set_header X-Real-IP
        # $remote_addr) so localhost checks, rate-limiting, and audit logs see
        # the actual client. nginx overwrites any client-supplied X-Real-IP, so
        # spoofing through nginx is not possible.
        direct_ip = self.client_address[0] if self.client_address else ""
        if direct_ip in ("127.0.0.1", "::1"):
            forwarded = (self.headers.get("X-Real-IP") or "").strip()
            if forwarded:
                return forwarded
        return direct_ip

    # ─── OPTIONS (CORS preflight) ──────────────────────────────

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    # ─── GET ───────────────────────────────────────────────────

    def do_GET(self):
        path = self.path.split("?", 1)[0]

        # /api/health — public health check (for monitoring/uptime)
        if path == "/api/health":
            data = read_data()
            merchants = data.get("merchants") or {}
            events = data.get("events") or []
            last_sync = max((m.get("lastFetched", 0) for m in merchants.values()), default=0)
            stale_min = round((time.time() * 1000 - last_sync) / 60_000) if last_sync else None
            self._send_json(200, {
                "ok": True,
                "uptime_sec": round(time.time() - START_TIME),
                "merchants": len(merchants),
                "events": len(events),
                "sessions": len(SESSIONS),
                "last_sync_minutes_ago": stale_min,
                "data_file_exists": DATA_FILE.exists(),
                "users_file_exists": USERS_FILE.exists(),
            })
            return

        # /api/me — returns current user or 401
        if path == "/api/me":
            user = self._get_session_user()
            if not user:
                self._send_json(401, {"ok": False, "error": "not authenticated"})
                return
            self._send_json(200, {"ok": True, "user": user})
            return

        # /api/data — protected
        if path == "/api/data":
            if not self._require_auth():
                return
            data = read_data()
            self._send_json(200, data)
            return

        # /api/reviews — protected
        if path == "/api/reviews":
            if not PREVIEW_MODE and not self._require_auth():
                return
            data = read_reviews()
            self._send_json(200, data)
            return

        # /  → /dashboard.html
        if path == "/" or path == "":
            self.send_response(302)
            self.send_header("Location", "/dashboard.html")
            self.end_headers()
            return

        # /dashboard.html — protected, redirect to login if not auth
        if path == "/dashboard.html":
            if not self._get_session_user():
                self.send_response(302)
                self.send_header("Location", "/login.html")
                self.end_headers()
                return

        # /reviews.html — protected, redirect to login if not auth
        if path == "/reviews.html":
            if not PREVIEW_MODE and not self._get_session_user():
                self.send_response(302)
                self.send_header("Location", "/login.html")
                self.end_headers()
                return

        # Static files (login.html, css, js, images, etc.)
        return super().do_GET()

    # ─── POST ──────────────────────────────────────────────────

    def do_POST(self):
        path = self.path.split("?", 1)[0]

        # /api/login
        if path == "/api/login":
            ip = self._get_real_ip() or "?"
            try:
                if not check_login_rate(ip):
                    audit_log("login_blocked_rate_limit", ip=ip)
                    self._send_json(429, {"ok": False, "error": "too many failed attempts — try again later"})
                    return
                payload = self._read_json(max_bytes=MAX_LOGIN_BYTES)
                username = (payload.get("username") or "").strip()
                password = payload.get("password") or ""
                if not username or not password:
                    self._send_json(400, {"ok": False, "error": "missing credentials"})
                    return
                user = find_user(username)
                if not user or not verify_password(password, user.get("password_hash", "")):
                    record_login_failure(ip)
                    audit_log("login_failed", username=username, ip=ip)
                    self._send_json(401, {"ok": False, "error": "invalid username or password"})
                    return
                token = make_session(user)
                save_sessions_to_disk()
                LOGIN_ATTEMPTS.pop(ip, None)
                audit_log("login_success", username=username, role=user.get("role"), ip=ip)
                cookie = http.cookies.SimpleCookie()
                cookie[SESSION_COOKIE] = token
                cookie[SESSION_COOKIE]["path"] = "/"
                cookie[SESSION_COOKIE]["max-age"] = SESSION_TTL
                cookie[SESSION_COOKIE]["httponly"] = True
                cookie[SESSION_COOKIE]["samesite"] = "Lax"
                if SECURE_COOKIE:
                    cookie[SESSION_COOKIE]["secure"] = True
                self._send_json(
                    200,
                    {"ok": True, "user": public_user(user)},
                    extra_headers=[("Set-Cookie", cookie.output(header="").strip())],
                )
            except Exception as e:
                self._send_json(400, {"ok": False, "error": str(e)})
            return

        # /api/logout
        if path == "/api/logout":
            ip = self._get_real_ip() or "?"
            user = self._get_session_user()
            cookie_header = self.headers.get("Cookie", "")
            if cookie_header:
                c = http.cookies.SimpleCookie()
                try:
                    c.load(cookie_header)
                    if c.get(SESSION_COOKIE):
                        with SESSIONS_LOCK:
                            SESSIONS.pop(c[SESSION_COOKIE].value, None)
                        save_sessions_to_disk()
                except Exception:
                    pass
            if user:
                audit_log("logout", username=user.get("username"), ip=ip)
            cookie = http.cookies.SimpleCookie()
            cookie[SESSION_COOKIE] = ""
            cookie[SESSION_COOKIE]["path"] = "/"
            cookie[SESSION_COOKIE]["max-age"] = 0
            self._send_json(200, {"ok": True}, extra_headers=[("Set-Cookie", cookie.output(header="").strip())])
            return

        # /api/sync — requires either localhost OR matching SYNC_TOKEN header
        if path == "/api/sync":
            client_ip = self._get_real_ip()
            is_localhost = client_ip in ("127.0.0.1", "::1", "localhost")
            token_header = self.headers.get("X-Sync-Token", "")
            token_ok = SYNC_TOKEN and hmac.compare_digest(token_header, SYNC_TOKEN)
            if not (is_localhost or token_ok):
                self._send_json(403, {"ok": False, "error": "sync requires localhost or X-Sync-Token"})
                return
            self._handle_sync()
            return

        # /api/sync-reviews — same auth as /api/sync
        if path == "/api/sync-reviews":
            client_ip = self._get_real_ip()
            is_localhost = client_ip in ("127.0.0.1", "::1", "localhost")
            token_header = self.headers.get("X-Sync-Token", "")
            token_ok = SYNC_TOKEN and hmac.compare_digest(token_header, SYNC_TOKEN)
            if not (is_localhost or token_ok):
                self._send_json(403, {"ok": False, "error": "sync requires localhost or X-Sync-Token"})
                return
            self._handle_sync_reviews()
            return

        self.send_error(404)

    # ─── Sync handler (extracted) ──────────────────────────────

    def _handle_sync(self):
        try:
            payload = self._read_json()
            if not isinstance(payload, dict):
                raise ValueError("payload must be object")
            if "merchants" not in payload:
                raise ValueError("missing 'merchants'")

            existing = read_data()
            merchants = dict(existing.get("merchants") or {})
            for mid, mdata in (payload.get("merchants") or {}).items():
                if mid in EXCLUDED_IDS:
                    continue
                merchants[mid] = mdata
            for ex in EXCLUDED_IDS:
                merchants.pop(ex, None)

            events = list(existing.get("events") or [])
            new_events = payload.get("events") or []
            seen = {(e.get("ts"), e.get("menuId"), e.get("type")) for e in events}
            for e in new_events:
                key = (e.get("ts"), e.get("menuId"), e.get("type"))
                if key not in seen:
                    events.append(e)
                    seen.add(key)
            if len(events) > 2000:
                events = events[-2000:]

            merged = {
                "merchants": merchants,
                "events": events,
                "syncedAt": self.log_date_time_string(),
            }
            write_data(merged)

            self._send_json(200, {
                "ok": True,
                "merchants": len(merchants),
                "events": len(events),
                "added_branches": list((payload.get("merchants") or {}).keys()),
            })
        except Exception as e:
            self._send_json(400, {"ok": False, "error": str(e)})

    # ─── Reviews sync handler ─────────────────────────────────
    # Payload from auto-sync-reviews.js:
    #   { ok, overview, queriedMerchantIDs, branches: {<mid>: {merchantId, merchantName, reviews}}, capturedAt }
    # Merge logic: dedupe reviews by reviewId, keep history. Overview = latest.

    def _handle_sync_reviews(self):
        try:
            payload = self._read_json()
            if not isinstance(payload, dict):
                raise ValueError("payload must be object")
            incoming_branches = payload.get("branches") or {}
            overview = payload.get("overview")
            captured_at = payload.get("capturedAt") or int(time.time() * 1000)

            existing = read_reviews()
            branches = dict(existing.get("branches") or {})
            new_review_count = 0

            # JIANCHA-only filter — drop other brand merchants (Yoguruto, MIXUE, Taning, etc.)
            JIANCHA_KEYWORDS = ("JIANCHA", "เจี้ยนชา", "见茶山", "Jian cha", "Jiancha", "jiancha")
            def is_jiancha(name: str) -> bool:
                if not name:
                    return False
                return any(kw in name for kw in JIANCHA_KEYWORDS)

            for mid, incoming in incoming_branches.items():
                if mid in EXCLUDED_IDS:
                    continue
                # Skip non-JIANCHA brand merchants
                name_check = incoming.get("merchantName") or (incoming.get("reviews") or [{}])[0].get("merchantName") or ""
                # If we have a name → require JIANCHA keyword. If no name → skip (uncertain, no value without data)
                if not name_check or not is_jiancha(name_check):
                    continue
                cur = branches.get(mid) or {
                    "merchantId": mid,
                    "merchantName": incoming.get("merchantName"),
                    "reviews": [],
                    "overview": None,
                    "lastSyncedAt": None,
                }
                # Index existing by reviewId
                seen = {r.get("reviewId"): i for i, r in enumerate(cur["reviews"]) if r.get("reviewId")}
                added = 0
                for r in incoming.get("reviews") or []:
                    rid = r.get("reviewId")
                    if not rid:
                        continue
                    if rid in seen:
                        # Update existing (in case reply was added)
                        cur["reviews"][seen[rid]] = r
                    else:
                        cur["reviews"].append(r)
                        added += 1
                new_review_count += added
                # Update branch metadata — preserve real Grab name if already stored
                # (prevents vault-injected names from overwriting real ones)
                if incoming.get("merchantName") and not cur.get("merchantName"):
                    cur["merchantName"] = incoming["merchantName"]
                cur["overview"] = overview  # latest overview from this group
                cur["lastSyncedAt"] = captured_at
                # Sort newest first
                cur["reviews"].sort(key=lambda x: x.get("createdAt", ""), reverse=True)
                # Cap history (keep latest 500 per branch)
                if len(cur["reviews"]) > 500:
                    cur["reviews"] = cur["reviews"][:500]
                branches[mid] = cur

            merged = {
                "branches": branches,
                "syncedAt": self.log_date_time_string(),
            }
            write_reviews(merged)

            self._send_json(200, {
                "ok": True,
                "branches_updated": list(incoming_branches.keys()),
                "new_reviews": new_review_count,
                "total_branches": len(branches),
            })
        except Exception as e:
            self._send_json(400, {"ok": False, "error": str(e)})


# ════════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════════

def main():
    if not USERS_FILE.exists():
        print(f"⚠ {USERS_FILE} not found — run: python3 scripts/init-users.py", file=sys.stderr)
    load_sessions_from_disk()
    print(f"Serving at http://{HOST}:{PORT}")
    print(f"Login:     http://{HOST}:{PORT}/login.html")
    print(f"Dashboard: http://{HOST}:{PORT}/dashboard.html")
    print(f"Health:    http://{HOST}:{PORT}/api/health")
    print(f"CORS:      {', '.join(CORS_ORIGINS)}")
    print(f"Sessions:  {len(SESSIONS)} active (loaded from disk)")
    try:
        http.server.ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        save_sessions_to_disk()
        print("\nShutdown — sessions persisted")


if __name__ == "__main__":
    main()
