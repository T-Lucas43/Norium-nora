type RecordingSource = { id: string; label: string; stream: MediaStream; visible: boolean; screen: boolean };

// Read current sources on every frame: a screen can start, stop or change after REC.
export function createMeetingRecording(getSources: () => RecordingSource[]) {
  if (!window.AudioContext) throw new Error("O navegador não oferece mixagem de áudio para gravação.");
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  if (!context || typeof canvas.captureStream !== "function") throw new Error("Este navegador não permite gravar a tela da reunião.");
  const audioContext = new AudioContext();
  void audioContext.resume().catch(() => undefined);
  const destination = audioContext.createMediaStreamDestination();
  const audio = new Map<string, { source: MediaStreamAudioSourceNode; receiver: HTMLAudioElement }>();
  const videos = new Map<string, HTMLVideoElement>();
  const canvasStream = canvas.captureStream(24);
  const output = new MediaStream([...canvasStream.getVideoTracks(), ...destination.stream.getAudioTracks()]);
  const releaseAudio = (id: string) => {
    const item = audio.get(id);
    if (item) { item.source.disconnect(); item.receiver.pause(); item.receiver.srcObject = null; audio.delete(id); }
  };
  const draw = () => {
    const sources = getSources();
    const tracks = new Map(sources.flatMap(({ stream }) => stream.getAudioTracks()).filter((track) => track.readyState !== "ended").map((track) => [track.id, track]));
    audio.forEach((_, id) => { if (!tracks.has(id)) releaseAudio(id); });
    tracks.forEach((track, id) => {
      if (audio.has(id)) return;
      const stream = new MediaStream([track]);
      // Chromium needs a media consumer to deliver incoming RTP to Web Audio.
      const receiver = new Audio(); receiver.muted = true; receiver.srcObject = stream;
      void receiver.play().catch(() => undefined);
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(destination);
      audio.set(id, { source, receiver });
    });
    const visible = sources.filter((source) => source.visible && source.stream.getVideoTracks().some((track) => track.enabled && track.readyState !== "ended" && !track.muted));
    const screens = visible.filter((source) => source.screen);
    const displayed = screens.length ? screens : visible;
    videos.forEach((video, id) => {
      if (!displayed.some((source) => source.id === id)) { video.pause(); video.srcObject = null; videos.delete(id); }
    });
    context.fillStyle = "#090b0e";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const columns = Math.max(1, Math.ceil(Math.sqrt(displayed.length)));
    const rows = Math.max(1, Math.ceil(displayed.length / columns));
    const width = canvas.width / columns, height = canvas.height / rows;
    displayed.forEach((source, index) => {
      let video = videos.get(source.id);
      if (!video || video.srcObject !== source.stream) {
        if (video) { video.pause(); video.srcObject = null; }
        video = document.createElement("video"); video.muted = true; video.playsInline = true;
        video.srcObject = source.stream; void video.play().catch(() => undefined); videos.set(source.id, video);
      }
      const x = (index % columns) * width, y = Math.floor(index / columns) * height;
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        const scale = Math.min(width / video.videoWidth, height / video.videoHeight);
        const w = video.videoWidth * scale, h = video.videoHeight * scale;
        context.drawImage(video, x + (width - w) / 2, y + (height - h) / 2, w, h);
      }
      context.fillStyle = "rgba(0,0,0,.65)";
      context.fillRect(x + 12, y + height - 42, Math.min(width - 24, 340), 30);
      context.fillStyle = "#fff"; context.font = "600 16px Arial";
      context.fillText(source.label, x + 22, y + height - 22, width - 44);
    });
    if (!displayed.length) {
      context.fillStyle = "#fff"; context.font = "600 26px Arial"; context.textAlign = "center";
      context.fillText("Reunião em andamento · áudio sendo gravado", canvas.width / 2, canvas.height / 2);
      context.textAlign = "start";
    }
  };
  draw();
  const timer = window.setInterval(draw, 1000 / 24);
  return { stream: output, cleanup: () => {
    window.clearInterval(timer);
    videos.forEach((video) => { video.pause(); video.srcObject = null; });
    audio.forEach((_, id) => releaseAudio(id));
    output.getTracks().forEach((track) => track.stop());
    void audioContext.close();
  } };
}
