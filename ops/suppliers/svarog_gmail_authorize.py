#!/usr/bin/env python3
"""User-run Desktop OAuth bootstrap. No messages, schedules or catalog writes."""
from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import time
import urllib.parse
import urllib.request
import webbrowser

MAILBOX = "bkush7430@gmail.com"
PROJECT = "masterweld-supplier-mail"
SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile"
MAX_JSON = 65536


class AuthorizeError(Exception):
    """Fixed public codes; never include server responses or secret values."""


def require(condition, code):
    if not condition:
        raise AuthorizeError(code)


def secret_string(value):
    return isinstance(value, str) and 8 <= len(value) <= 8192 and all(
        33 <= ord(char) <= 126 for char in value)


def regular_path(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode)
            and not getattr(info, "st_file_attributes", 0) & 0x400, "CLIENT_FILE_INVALID")
    require(info.st_size <= MAX_JSON, "CLIENT_FILE_TOO_LARGE")


def load_client(path):
    regular_path(path)
    with path.open("rb") as source:
        raw = source.read(MAX_JSON + 1)
    require(len(raw) <= MAX_JSON, "CLIENT_FILE_TOO_LARGE")
    value = json.loads(raw)
    require(type(value) is dict and set(value) == {"installed"}, "DESKTOP_CLIENT_REQUIRED")
    client = value["installed"]
    require(type(client) is dict and client.get("project_id") == PROJECT, "CLIENT_PROJECT_MISMATCH")
    # Official downloaded Desktop JSON may name the legacy auth endpoint.
    # Both are recognized metadata; actual requests always use pinned v2 below.
    require(client.get("auth_uri") in (AUTH_URL, "https://accounts.google.com/o/oauth2/auth")
            and client.get("token_uri") == TOKEN_URL, "CLIENT_ENDPOINT_MISMATCH")
    require(secret_string(client.get("client_id"))
            and client["client_id"].endswith(".apps.googleusercontent.com")
            and secret_string(client.get("client_secret")), "CLIENT_VALUES_INVALID")
    return {key: client[key] for key in ("client_id", "client_secret")}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


def request_json(request):
    require(request.full_url in (TOKEN_URL, PROFILE_URL), "OAUTH_ENDPOINT_REJECTED")
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            raw = response.read(MAX_JSON + 1)
        require(len(raw) <= MAX_JSON, "OAUTH_RESPONSE_TOO_LARGE")
        result = json.loads(raw)
        require(type(result) is dict, "OAUTH_RESPONSE_INVALID")
        return result
    except AuthorizeError:
        raise
    except Exception:
        raise AuthorizeError("GOOGLE_REQUEST_FAILED") from None


def parse_callback(target, host, expected_host, state):
    """Invalid/unrelated loopback requests never consume the outstanding login."""
    require(host == expected_host and len(target) <= 16384, "CALLBACK_REJECTED")
    parsed = urllib.parse.urlsplit(target)
    require(parsed.path == "/" and not parsed.scheme and not parsed.netloc and not parsed.fragment,
            "CALLBACK_REJECTED")
    values = urllib.parse.parse_qs(parsed.query, keep_blank_values=True, max_num_fields=12)
    require(all(len(items) == 1 for items in values.values()), "CALLBACK_REJECTED")
    returned = values.get("state", [""])[0]
    require(returned.isascii() and secrets.compare_digest(returned, state), "CALLBACK_REJECTED")
    if "error" in values:
        raise AuthorizeError("CONSENT_NOT_GRANTED")
    code = values.get("code", [""])[0]
    require(secret_string(code), "CALLBACK_REJECTED")
    return code


class LoopbackServer(HTTPServer):
    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address

    def handle_error(self, *_):
        # Base server traceback could contain callback data.
        pass


def authorize_code(client, timeout=600, open_browser=webbrowser.open):
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    result = {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            try:
                code = parse_callback(self.path, self.headers.get("Host"), expected_host, state)
                result["code"] = code
                response = b"Google connection received. Return to the local program."
                status = 200
            except (AuthorizeError, ValueError) as error:
                if isinstance(error, AuthorizeError) and str(error) == "CONSENT_NOT_GRANTED":
                    result["error"] = "CONSENT_NOT_GRANTED"
                response = b"Request not accepted. Return to the local program."
                status = 400
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(response)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            self.wfile.write(response)

    with LoopbackServer(("127.0.0.1", 0), Handler) as server:
        expected_host = "127.0.0.1:" + str(server.server_port)
        redirect = "http://" + expected_host + "/"
        query = urllib.parse.urlencode({
            "client_id": client["client_id"], "redirect_uri": redirect,
            "response_type": "code", "scope": SCOPE, "access_type": "offline",
            "prompt": "consent", "login_hint": MAILBOX, "state": state,
            "code_challenge": challenge, "code_challenge_method": "S256",
        })
        require(open_browser(AUTH_URL + "?" + query), "BROWSER_OPEN_FAILED")
        deadline = time.monotonic() + timeout
        server.timeout = 0.5
        while not result and time.monotonic() < deadline:
            server.handle_request()
        require(result, "CONSENT_TIMEOUT")
        require("error" not in result, "CONSENT_NOT_GRANTED")
    return result["code"], verifier, redirect


def obtain_credentials(client, code, verifier, redirect, request=request_json):
    form = urllib.parse.urlencode({
        **client, "code": code, "code_verifier": verifier,
        "redirect_uri": redirect, "grant_type": "authorization_code",
    }).encode("ascii")
    token = request(urllib.request.Request(TOKEN_URL, data=form, headers={
        "Content-Type": "application/x-www-form-urlencoded"}))
    require(token.get("token_type", "").lower() == "bearer"
            and secret_string(token.get("access_token"))
            and secret_string(token.get("refresh_token")), "OFFLINE_GRANT_REQUIRED")
    # Fail closed when the initial exchange omits scope: never invent granted rights.
    require(isinstance(token.get("scope"), str) and set(token["scope"].split()) == {SCOPE},
            "GRANTED_SCOPE_MISMATCH")
    profile = request(urllib.request.Request(PROFILE_URL, headers={
        "Authorization": "Bearer " + token["access_token"]}))
    require(profile.get("emailAddress", "").lower() == MAILBOX, "MAILBOX_MISMATCH")
    return {"version": 1, "mailbox": MAILBOX, **client,
            "refresh_token": token["refresh_token"], "scopes": [SCOPE]}


def verify_windows_acl(owner_matches, control, ace_count, ace_type, ace_flags, mask,
                       sid_matches, filesystem_flags):
    require(owner_matches and control & 0x1004 == 0x1004
            and ace_count == 1 and ace_type == 0 and ace_flags == 0
            and mask == 0x001F01FF and sid_matches and filesystem_flags & 0x8,
            "WINDOWS_PRIVATE_ACL_REQUIRED")


def windows_private_fd(path):
    """Apply owner-only ACL at CREATE_NEW, then verify the actual open handle."""
    from ctypes import wintypes as w
    import msvcrt
    require(re.fullmatch(r"[A-Za-z]:", path.drive) and ":" not in str(path)[2:],
            "WINDOWS_LOCAL_PATH_REQUIRED")
    for parent in path.parents:
        require(not parent.lstat().st_file_attributes & 0x400, "OUTPUT_REPARSE_REJECTED")
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    a = ctypes.WinDLL("advapi32", use_last_error=True)
    P = ctypes.c_void_p
    PP = ctypes.POINTER(P)
    D = w.DWORD
    def api(dll, name, restype, *args):
        value = getattr(dll, name)
        value.restype, value.argtypes = restype, args
        return value
    current_process = api(k, "GetCurrentProcess", w.HANDLE)
    close = api(k, "CloseHandle", w.BOOL, w.HANDLE)
    free = api(k, "LocalFree", P, P)
    open_token = api(a, "OpenProcessToken", w.BOOL, w.HANDLE, D, ctypes.POINTER(w.HANDLE))
    token_info = api(a, "GetTokenInformation", w.BOOL, w.HANDLE, ctypes.c_int, P, D, ctypes.POINTER(D))
    sid_text = api(a, "ConvertSidToStringSidW", w.BOOL, P, PP)
    sddl = api(a, "ConvertStringSecurityDescriptorToSecurityDescriptorW", w.BOOL, w.LPCWSTR, D, PP, P)
    get_security = api(a, "GetSecurityInfo", D, w.HANDLE, ctypes.c_int, D, PP, PP, PP, PP, PP)
    control_info = api(a, "GetSecurityDescriptorControl", w.BOOL, P, ctypes.POINTER(w.WORD), ctypes.POINTER(D))
    equal_sid = api(a, "EqualSid", w.BOOL, P, P)
    get_ace = api(a, "GetAce", w.BOOL, P, D, PP)
    volume_info = api(k, "GetVolumeInformationByHandleW", w.BOOL, w.HANDLE, w.LPWSTR, D,
                      ctypes.POINTER(D), ctypes.POINTER(D), ctypes.POINTER(D), w.LPWSTR, D)
    class SecurityAttributes(ctypes.Structure):
        _fields_ = [("length", D), ("descriptor", P), ("inherit", w.BOOL)]
    create_file = api(k, "CreateFileW", w.HANDLE, w.LPCWSTR, D, D,
                      ctypes.POINTER(SecurityAttributes), D, D, w.HANDLE)
    token_handle = w.HANDLE()
    descriptor, returned_descriptor, text_sid = P(), P(), P()
    handle = None
    def check(value):
        require(bool(value), "WINDOWS_PRIVATE_FILE_FAILED")
    try:
        check(open_token(current_process(), 8, ctypes.byref(token_handle)))
        size = D()
        token_info(token_handle, 1, None, 0, ctypes.byref(size))
        require(0 < size.value < 65536, "WINDOWS_TOKEN_INVALID")
        token_buffer = ctypes.create_string_buffer(size.value)
        check(token_info(token_handle, 1, token_buffer, size, ctypes.byref(size)))
        user_sid = P.from_buffer(token_buffer).value
        check(sid_text(user_sid, ctypes.byref(text_sid)))
        identity = ctypes.wstring_at(text_sid)
        check(sddl("O:" + identity + "D:P(A;;FA;;;" + identity + ")",
                   1, ctypes.byref(descriptor), None))
        attributes = SecurityAttributes(ctypes.sizeof(SecurityAttributes), descriptor, False)
        # READ_CONTROL + GENERIC_WRITE, no sharing, CREATE_NEW; final component is not followed.
        handle = create_file(str(path), 0x40020000, 0, ctypes.byref(attributes), 1, 0x00200080, None)
        require(handle != P(-1).value, "OUTPUT_CREATE_REFUSED")
        owner, dacl = P(), P()
        check(get_security(handle, 1, 5, ctypes.byref(owner), None, ctypes.byref(dacl),
                           None, ctypes.byref(returned_descriptor)) == 0)
        require(bool(dacl.value), "WINDOWS_PRIVATE_ACL_REQUIRED")
        control, revision, filesystem = w.WORD(), D(), D()
        check(control_info(returned_descriptor, ctypes.byref(control), ctypes.byref(revision)))
        check(volume_info(handle, None, 0, None, None, ctypes.byref(filesystem), None, 0))
        # ACL header: revision byte, padding byte, size WORD, AceCount WORD.
        count = ctypes.c_ushort.from_address(dacl.value + 4).value
        require(count == 1, "WINDOWS_PRIVATE_ACL_REQUIRED")
        ace = P()
        check(get_ace(dacl, 0, ctypes.byref(ace)))
        kind = ctypes.c_ubyte.from_address(ace.value).value
        flags = ctypes.c_ubyte.from_address(ace.value + 1).value
        mask = D.from_address(ace.value + 4).value
        # Other ACE types can place the SID at a different offset.
        require(kind == 0 and flags == 0 and mask == 0x001F01FF, "WINDOWS_PRIVATE_ACL_REQUIRED")
        verify_windows_acl(bool(equal_sid(owner, user_sid)), control.value, count, kind, flags,
                           mask, bool(equal_sid(ace.value + 8, user_sid)), filesystem.value)
        fd = msvcrt.open_osfhandle(handle, os.O_WRONLY | os.O_BINARY)
        handle = None  # fd now owns the handle.
        return fd
    finally:
        if handle is not None and handle != P(-1).value:
            close(handle)
        if token_handle.value:
            close(token_handle)
        for allocation in (descriptor, returned_descriptor, text_sid):
            if allocation.value:
                free(allocation)


def output_path(value):
    path = Path(value).absolute()
    require(not path.exists() and not path.is_symlink(), "OUTPUT_ALREADY_EXISTS")
    require(path.parent.is_dir() and not path.parent.is_symlink(), "OUTPUT_DIRECTORY_REQUIRED")
    require(not any(ord(char) < 32 for char in str(path)), "OUTPUT_PATH_INVALID")
    if os.name != "nt":
        info = path.parent.stat()
        require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
                "OUTPUT_DIRECTORY_NOT_PRIVATE")
    return path


def save_credentials(path, credentials):
    payload = (json.dumps(credentials, indent=2) + "\n").encode("utf-8")
    if os.name == "nt":
        fd = windows_private_fd(path)
    else:
        parent = path.parent.stat()
        require(parent.st_uid == os.getuid() and parent.st_mode & 0o077 == 0,
                "OUTPUT_DIRECTORY_NOT_PRIVATE")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            os.close(fd)
            raise AuthorizeError("OUTPUT_FILE_NOT_PRIVATE")
    try:
        os.set_inheritable(fd, False)
        output = os.fdopen(fd, "wb")
    except Exception:
        os.close(fd)
        raise
    with output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client-config", required=True, type=Path)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        target = output_path(args.output)
        client = load_client(args.client_config)
        print("Откроется Google. Выберите bkush7430@gmail.com и подтвердите только чтение Gmail.")
        code, verifier, redirect = authorize_code(client)
        credentials = obtain_credentials(client, code, verifier, redirect)
        save_credentials(target, credentials)
        print("Подключение сохранено в указанном файле. Письма и расписание не запускались.")
        return 0
    except KeyboardInterrupt:
        print("Подключение отменено.", file=sys.stderr)
        return 2
    except Exception as error:
        public_code = str(error) if isinstance(error, AuthorizeError) else "AUTHORIZATION_FAILED"
        print("Подключение не завершено: " + public_code, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
