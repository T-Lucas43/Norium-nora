"""Smoke test executavel da imagem que prova uma interacao DOM no Chromium."""

from __future__ import annotations

import asyncio
import argparse
import hashlib
import importlib.metadata
import json
import os
import re
from pathlib import Path
import subprocess
import sys

from playwright.async_api import async_playwright, expect
import playwright
from app.infrastructure.browser_egress import browser_executable_path, chromium_launch_options


CHROME_MINIMUM_VERSION = "154.0.8037.97"
CHROME_PACKAGE_VERSION = "154.0.8037.97-1"
CHROME_PACKAGE_SHA256 = "a4edbe95e9b01db6c9b97d7a1323121eda18362b5620df06abac1b59bee80053"
CHROME_PACKAGE_INDEX = "https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-amd64/Packages"


def browser_inventory(browser_type) -> dict:
    """Inventory the selected binary; package checks do not certify all CVEs."""
    options = chromium_launch_options()
    binary = browser_executable_path(browser_type)
    version_output = subprocess.run([str(binary), "--version"], env=options["env"], check=True,
                                    capture_output=True, text=True, timeout=15).stdout.strip()
    numeric_version = re.search(r"\b(\d+\.\d+\.\d+\.\d+)\b", version_output)
    if numeric_version is None:
        raise RuntimeError("O navegador não informou uma versão verificável.")
    version = numeric_version.group(1)
    with binary.open("rb") as stream:
        binary_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
    manifest_bytes = (Path(playwright.__file__).parent / "driver/package/browsers.json").read_bytes()
    expected = next(item for item in json.loads(manifest_bytes)["browsers"] if item["name"] == "chromium")
    inventory = {
        "playwrightVersion": importlib.metadata.version("playwright"),
        "browserChannel": options["channel"], "browserExecutablePath": str(binary),
        "chromiumVersion": version, "chromiumVersionOutput": version_output,
        "chromiumBinarySha256": binary_sha256,
        "playwrightRevision": expected["revision"],
        "playwrightManifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "bundledChromiumVersion": expected["browserVersion"],
        "coverage": "Version/hash and installed package inventory; not a complete browser vulnerability assessment",
    }
    if options["channel"] == "chromium":
        if version != expected["browserVersion"]:
            raise RuntimeError("Chromium binary version differs from the installed Playwright manifest")
    else:
        if tuple(map(int, version.split("."))) < tuple(map(int, CHROME_MINIMUM_VERSION.split("."))):
            raise RuntimeError("O Google Chrome é anterior à versão de segurança aprovada.")
        package_version = subprocess.run(["dpkg-query", "--show", "--showformat=${Version}", "google-chrome-stable"],
                                         env=options["env"], check=True, capture_output=True, text=True,
                                         timeout=15).stdout.strip()
        if package_version != CHROME_PACKAGE_VERSION or version != CHROME_PACKAGE_VERSION.rsplit("-", 1)[0]:
            raise RuntimeError("O pacote Google Chrome difere do pin aprovado da imagem.")
        inventory.update({
            "minimumChromeVersion": CHROME_MINIMUM_VERSION,
            "chromePackageVersion": package_version,
            "expectedChromePackageSha256": CHROME_PACKAGE_SHA256,
            "chromePackageIndex": CHROME_PACKAGE_INDEX,
            "packageIntegrityScope": "Expected official DEB checksum; the image build must verify the downloaded package separately",
        })
    return inventory


def check_container_status(text: str, uid: int) -> None:
    if uid != 10001:
        raise RuntimeError("The runtime smoke requires unprivileged UID 10001")
    status = dict(line.split(":", 1) for line in text.splitlines() if ":" in line)
    if status.get("NoNewPrivs", "").strip() != "1" or status.get("Seccomp", "").strip() != "2":
        raise RuntimeError("no-new-privileges and a seccomp filter are mandatory")
    if any(int(status.get(name, "1").strip(), 16) != 0 for name in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")):
        raise RuntimeError("The runtime smoke requires ALL capabilities dropped")


def require_container_security() -> None:
    if os.name != "posix":
        raise RuntimeError("The runtime smoke requires Linux")
    check_container_status(Path("/proc/self/status").read_text(), os.geteuid())
    # An independent child proves the allowed syscall grants no initial-namespace
    # privilege. Even chroot('/') must fail; never change this process's root.
    result = subprocess.run([sys.executable, "-c", "import os,sys\ntry: os.chroot('/')\nexcept PermissionError: sys.exit(0)\nelse: sys.exit(1)"],
                            env=chromium_launch_options()["env"], capture_output=True, timeout=5, check=False)
    if result.returncode != 0:
        raise RuntimeError("chroot must remain forbidden outside the browser user namespace")
    print("container_security_passed: UID 10001; capabilities zero; no-new-privileges; seccomp; initial namespace chroot denied")


def check_chromium_sandbox_status(rows: dict[str, str], evaluation: str) -> None:
    # Chromium 151's official sandbox_internals.ts reports the namespace as
    # "Layer 1 Sandbox / Namespace", rather than the obsolete Namespace row.
    required = {"Layer 1 Sandbox": "Namespace", "PID namespaces": "Yes",
                "Network namespaces": "Yes", "Seccomp-BPF sandbox": "Yes"}
    if any(rows.get(name) != value for name, value in required.items()) or evaluation != "You are adequately sandboxed.":
        raise RuntimeError("O Chromium não confirmou os sandboxes de namespace e seccomp.")


async def smoke(*, inventory_only: bool = False, container_security: bool = False) -> None:
    if container_security:
        require_container_security()
    async with async_playwright() as playwright:
        if inventory_only:
            browser_inventory(playwright.chromium)
            print("chromium_inventory_passed: selected binary/package verified; runtime DOM/sandbox validation still required")
            return
        options = chromium_launch_options()
        options["args"].append("--enable-logging=stderr")
        browser = await playwright.chromium.launch(**options)
        try:
            page = await browser.new_page()
            await page.goto("chrome://sandbox")
            await expect(page.locator("#evaluation")).to_have_text(re.compile(r"You are (?:NOT )?adequately sandboxed\."), timeout=10_000)
            rows = {}
            for row in await page.locator("#sandbox-status tr").all():
                cells = await row.locator("td").all_inner_texts()
                if len(cells) == 2:
                    rows[cells[0].strip()] = cells[1].strip()
            check_chromium_sandbox_status(rows, (await page.locator("#evaluation").inner_text()).strip())
            await page.goto("about:blank")
            await page.set_content(
                '<button id="ok">pendente</button>'
                '<script>document.querySelector("#ok").onclick = () => '
                'document.querySelector("#ok").textContent = "executado";</script>'
            )
            await page.locator("#ok").click()
            if await page.locator("#ok").inner_text() != "executado":
                raise RuntimeError("O Chromium abriu, mas a interacao DOM nao foi concluida.")
            print("chromium_runtime_passed: namespace and seccomp sandbox; DOM interaction")
        finally:
            await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory-only", action="store_true", help="Build inventory only; does not prove DOM or sandbox")
    parser.add_argument("--require-container-security", action="store_true", help="Assert UID, no capabilities, seccomp and no-new-privileges")
    args = parser.parse_args()
    asyncio.run(smoke(inventory_only=args.inventory_only, container_security=args.require_container_security))
