"""Run with the backend venv; requires the calls fixture on ports 5173/8000."""
import asyncio
import json
from pathlib import Path
from playwright.async_api import async_playwright, expect

OUT = Path(__file__).resolve().parents[3] / "output" / "call-validation"
OUT.mkdir(parents=True, exist_ok=True)


async def audio_level(page):
    return await page.evaluate("""async () => {
      const audio = document.querySelector('audio[aria-label="Áudio de Owner"]');
      const context = new AudioContext(); await context.resume();
      const source = context.createMediaStreamSource(audio.srcObject);
      const analyser = context.createAnalyser(); analyser.fftSize = 2048;
      source.connect(analyser);
      const silent = context.createGain(); silent.gain.value = 0;
      analyser.connect(silent).connect(context.destination);
      await new Promise(resolve => setTimeout(resolve, 350));
      const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((total, sample) => total + sample * sample, 0) / samples.length);
      source.disconnect(); await context.close(); return rms;
    }""")


async def video_live(page, label):
    await expect(page.get_by_label(label, exact=True)).to_be_visible()
    await page.wait_for_function("""label => {
      const video = [...document.querySelectorAll('video')].find(v => v.getAttribute('aria-label') === label);
      return video && video.videoWidth > 0 && video.readyState >= 2 && video.srcObject;
    }""", arg=label)


async def main():
    errors = []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        contexts = [await browser.new_context(viewport={"width": 1440, "height": 900}) for _ in range(3)]
        pages = [await context.new_page() for context in contexts]
        owner, member, other = pages
        # The fixture owns this temporary store; reset a previous interrupted run.
        existing = await owner.request.get("http://127.0.0.1:8000/api/team-chat/calls/active", headers={"Authorization": "Bearer owner"})
        assert existing.ok
        for call in (await existing.json()).get("calls", []):
            await owner.request.delete(f"http://127.0.0.1:8000/api/team-chat/calls/{call['callId']}", headers={"Authorization": "Bearer owner"})
        for page, user in zip(pages, ["owner", "member", "other"]):
            page.on("pageerror", lambda error: errors.append(str(error)))
            await page.add_init_script("""window.__pcs = []; const Original = RTCPeerConnection;
              window.RTCPeerConnection = class extends Original { constructor(...args) { super(...args); window.__pcs.push(this); } };
              window.__audioContexts = []; const AC = AudioContext;
              window.AudioContext = class extends AC { constructor(options) { super({...options, sinkId:{type:'none'}}); window.__audioContexts.push(this); } };""")
            await page.goto(f"http://127.0.0.1:5173/tests/browser/calls.html?user={user}")
            await expect(page.get_by_text("Conectado", exact=True)).to_be_visible()
        await owner.get_by_role("button", name="Iniciar reunião", exact=True).click()
        await member.get_by_role("button", name="Entrar na reunião", exact=True).click()
        await expect(owner.get_by_role("slider", name="Volume de Member")).to_be_visible()
        await expect(member.get_by_role("slider", name="Volume de Owner")).to_be_visible()
        print("Two participants connected", flush=True)
        await owner.get_by_role("button", name="Ativar câmera", exact=True).click()
        await video_live(member, "Câmera de Owner")
        await owner.get_by_role("button", name="Desativar câmera", exact=True).click()
        await expect(member.get_by_text("Owner está sem câmera", exact=True)).to_be_visible()
        assert await member.get_by_label("Câmera de Owner", exact=True).evaluate("v => v.srcObject === null")

        for sender, receiver, name in [(owner, member, "Owner"), (member, owner, "Member")]:
            await sender.get_by_role("button", name="Transmitir tela", exact=True).click()
            await video_live(receiver, f"Tela compartilhada por {name}")
        await other.get_by_role("button", name="Entrar na reunião", exact=True).click()
        await video_live(other, "Tela compartilhada por Owner")
        await video_live(other, "Tela compartilhada por Member")
        await expect(member.get_by_role("slider", name="Volume de Other")).to_be_visible()
        await member.get_by_role("button", name="Fixar transmissão de Owner", exact=True).click()
        print("Bidirectional screen and pin passed", flush=True)
        await expect(member.locator('[data-participant="owner"]')).to_have_attribute("data-pinned", "true")
        await member.screenshot(path=str(OUT / "desktop.png"))
        pinned_box = await member.locator('[data-participant="owner"]').bounding_box()
        other_box = await member.locator('[data-participant="other"]').bounding_box()
        assert pinned_box["width"] > 2 * other_box["width"], (pinned_box, other_box)

        # Received audio contains the microphone and shared audio as separate RTP tracks.
        await member.wait_for_function("""() => window.__pcs.some(pc => pc.getReceivers().filter(r => r.track.kind === 'audio' && !r.track.muted).length >= 2)""")
        level100 = await audio_level(member)
        await member.get_by_role("slider", name="Volume de Owner").fill("200")
        level200 = await audio_level(member)
        assert level100 > 0.01 and 1.7 < level200 / level100 < 2.3, (level100, level200)
        await member.get_by_role("button", name="Silenciar Owner para mim", exact=True).click()
        assert await member.get_by_label("Áudio de Owner", exact=True).evaluate("a => a.muted")
        level_muted = await audio_level(member)
        assert level_muted < 0.001, level_muted
        assert await member.get_by_role("slider", name="Volume de Other").input_value() == "100"
        assert not await member.get_by_label("Áudio de Other", exact=True).evaluate("a => a.muted")
        await member.get_by_role("button", name="Ouvir Owner para mim", exact=True).click()
        # Sender microphone mute must preserve the shared sound.
        await owner.get_by_role("button", name="Silenciar microfone", exact=True).click()
        await asyncio.sleep(0.5)
        screen_only = await audio_level(member)
        print(f"Audio RMS: {level100}, {level200}, muted={level_muted}, screen-only={screen_only}", flush=True)
        assert screen_only > 0.015, screen_only

        await member.set_viewport_size({"width": 390, "height": 844})
        await expect(member.get_by_role("slider", name="Volume de Owner")).to_be_in_viewport()
        footer = await member.locator('[data-participant="owner"] .team-call-participant-controls').bounding_box()
        tile = await member.locator('[data-participant="owner"]').bounding_box()
        assert footer["y"] + footer["height"] <= tile["y"] + tile["height"] + 1
        await member.screenshot(path=str(OUT / "mobile.png"))
        assert await member.evaluate("document.documentElement.scrollWidth <= innerWidth")
        await member.set_viewport_size({"width": 1440, "height": 900})
        for sender, receiver, name in [(owner, member, "Owner"), (member, owner, "Member")]:
            await sender.get_by_role("button", name="Parar transmissão de tela", exact=True).click()
            await expect(receiver.get_by_text(f"{name} está sem câmera", exact=True)).to_be_visible()
            assert await receiver.get_by_label(f"Câmera de {name}", exact=True).evaluate("v => v.srcObject === null")
        await expect(member.locator('[data-participant="owner"]')).not_to_have_attribute("data-pinned", "true")
        await member.get_by_role("button", name="Fixar Owner", exact=True).click()
        await owner.get_by_role("button", name="Ativar câmera", exact=True).click()
        await video_live(member, "Câmera de Owner")
        await expect(member.locator('[data-participant="owner"]')).to_have_attribute("data-pinned", "true")
        await owner.get_by_role("button", name="Desativar câmera", exact=True).click()
        await expect(member.get_by_text("Owner está sem câmera", exact=True)).to_be_visible()
        assert await member.get_by_label("Câmera de Owner", exact=True).evaluate("v => v.srcObject === null")
        await owner.get_by_role("button", name="Encerrar reunião", exact=True).click()
        await expect(member.locator(".team-call-shell")).to_have_count(0)
        assert not errors, errors
        result = {"bidirectional_screen": True, "camera_stop_clears_video": True, "screen_stop_clears_video": True,
                  "gain_100_rms": level100, "gain_200_rms": level200, "muted_rms": level_muted,
                  "shared_sound_with_muted_mic_rms": screen_only, "pin_member_and_screen": True,
                  "desktop": "1440x900", "mobile": "390x844", "errors": errors}
        (OUT / "result.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))
        await browser.close()


asyncio.run(main())
