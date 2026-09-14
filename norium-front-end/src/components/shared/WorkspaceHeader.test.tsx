import { render } from "@testing-library/react";
import { Wallet } from "lucide-react";
import { describe, expect, it } from "vitest";
import WorkspaceHeader from "./WorkspaceHeader";

describe("WorkspaceHeader", () => {
  it("uses the supplied compact vector icon in the page heading", () => {
    const { container } = render(
      <WorkspaceHeader title="Financeiro" description="Resumo financeiro" icon={Wallet} />,
    );

    expect(container.querySelector("img.workspace-icon-image")).toBeNull();
    expect(container.querySelector(".workspace-icon svg")).not.toBeNull();
  });

  it("keeps the same vector behavior for future modules", () => {
    const { container } = render(
      <WorkspaceHeader title="Módulo futuro" description="Em preparação" icon={Wallet} />,
    );

    expect(container.querySelector("img.workspace-icon-image")).toBeNull();
    expect(container.querySelector(".workspace-icon svg")).not.toBeNull();
  });
});
