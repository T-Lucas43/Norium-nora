import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import ChatWallpaperSettings from "./ChatWallpaperSettings";

describe("configuração do fundo das conversas", () => {
  it("envia uma imagem escolhida na galeria", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ChatWallpaperSettings
        preference={null}
        saving={false}
        onSelect={onSelect}
        onRestoreDefault={vi.fn()}
      />,
    );
    const file = new File(["imagem"], "galeria.png", { type: "image/png" });

    await user.upload(screen.getByLabelText("Escolher imagem de fundo"), file);

    expect(onSelect).toHaveBeenCalledWith(file);
  });

  it("mostra a prévia e permite restaurar o fundo padrão", async () => {
    const user = userEvent.setup();
    const onRestoreDefault = vi.fn();
    const preference = { dataUrl: "data:image/png;base64,AAAA", fileName: "paisagem.png", updatedAt: 1 };
    render(
      <ChatWallpaperSettings
        preference={preference}
        saving={false}
        onSelect={vi.fn()}
        onRestoreDefault={onRestoreDefault}
      />,
    );

    expect(screen.getByTestId("chat-wallpaper-preview")).toHaveStyle({ backgroundImage: expect.stringContaining(preference.dataUrl) });
    expect(screen.getByText("paisagem.png")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restaurar padrão" }));
    expect(onRestoreDefault).toHaveBeenCalledTimes(1);
  });
});
