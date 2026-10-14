// Vendor-independent attachment seam. The SFU SDK needs the actual element
// for adaptive stream visibility and dimensions; raw srcObject alone is insufficient.
const bindings = new WeakMap<MediaStreamTrack, (element: HTMLVideoElement) => () => void>();
export function registerRemoteVideoBinding(track: MediaStreamTrack, bind: (element: HTMLVideoElement) => () => void) { bindings.set(track, bind); }
export function unregisterRemoteVideoBinding(track: MediaStreamTrack) { bindings.delete(track); }
export function bindRemoteVideo(track: MediaStreamTrack, element: HTMLVideoElement) { return bindings.get(track)?.(element); }
