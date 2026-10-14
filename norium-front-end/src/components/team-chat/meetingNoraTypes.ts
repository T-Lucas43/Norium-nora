export type MeetingTranscriptSegment = { id: string; callId: string; userId: string; start: number; end: number; text: string };
export type MeetingFact = { segment_id: string; quote: string; user_id: string; start: number; end: number; assignee_id?: string | null; deadline_text?: string | null };
export type MeetingUnderstanding = { summary: MeetingFact[]; decisions: MeetingFact[]; tasks: MeetingFact[]; questions: MeetingFact[] };
export type MeetingNoraView = { callId: string; sequence: number; revision: number; expiresAt: string; volatile: boolean; segments: MeetingTranscriptSegment[]; visibleSegmentCount: number; understanding: MeetingUnderstanding };
export type MeetingPrivateAnswer = { recipientUserId: string; private: true; text: string; sources: Array<{ module: string; segmentId: string; userId: string; start: number; quote: string }> };

export function mergeMeetingTranscript(current: MeetingTranscriptSegment[], incoming: MeetingTranscriptSegment[], callId: string) {
  const valid = incoming.filter((segment) => segment.callId === callId && typeof segment.id === "string" && segment.id.length <= 100
    && typeof segment.userId === "string" && typeof segment.text === "string" && segment.text.length <= 2000
    && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.start >= 0 && segment.end > segment.start);
  return Array.from(new Map([...current, ...valid].map((segment) => [segment.id, segment])).values())
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id)).slice(-200);
}
