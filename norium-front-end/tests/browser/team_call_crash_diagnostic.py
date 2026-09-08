"""Temporary CI reproduction: aggregate timing only, no browser data or dumps."""
import asyncio
import json
from pathlib import Path
import resource
import time

import team_call_e2e as harness

report = {'coreLimit': list(resource.getrlimit(resource.RLIMIT_CORE)),
          'coreHandlerPiped': Path('/proc/sys/kernel/core_pattern').read_text().startswith('|')}

async def observed_crash(session):
    start = time.monotonic()
    crashed = asyncio.Event()
    def on_crash(_):
        report['crashEventSeconds'] = round(time.monotonic() - start, 3)
        crashed.set()
    session.page.once('crash', on_crash)
    try:
        await session.page.goto('chrome://crash', wait_until='commit', timeout=5000)
        report['navigation'] = 'resolved'
    except Exception as error:
        report['navigation'] = type(error).__name__
    report['navigationSeconds'] = round(time.monotonic() - start, 3)
    try:
        await asyncio.wait_for(crashed.wait(), timeout=5)
        report['originalDeadline'] = 'passed'
    except TimeoutError:
        report['originalDeadline'] = 'failed'
        # Observe delayed events for diagnosis only; never turn failure green.
        try:
            await asyncio.wait_for(crashed.wait(), timeout=20)
        except TimeoutError:
            report['delayedEvent'] = 'missing'
        raise
    finally:
        Path('output/crash-diagnostic').mkdir(parents=True, exist_ok=True)
        Path('output/crash-diagnostic/crash-timing.json').write_text(json.dumps(report, indent=2))

harness.crash_page = observed_crash
args = harness.parser().parse_args(['--scenario', 'tab_close_and_crash', '--repeat', '1',
                                  '--artifacts-dir', 'output/crash-diagnostic/scenario'])
raise SystemExit(asyncio.run(harness.run(args)))
