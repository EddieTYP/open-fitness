#!/usr/bin/env python3
"""Atomically rename one same-parent entry without replacing an existing path."""

from __future__ import annotations

import argparse
import ctypes
import errno
import json
import os
from pathlib import Path
import stat
import sys
from typing import NoReturn

RENAME_EXCL = 0x00000004


def fail(message: str) -> "NoReturn":
    raise RuntimeError(message)


def lexical_absolute(value: str, label: str) -> Path:
    if not value or not os.path.isabs(value) or os.path.normpath(value) != value:
        fail(f"{label} must be a normalized absolute path")
    return Path(value)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("destination")
    options = parser.parse_args()

    source = lexical_absolute(options.source, "Source")
    destination = lexical_absolute(options.destination, "Destination")
    if source.parent != destination.parent or source.name in ("", ".", ".."):
        fail("Source and destination must be distinct entries under one parent")
    if source.name == destination.name or destination.name in ("", ".", ".."):
        fail("Source and destination names must be distinct and safe")

    parent = source.parent
    if parent.resolve(strict=True) != parent:
        fail("Publication parent must not traverse symlinks")
    parent_metadata = parent.lstat()
    if (
        not stat.S_ISDIR(parent_metadata.st_mode)
        or parent_metadata.st_uid != os.getuid()
        or stat.S_IMODE(parent_metadata.st_mode) & 0o022
    ):
        fail("Publication parent must be an owner-controlled non-writable-by-others directory")

    source_metadata = source.lstat()
    try:
        destination.lstat()
    except FileNotFoundError:
        pass
    else:
        fail("Destination already exists")

    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    parent_fd = os.open(parent, flags)
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        renameatx = getattr(libc, "renameatx_np", None)
        if renameatx is None:
            fail("Exclusive directory publication is unavailable on this platform")
        renameatx.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        renameatx.restype = ctypes.c_int
        result = renameatx(
            parent_fd,
            os.fsencode(source.name),
            parent_fd,
            os.fsencode(destination.name),
            RENAME_EXCL,
        )
        if result != 0:
            error_number = ctypes.get_errno()
            if error_number in (errno.EEXIST, errno.ENOTEMPTY):
                fail("Destination already exists")
            raise OSError(error_number, os.strerror(error_number))
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)

    published = destination.lstat()
    if (published.st_dev, published.st_ino) != (
        source_metadata.st_dev,
        source_metadata.st_ino,
    ):
        fail("Published entry identity changed")
    print(json.dumps({"ok": True, "published": destination.name}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Exclusive rename failed: {error}", file=sys.stderr)
        raise SystemExit(1)
