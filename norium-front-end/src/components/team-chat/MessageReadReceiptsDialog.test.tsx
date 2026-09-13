import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MessageReadReceiptsDialog from "./MessageReadReceiptsDialog";

describe("MessageReadReceiptsDialog", () => {
  it("mostra quantas pessoas viram e a hora de cada leitura", () => {
    render(<MessageReadReceiptsDialog messageText="Fechamos a proposta." readBy={[{ userId: "member-1", userName: "Maria", viewedAt: "2026-09-01T15:20:00Z" }, { userId: "member-2", userName: "João", viewedAt: "2026-09-01T15:22:00Z" }]} onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "2 pessoa(s) viram" })).toBeInTheDocument();
    expect(screen.getByText("Maria")).toBeInTheDocument();
    expect(screen.getByText("João")).toBeInTheDocument();
    expect(screen.getAllByText(/01\/09\/2026/)).toHaveLength(2);
  });
});
