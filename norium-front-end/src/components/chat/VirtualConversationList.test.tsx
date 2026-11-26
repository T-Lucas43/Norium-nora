import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import VirtualConversationList from "./VirtualConversationList";
import type { ChatConversa } from "./types";

describe("lista virtualizada", () => {
  it("limita o DOM de 2.000 conversas e muda a janela ao rolar", () => {
    const items = Array.from({ length: 2000 }, (_, index) => ({ id: String(index) }) as ChatConversa);
    const { container } = render(<VirtualConversationList items={items} renderItem={item => <button key={item.id}>Contato {item.id}</button>} />);
    expect(screen.getAllByRole("button").length).toBeLessThan(25);
    expect(screen.getByText("Contato 0")).toBeInTheDocument();
    const list = container.firstElementChild!;
    fireEvent.scroll(list, { target: { scrollTop: 92 * 1000 } });
    expect(screen.queryByText("Contato 0")).not.toBeInTheDocument();
    expect(screen.getByText("Contato 1000")).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeLessThan(25);
  });
  it("pede outra página perto do fim", () => {
    const onReachEnd = vi.fn();
    const { container } = render(<VirtualConversationList items={[]} renderItem={() => null} onReachEnd={onReachEnd} />);
    fireEvent.scroll(container.firstElementChild!, { target: { scrollTop: 500 } });
    expect(onReachEnd).toHaveBeenCalledOnce();
  });
});
