#!/usr/bin/env python3
"""Configure the explicitly selected DEV bot's native command menu."""
import json
import pathlib
from importlib.util import module_from_spec, spec_from_file_location

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = spec_from_file_location("dev_telegram", ROOT / "ops/dev/connect-telegram.py")
telegram = module_from_spec(spec)
spec.loader.exec_module(telegram)

def main():
    token_file = ROOT / "ops/.secrets/dev/telegram-token"
    if token_file.is_symlink() or token_file.stat().st_mode & 0o077:
        raise SystemExit("Private token file required")
    token = token_file.read_text().strip()
    me = telegram.call(token, "getMe")
    if me.get("username") != telegram.EXPECTED:
        raise SystemExit("Wrong bot; refusing menu change")
    navigation = json.loads((ROOT / "src/lib/bot/navigation.json").read_text())
    commands = [{"command": row["command"], "description": row["description"]} for row in navigation]
    telegram.call(token, "setMyCommands", {"commands": commands, "scope": {"type": "all_private_chats"}})
    telegram.call(token, "setChatMenuButton", {"menu_button": {"type": "commands"}})
    actual = telegram.call(token, "getMyCommands", {"scope": {"type": "all_private_chats"}})
    if actual != commands:
        raise SystemExit("Command menu verification failed")
    print("DEV native command menu configured and verified")

if __name__ == "__main__":
    main()
