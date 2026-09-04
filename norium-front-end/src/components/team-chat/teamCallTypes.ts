import type { CallSessionCommands, CallSessionSnapshot } from "./CallSession";

export function callSessionView(snapshot: CallSessionSnapshot, commands: CallSessionCommands) {
  return {
    ...snapshot,
    acceptIncoming: commands.accept,
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
    toggleHand: commands.toggleHand,
    sendMeetingMessage: commands.sendMeetingMessage,
    selectMicrophone: commands.selectMicrophone,
    selectCamera: commands.selectCamera,
    selectSpeaker: commands.selectSpeaker,
    selectScreenShareQuality: commands.selectScreenShareQuality,
    selectScreenShareFps: commands.selectScreenShareFps,
    refreshDevices: commands.refreshDevices,
  };
}

export type ReturnTypeOfTeamCall = ReturnType<typeof callSessionView>;
