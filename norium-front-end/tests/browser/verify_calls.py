"""Run with the backend venv; requires the calls fixture on ports 5173/8000."""
import asyncio
import json
import time
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
              window.__tones = [];
              window.AudioContext = class extends AC {
                constructor(options) { super({...options, sinkId:{type:'none'}}); window.__audioContexts.push(this); }
                createOscillator() { const tone = super.createOscillator(); const start = tone.start.bind(tone); tone.start = (...args) => { window.__tones.push(tone.frequency.value); return start(...args); }; return tone; }
              };""")
            await page.goto(f"http://127.0.0.1:5173/tests/browser/calls.html?user={user}")
            await expect(page.get_by_text("Conectado", exact=True)).to_be_visible()
        await owner.get_by_role("button", name="Iniciar reunião", exact=True).click()
        # Start recording while no camera or screen exists yet.
        await owner.get_by_role("button", name="Gravar reunião", exact=True).click()
        await expect(owner.get_by_role("button", name="Parar gravação", exact=True)).to_be_visible()
        recording_started = time.monotonic()
        await member.get_by_role("button", name="Entrar na reunião", exact=True).click()
        await expect(owner.get_by_role("slider", name="Volume de Member")).to_be_visible()
        await expect(member.get_by_role("slider", name="Volume de Owner")).to_be_visible()
        print("Two participants connected", flush=True)
        await member.get_by_role("button", name="Levantar a mão", exact=True).click()
        await expect(owner.get_by_label("Mãos levantadas", exact=True)).to_contain_text("1. Member")
        await owner.get_by_role("button", name="Levantar a mão", exact=True).click()
        await expect(member.get_by_label("Mãos levantadas", exact=True)).to_contain_text("2. Owner")
        for page in [owner, member]:
            await page.get_by_role("button", name="Abrir chat da reunião", exact=True).click()
        await owner.get_by_placeholder("Digite uma mensagem", exact=True).fill("Mensagem exclusiva desta reunião")
        await owner.locator('.team-call-chat-composer input[type="file"]').set_input_files({"name":"pauta.txt","mimeType":"text/plain","buffer":b"pauta temporaria"})
        async with owner.expect_response(lambda response: response.request.method == "POST" and "/calls/" in response.url and response.url.endswith("/messages")) as sent:
            await owner.get_by_role("button", name="Enviar mensagem", exact=True).click()
        temporary_message = (await (await sent.value).json())["message"]
        await expect(member.get_by_text("Mensagem exclusiva desta reunião", exact=True)).to_be_visible()
        await expect(member.get_by_text("pauta.txt", exact=True)).to_be_visible()
        for page in [owner, member]:
            await page.get_by_role("button", name="Fechar painel", exact=True).click()
        await owner.get_by_role("button", name="Ativar câmera", exact=True).click()
        await video_live(member, "Câmera de Owner")
        await owner.get_by_role("button", name="Desativar câmera", exact=True).click()
        await expect(member.get_by_text("Owner está sem câmera", exact=True)).to_be_visible()
        assert await member.get_by_label("Câmera de Owner", exact=True).evaluate("v => v.srcObject === null")

        for sender, receiver, name in [(owner, member, "Owner"), (member, owner, "Member")]:
            await sender.get_by_role("button", name="Transmitir tela", exact=True).click()
            await video_live(receiver, f"Tela compartilhada por {name}")
        await asyncio.sleep(1)
        blue_at = time.monotonic() - recording_started - 0.4
        await owner.wait_for_function("window.__tones.filter(x => x === 990).length === 2")
        await member.wait_for_function("window.__tones.filter(x => x === 990).length === 2")
        await owner.get_by_role("button", name="Trocar tela ou janela", exact=True).click()
        await owner.wait_for_function("window.__displayStreams.length === 2 && window.__displayStreams[0].getTracks().every(t => t.readyState === 'ended')")
        await member.wait_for_function("""() => {
          const v = document.querySelector('video[aria-label="Tela compartilhada por Owner"]');
          if (!v || v.readyState < 2) return false;
          const c = document.createElement('canvas'); c.width=640;c.height=360;const ctx=c.getContext('2d');ctx.drawImage(v,0,0,640,360);
          const p=ctx.getImageData(400,250,1,1).data;return p[0]>100 && p[2]>130;
        }""")
        await owner.evaluate("window.__cancelNextDisplay = true")
        await owner.get_by_role("button", name="Trocar tela ou janela", exact=True).click()
        await expect(owner.get_by_label("Prévia da sua tela compartilhada", exact=True)).to_be_visible()
        assert await owner.evaluate("window.__displayStreams.length === 2 && window.__displayStreams[1].getTracks().every(t => t.readyState === 'live')")
        assert await owner.evaluate("window.__pcs.filter(pc=>pc.connectionState === 'connected').every(pc=>pc.getSenders().filter(s=>s.track?.kind === 'video').length === 1)")
        await other.get_by_role("button", name="Entrar na reunião", exact=True).click()
        await expect(other.get_by_label("Mãos levantadas", exact=True)).to_contain_text("1. Member")
        await other.get_by_role("button", name="Abrir chat da reunião", exact=True).click()
        await expect(other.get_by_text("Mensagem exclusiva desta reunião", exact=True)).to_be_visible()
        await other.get_by_role("button", name="Fechar painel", exact=True).click()
        assert await owner.evaluate("window.__tones.filter(x => x === 990).length") == 2
        assert await member.evaluate("window.__tones.filter(x => x === 990).length") == 2
        await member.get_by_role("button", name="Baixar a mão", exact=True).click()
        await expect(owner.get_by_label("Mãos levantadas", exact=True)).not_to_contain_text("Member")
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
        await member.get_by_role("button", name="Minimizar chamada", exact=True).click()
        await expect(member.get_by_label("Chamada minimizada", exact=True)).to_be_visible()
        assert await audio_level(member) > 0.015
        await member.screenshot(path=str(OUT / "minimized.png"))
        await member.get_by_role("button", name="Restaurar chamada", exact=True).click()
        assert await member.get_by_role("slider", name="Volume de Owner").input_value() == "200"
        await owner.get_by_role("button", name="Minimizar chamada", exact=True).click()
        await video_live(member, "Tela compartilhada por Owner")
        await asyncio.sleep(1)
        purple_at = time.monotonic() - recording_started - 0.4
        await owner.get_by_role("button", name="Restaurar chamada", exact=True).click()
        async with owner.expect_response(lambda r: r.request.method == "POST" and r.url.endswith("/complete")) as finished:
            await owner.get_by_role("button", name="Parar gravação", exact=True).click()
        complete = await finished.value
        assert complete.ok, await complete.text()
        recorded = (await complete.json())["message"]["attachments"][0]
        recording_url = "http://127.0.0.1:8000/api/team-chat/attachments/" + recorded["storedName"]
        media = await owner.request.get(recording_url, headers={"Authorization":"Bearer owner"})
        assert media.ok
        (OUT / "meeting.webm").write_bytes(await media.body())
        recording_check = await owner.evaluate("""async ({url, blueAt, purpleAt}) => {
          const response = await fetch(url,{headers:{Authorization:'Bearer owner'}}); const blob = await response.blob();
          const context = new AudioContext(); const buffer = await context.decodeAudioData(await blob.arrayBuffer());
          const data = buffer.getChannelData(0); const rms = Math.sqrt(data.reduce((sum,x)=>sum+x*x,0)/data.length); await context.close();
          const video=document.createElement('video'); video.muted=true;const objectUrl=URL.createObjectURL(blob);video.src=objectUrl;
          await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=reject;});
          const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');
          const pixels=[];for(const t of [blueAt,purpleAt]) { video.currentTime=t;await new Promise(resolve=>video.onseeked=resolve);ctx.drawImage(video,0,0);pixels.push({remote:[...ctx.getImageData(400,350,1,1).data],local:[...ctx.getImageData(1000,350,1,1).data]}); }
          const result={width:video.videoWidth,height:video.videoHeight,rms,duration:buffer.duration,pixels};video.src='';URL.revokeObjectURL(objectUrl);return result;
        }""", {"url":recording_url,"blueAt":blue_at,"purpleAt":purple_at})
        print(f"Recording: {recording_check}", flush=True)
        assert recording_check["width"] == 1280 and recording_check["height"] == 720
        assert recording_check["rms"] > 0.01
        assert recording_check["pixels"][0]["local"][2] > 100 and recording_check["pixels"][0]["local"][0] < 50
        assert recording_check["pixels"][1]["local"][0] > 100 and recording_check["pixels"][1]["local"][2] > 130
        assert recording_check["pixels"][1]["remote"][2] > 100 and recording_check["pixels"][1]["remote"][0] < 50

        await member.set_viewport_size({"width": 390, "height": 844})
        await expect(member.get_by_role("slider", name="Volume de Owner")).to_be_in_viewport()
        footer = await member.locator('[data-participant="owner"] .team-call-participant-controls').bounding_box()
        tile = await member.locator('[data-participant="owner"]').bounding_box()
        assert footer["y"] + footer["height"] <= tile["y"] + tile["height"] + 1
        preview = await member.locator('.team-call-local-previews').bounding_box()
        assert preview["y"] >= footer["y"] + footer["height"], (preview, footer)
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
        deleted = await owner.request.get("http://127.0.0.1:8000/api/team-chat/attachments/" + temporary_message["attachments"][0]["storedName"], headers={"Authorization":"Bearer owner"})
        assert deleted.status == 404
        await owner.get_by_role("button", name="Iniciar reunião", exact=True).click()
        await owner.get_by_role("button", name="Abrir chat da reunião", exact=True).click()
        await expect(owner.get_by_text("Mensagem exclusiva desta reunião", exact=True)).to_have_count(0)
        await owner.get_by_role("button", name="Encerrar reunião", exact=True).click()
        assert not errors, errors
        result = {"bidirectional_screen": True, "camera_stop_clears_video": True, "screen_stop_clears_video": True,
                  "gain_100_rms": level100, "gain_200_rms": level200, "muted_rms": level_muted,
                  "shared_sound_with_muted_mic_rms": screen_only, "pin_member_and_screen": True,
                  "desktop": "1440x900", "mobile": "390x844", "errors": errors,
                  "temporary_chat":True,"raise_hand":True,"screen_switch_without_duplicate":True,"minimized_audio":True,"screen_start_sound":True,"recording":recording_check}
        (OUT / "result.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))
        await browser.close()


asyncio.run(main())
