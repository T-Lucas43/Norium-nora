import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Summary from "./Summary";

describe("Summary", () => {
  it("keeps channel images and renders Tarefas as a compact vector", () => {
    render(<Summary metrics={{ emails: 4, whatsapp: 3, calendar: 2, tasks: 1, total: 10 }} onNavigate={vi.fn()} />);

    for (const name of ["E-mails", "WhatsApp", "Agenda"]) {
      expect(screen.getByRole("button", { name: new RegExp(name) }).querySelector("img.norium-suite-icon")).not.toBeNull();
    }
    const tasks = screen.getByRole("button", { name: /Tarefas/ });
    expect(tasks.querySelector("img")).toBeNull();
    expect(tasks.querySelector("svg")).not.toBeNull();
  });
});
