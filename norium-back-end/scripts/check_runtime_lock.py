"""Fail CI if the installed backend differs from the Docker runtime lock."""

from __future__ import annotations

from importlib import metadata
from pathlib import Path
import re
import sys


REQUIREMENT = re.compile(
    r"^(?P<name>[A-Za-z0-9_.-]+)(?:\[[A-Za-z0-9_,.-]+\])?==(?P<version>[^\s]+)"
    r"(?:\s+--hash=sha256:[0-9a-f]{64})*$"
)
BOOTSTRAP_PACKAGES = {"pip", "setuptools", "wheel"}
PLATFORM_PACKAGES = {"win32": {"colorama": "0.4.6"}}


def canonical_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def main() -> int:
    lock = Path(__file__).resolve().parents[1] / "requirements.lock.txt"
    expected: dict[str, str] = {}
    for number, raw_line in enumerate(lock.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        requirement = REQUIREMENT.fullmatch(line)
        if requirement is None:
            raise ValueError(f"Unsupported lock entry at line {number}: {line}")
        name = canonical_name(requirement["name"])
        if name in expected:
            raise ValueError(f"Duplicate lock entry at line {number}: {name}")
        expected[name] = requirement["version"]

    if not expected:
        raise ValueError("Runtime lock is empty")

    direct_requirements = lock.with_name("requirements.txt")
    for number, raw_line in enumerate(direct_requirements.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        name, separator, version = line.partition("==")
        key = canonical_name(name.split("[", 1)[0])
        if key not in expected or (separator and expected[key] != version):
            raise ValueError(f"Runtime lock disagrees with direct requirement at line {number}: {line}")

    installed = {
        canonical_name(distribution.metadata["Name"]): distribution.version
        for distribution in metadata.distributions()
    }
    missing = sorted(set(expected) - set(installed))
    platform_packages = PLATFORM_PACKAGES.get(sys.platform, {})
    extra = sorted(set(installed) - set(expected) - BOOTSTRAP_PACKAGES - set(platform_packages))
    mismatched = sorted(
        (name, version, installed[name])
        for name, version in expected.items()
        if name in installed and installed[name] != version
    )
    mismatched.extend(
        (name, version, installed[name])
        for name, version in platform_packages.items()
        if name in installed and installed[name] != version
    )
    if missing or extra or mismatched:
        print(f"Missing runtime packages: {missing}", file=sys.stderr)
        print(f"Unpinned installed packages: {extra}", file=sys.stderr)
        print(f"Version mismatches (name, lock, installed): {mismatched}", file=sys.stderr)
        return 1

    print(f"Runtime lock matches {len(expected)} installed packages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
