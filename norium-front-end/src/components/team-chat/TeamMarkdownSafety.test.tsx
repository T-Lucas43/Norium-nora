import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import TeamMessageText from "./TeamMessageText";
import { NoraMarkdown } from "../nora/NoraResponseContent";

describe("Imagens externas no contexto do Chat", () => {
  it("texto do Chat não carrega imagens de terceiros", () => {
    const view = render(<TeamMessageText text="![Prévia externa](https://external.example.test/image)" mentions={[]} />);
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByText("Prévia externa")).toBeVisible();
  });
  it("resumo contextual da Nora mostra apenas a descrição da imagem", () => {
    const view = render(<NoraMarkdown allowImages={false} text="![Imagem contextual](https://external.example.test/image)" />);
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByText("Imagem contextual")).toBeVisible();
  });
});
