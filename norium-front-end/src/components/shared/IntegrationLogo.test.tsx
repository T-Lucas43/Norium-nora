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

  it.each(["E-mails", "WhatsApp", "Agenda"])("supports a monochrome transparent vector for %s", (name) => {
    const { container } = render(<IntegrationLogo name={name} monochrome className="sidebar-blue" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg.sidebar-blue")).not.toBeNull();
  });

  it("uses a scheduling icon distinct from the Agenda calendar", () => {
    const agenda = render(<IntegrationLogo name="Agenda" monochrome />);
    const scheduling = render(<IntegrationLogo name="Agendamentos" monochrome />);

    expect(agenda.container.querySelector(".lucide-calendar-days")).not.toBeNull();
    expect(scheduling.container.querySelector(".lucide-clock-3")).not.toBeNull();
  });
});
