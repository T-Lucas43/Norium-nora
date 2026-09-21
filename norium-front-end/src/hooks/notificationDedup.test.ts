// Tarefa 2: identidade estável de notificações — mesma ocorrência lógica
// chega uma vez; ocorrência nova ou atualização material continua aparecendo.
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEDUP_STORE_CAP,
  forgetIds,
  isDuplicateNotification,
  loadPersistedDedup,
  notificationIdForEvent,
  rememberId,
  shouldShowToast,
  systemMessageStableId,
} from "./notificationDedup";

beforeEach(() => {
  localStorage.clear();
});

describe("notificationIdForEvent", () => {
  it("usa messageId para mensagem da equipe (dois canais, mesmo id)", () => {
    const id = notificationIdForEvent({
      id: "evt_aleatorio_1",
      source: "equipe",
      metadata: { action: "team_message_created", messageId: "team_msg_abc" },
    });
    expect(id).toBe("notification_team_team_msg_abc");
    // O inbox pode registrar outro evt_id para a mesma mensagem; o id segue estável.
    expect(
      notificationIdForEvent({
        id: "evt_aleatorio_2",
        source: "equipe",
        metadata: { action: "team_message_created", messageId: "team_msg_abc" },
      }),
    ).toBe(id);
  });

  it("usa o id do evento nos demais canais (gmail/agenda/sistema)", () => {
    expect(
      notificationIdForEvent({ id: "gmail_u1_inbox_m1", source: "gmail", metadata: {} }),
    ).toBe("notification_gmail_u1_inbox_m1");
    expect(
      notificationIdForEvent({ id: "calendar_google_u1_g1", source: "calendar", metadata: {} }),
    ).toBe("notification_calendar_google_u1_g1");
  });
});

describe("systemMessageStableId", () => {
  it("prefere o id explícito do backend", () => {
    expect(systemMessageStableId({ id: "notification_approval_requested_a1" })).toBe(
      "notification_approval_requested_a1",
    );
  });

  it("deriva de approvalId/messageId/eventId quando não há id", () => {
    expect(systemMessageStableId({ metadata: { approvalId: "a1", action: "approval_requested" } })).toBe(
      "notification_approval_approval_requested_a1",
    );
    expect(systemMessageStableId({ metadata: { messageId: "team_msg_x" } })).toBe(
      "notification_team_team_msg_x",
    );
    expect(systemMessageStableId({ metadata: { eventId: "g1", action: "upd" } })).toBe(
      "notification_upd_g1",
    );
  });

  it("retorna null sem identidade estável (não silencia erros distintos)", () => {
    expect(systemMessageStableId({ title: "Falha genérica" })).toBeNull();
    expect(systemMessageStableId({})).toBeNull();
  });
});

describe("isDuplicateNotification / shouldShowToast", () => {
  it("detecta notificação já presente pelo id", () => {
    const current = [{ id: "notification_a" }];
    expect(isDuplicateNotification(current, "notification_a")).toBe(true);
    expect(isDuplicateNotification(current, "notification_b")).toBe(false);
  });

  it("não reexibe toast já exibido ou dispensado", () => {
    const toasted = new Set(["toast_notification_a"]);
    const dismissed = new Set(["toast_notification_b"]);
    expect(shouldShowToast([], "toast_notification_a", toasted, dismissed)).toBe(false);
    expect(shouldShowToast([], "toast_notification_b", toasted, dismissed)).toBe(false);
    expect(shouldShowToast([], "toast_notification_c", toasted, dismissed)).toBe(true);
    expect(
      shouldShowToast([{ id: "toast_notification_c" }], "toast_notification_c", new Set(), new Set()),
    ).toBe(false);
  });
});

describe("persistência isolada por usuário", () => {
  it("lembra ids com isolamento e esquece sob demanda", () => {
    rememberId("notified", "ana", "notification_a");
    expect(loadPersistedDedup("ana").notified.has("notification_a")).toBe(true);
    expect(loadPersistedDedup("bia").notified.has("notification_a")).toBe(false);

    forgetIds("ana", ["notification_a"]);
    expect(loadPersistedDedup("ana").notified.has("notification_a")).toBe(false);
  });

  it("limita o crescimento do armazenamento", () => {
    for (let i = 0; i < DEDUP_STORE_CAP + 10; i += 1) rememberId("notified", "ana", `n${i}`);
    expect(loadPersistedDedup("ana").notified.size).toBeLessThanOrEqual(DEDUP_STORE_CAP);
  });
});
