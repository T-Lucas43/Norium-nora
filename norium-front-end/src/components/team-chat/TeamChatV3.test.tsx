import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import TeamMessageText from "./TeamMessageText";
import TeamConversationNavigation from "./TeamConversationNavigation";
import TeamPollCard from "./TeamPollCard";
import TeamStatusDialog from "./TeamStatusDialog";
import TeamResourceCards from "./TeamResourceCards";
import { useMessageWindow } from "./useMessageWindow";
import type { TeamMessage } from "./teamChatTypes";
import type { NoriumUser } from "../../types/auth";

const user = { id: "qa", nome: "Conta Teste" } as NoriumUser;
describe("novo chat da equipe", () => {
  it("renders safe basic formatting and named mentions without raw HTML", () => {
    render(<TeamMessageText text={'**Revisar** @Ana Teste\n\n- item\n\n<script>alert(1)</script>'} mentions={[{ name: "Ana Teste" }]} />);
    expect(screen.getByText("Revisar").tagName).toBe("STRONG");
    expect(screen.getByText("@Ana Teste")).toHaveClass("team-chat-mention-token");
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByRole("listitem")).toHaveTextContent("item");
  });
  it("orders Nora, pinned, subteams and direct and filters mentions", () => {
    render(<TeamConversationNavigation items={[{ id: "team", scope: "team", pinned: true, unreadCount: 2, mentionCount: 1, title: "Time todo" }, { id: "direct:a:qa", scope: "direct", recipientId: "a", pinned: false, unreadCount: 2, title: "Ana Teste" }]} selectedId="" loading={false} pinningId="" user={user} onSelect={vi.fn()} onPin={vi.fn()} onCreate={vi.fn()} onNora={vi.fn()} />);
    const headings = screen.getAllByRole("heading").map((item) => item.textContent);
    expect(headings).toEqual(["Assistente", "Fixadas", "Subequipes", "Mensagens diretas"]);
    fireEvent.click(screen.getByRole("button", { name: "Menções" }));
    expect(screen.getByRole("button", { name: "Abrir conversa Time todo" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abrir conversa Ana Teste" })).not.toBeInTheDocument();
  });
  it("restricted cards expose no open action or private title", () => {
    render(<TeamResourceCards cards={[{ type: "task", id: "hidden", title: "Item restrito", restricted: true }]} />);
    expect(screen.getByText("Item restrito")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abrir" })).not.toBeInTheDocument();
  });
  it("single vote selects one option and keeps results visible", async () => {
    const vote = vi.fn().mockResolvedValue(undefined);
    render(<TeamPollCard poll={{ question: "Qual turno?", multiple: false, options: [{ id: "a", text: "Manhã", userIds: ["qa"] }, { id: "b", text: "Tarde", userIds: [] }] }} userId="qa" onVote={vote} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Tarde 0" })));
    expect(vote).toHaveBeenCalledWith(["b"]);
    expect(screen.getByText("1 pessoa(s) votaram · resultados ao vivo")).toBeInTheDocument();
  });
  it("status saves focus and context privacy preferences", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(<TeamStatusDialog preferences={{}} onSave={save} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Modo foco" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Compartilhar contexto com pessoas autorizadas" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Salvar status" })));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ focus: true, shareContext: false, allowUrgentMentions: true }));
  });
  it("renders a bounded window from five thousand messages", () => {
    const messages = Array.from({ length: 5000 }, (_, index) => ({ id: String(index), text: String(index) })) as TeamMessage[];
    function Fixture() { const list = useRef<HTMLDivElement>(null), bottom = useRef(false); const view = useMessageWindow(messages, list, bottom, true); return <div ref={list}>{view.items.map((message) => <p key={message.id} data-testid="visible-message">{message.text}</p>)}<span data-testid="remaining">{view.bottom}</span></div>; }
    render(<Fixture />);
    expect(screen.getAllByTestId("visible-message").length).toBeLessThan(40);
    expect(Number(screen.getByTestId("remaining").textContent)).toBeGreaterThan(0);
  });
});
