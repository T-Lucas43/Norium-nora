import { render } from "@testing-library/react";
import { Wallet } from "lucide-react";
import { describe, expect, it } from "vitest";
import WorkspaceHeader from "./WorkspaceHeader";

describe("WorkspaceHeader", () => {
  it("uses the matching Norium module icon in the page heading", () => {
    const { container } = render(
      <WorkspaceHeader title="Financeiro" description="Resumo financeiro" icon={Wallet} />,
    );

    expect(container.querySelector("img.workspace-icon-image")).not.toBeNull();
    expect(container.querySelector(".workspace-icon svg")).toBeNull();
  });

  it("keeps the supplied Lucide icon as a fallback", () => {
    const { container } = render(
      <WorkspaceHeader title="Módulo futuro" description="Em preparação" icon={Wallet} />,
    );

    expect(container.querySelector("img.workspace-icon-image")).toBeNull();
    expect(container.querySelector(".workspace-icon svg")).not.toBeNull();
  });
});
