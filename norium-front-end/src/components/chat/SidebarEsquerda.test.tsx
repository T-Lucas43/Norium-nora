import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import SidebarEsquerda from "./SidebarEsquerda";

describe("sincronização PRO do WhatsApp", () => {
  it("mantém aviso acionável mesmo quando o fallback conclui a sincronização", async () => {
    const user = userEvent.setup();
    const onAbrirConfigPropria = vi.fn();
    render(
      <SidebarEsquerda
        conversas={[]}
        conversaSelecionada={null}
        onSelecionar={vi.fn()}
        onAcao={vi.fn()}
        onExcluir={vi.fn()}
        onAbrirConfigPropria={onAbrirConfigPropria}
        onAbrirModalContatos={vi.fn()}
        onAbrirModalCriarGrupo={vi.fn()}
        onAtualizar={vi.fn()}
        sincronizando={false}
        syncProgress={{ status: "complete", progress: 100, requiresPro: true, reconnectRequired: true }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("A agenda completa exige uma instância W-API PRO.");
    expect(screen.getByRole("alert")).toHaveTextContent("desconecte e conecte o WhatsApp novamente");
    await user.click(screen.getByRole("button", { name: "Abrir configurações para reconectar" }));
    expect(onAbrirConfigPropria).toHaveBeenCalledTimes(1);
  });

  it("mostra warnings do resultado parcial e permite atualizar novamente", async () => {
    const user = userEvent.setup();
    const onAtualizar = vi.fn();
    render(
      <SidebarEsquerda
        conversas={[]}
        conversaSelecionada={null}
        onSelecionar={vi.fn()}
        onAcao={vi.fn()}
        onExcluir={vi.fn()}
        onAbrirConfigPropria={vi.fn()}
        onAbrirModalContatos={vi.fn()}
        onAbrirModalCriarGrupo={vi.fn()}
        onAtualizar={onAtualizar}
        sincronizando={false}
        syncProgress={{ status: "partial", progress: 99, message: "Conversas carregadas; contatos incompletos.", catalogWarnings: ["Contatos PRO indisponíveis"] }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Sincronização parcial do WhatsApp");
    expect(screen.getByRole("alert")).toHaveTextContent("Conversas carregadas; contatos incompletos.");
    expect(screen.getByRole("alert")).toHaveTextContent("Contatos PRO indisponíveis");
    await user.click(screen.getByRole("button", { name: "Atualizar novamente" }));
    expect(onAtualizar).toHaveBeenCalledTimes(1);
  });
});
