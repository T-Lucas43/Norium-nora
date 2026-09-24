import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SystemNotificationToast } from "../../types/omnichannel";
import SystemNotificationToasts from "./SystemNotificationToasts";

function toast(id: string): SystemNotificationToast {
  return {
    id,
    createdAt: Date.now(),
    notification: {
      id: `notification-${id}`,
      title: `Aviso ${id}`,
      description: `Descricao ${id}`,
      timestamp: "2026-08-19T12:00:00+00:00",
      severity: "info",
      read: false,
    },
  };
}

describe("SystemNotificationToasts", () => {
  it("mostra apenas uma notificacao por vez", () => {
    const { container } = render(
      <SystemNotificationToasts
        toasts={[toast("1"), toast("2"), toast("3")]}
        onDismiss={vi.fn()}
        onOpenNotifications={vi.fn()}
      />,
    );

    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(container).toHaveTextContent("Aviso 1");
    expect(container).not.toHaveTextContent("Aviso 2");
  });
});

it("hides private alert content and applies the selected position", () => {
  const { container } = render(<SystemNotificationToasts toasts={[toast("private")]} onDismiss={vi.fn()} onOpenNotifications={vi.fn()} preferences={{ navigationStyle: "grouped", textSize: "normal", reducedMotion: true, strongFocus: false, underlineLinks: false, showGuides: true, showToasts: true, toastPreview: false, toastPosition: "bottom" }} />);
  expect(container).toHaveTextContent("Nova notificação");
  expect(container).not.toHaveTextContent("Aviso private");
  expect(container).not.toHaveTextContent("Descricao private");
  expect(container.firstChild).toHaveClass("bottom-5");
});
