import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import IntegrationLogo from "./IntegrationLogo";

describe("IntegrationLogo", () => {
  it.each(["Norium Mail", "WhatsApp", "Agenda"])("keeps the approved image for %s", (name) => {
    const { container } = render(<IntegrationLogo name={name} />);
    expect(container.querySelector("img.norium-suite-icon")).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it.each(["Tarefas", "Financeiro", "Automações", "Estúdio", "Chat da Equipe"])("uses a transparent vector for %s", (name) => {
    const { container } = render(<IntegrationLogo name={name} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
