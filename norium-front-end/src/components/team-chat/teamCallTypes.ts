import type { CallSessionCommands, CallSessionSnapshot } from "./CallSession";

export function callSessionView(snapshot: CallSessionSnapshot, commands: CallSessionCommands) {
  return {
    ...snapshot,
    acceptIncoming: commands.accept,
    enterCall: commands.enter,
    cancelEntry: commands.cancelEntry,
    setEntryMicrophoneMode: commands.setEntryMicrophoneMode,
    setEntryCameraEnabled: commands.setEntryCameraEnabled,
    setEntryPreviewEnabled: commands.setEntryPreviewEnabled,
    rejectIncoming: commands.reject,
    endCall: commands.end,
    leaveCall: commands.leave,
    toggleMute: commands.toggleMute,
    toggleCamera: commands.toggleCamera,
    requestCameraPermission: commands.requestCameraPermission,
    toggleScreenShare: commands.toggleScreenShare,
    changeScreenShare: commands.changeScreenShare,
    startRecording: commands.startRecording,
    stopRecording: commands.stopRecording,
    sendReaction: commands.sendReaction,
    removeParticipant: commands.removeParticipant,
    updateStage: commands.updateStage,
    updateNora: commands.updateNora,
    updateVideoInterest: commands.updateVideoInterest,
    toggleHand: commands.toggleHand,
    sendMeetingMessage: commands.sendMeetingMessage,
    selectMicrophone: commands.selectMicrophone,
    selectCamera: commands.selectCamera,
    selectSpeaker: commands.selectSpeaker,
    setNoiseSuppression: commands.setNoiseSuppression,
    setMicrophoneSensitivity: commands.setMicrophoneSensitivity,
    setBackgroundBlur: commands.setBackgroundBlur,
    selectScreenShareQuality: commands.selectScreenShareQuality,
    selectScreenShareFps: commands.selectScreenShareFps,
    refreshDevices: commands.refreshDevices,
  };
}

export type ReturnTypeOfTeamCall = ReturnType<typeof callSessionView>;
