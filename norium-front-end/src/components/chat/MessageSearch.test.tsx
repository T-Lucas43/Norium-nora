import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import MessageSearch, { HighlightedText, useMessageSearch } from "./MessageSearch";

const messages = [
  { id: "a", remetente: "contato" as const, tipo: "texto" as const, texto: "Orçamento inicial", horario: "10:00" },
  { id: "b", remetente: "usuario" as const, tipo: "texto" as const, texto: "Bom dia", horario: "10:01" },
  { id: "c", remetente: "contato" as const, tipo: "texto" as const, texto: "Outro orçamento", horario: "10:02" },
];
function Fixture({ id = "chat-a" }: { id?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const search = useMessageSearch(messages, id, ref);
  return <><MessageSearch search={search} hasOlder onClose={() => search.setQuery("")} />
    <div ref={ref}>{messages.map(message => <p data-message-id={message.id} key={message.id} data-active={search.activeId === message.id}>
      <HighlightedText text={message.texto} query={search.query} />
    </p>)}</div></>;
}
describe("busca na conversa", () => {
  it("destaca texto, mantém contexto e navega entre os resultados", () => {
    const { container } = render(<Fixture />);
    fireEvent.change(screen.getByRole("textbox", { name: "Buscar nesta conversa" }), { target: { value: "orçamento" } });
    expect(screen.getByRole("status")).toHaveTextContent("1 de 2");
    expect(container.querySelectorAll("mark")).toHaveLength(2);
    expect(screen.getByText("Bom dia")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Próximo resultado" }));
    expect(screen.getByRole("status")).toHaveTextContent("2 de 2");
    expect(container.querySelector('[data-message-id="c"]')).toHaveAttribute("data-active", "true");
    fireEvent.click(screen.getByRole("button", { name: "Próximo resultado" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 de 2");
  });
  it("reinicia ao trocar conversa e não interpreta HTML da busca", () => {
    const { rerender } = render(<Fixture />);
    const input = screen.getByRole("textbox", { name: "Buscar nesta conversa" });
    fireEvent.change(input, { target: { value: "<img>" } });
    expect(screen.getByRole("status")).toHaveTextContent("0 de 0");
    expect(screen.getByRole("button", { name: "Próximo resultado" })).toBeDisabled();
    rerender(<Fixture id="chat-b" />);
    expect(input).toHaveValue("");
  });
});
