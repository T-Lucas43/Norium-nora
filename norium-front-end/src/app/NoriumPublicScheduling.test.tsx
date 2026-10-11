import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import NoriumApp from "./NoriumApp";
const restoreSession = vi.hoisted(() => vi.fn(() => { throw new Error("Sessão interna não deve montar nesta rota"); }));
vi.mock("./hooks/useAuthSession", () => ({ useAuthSession: restoreSession }));
vi.mock("../components/scheduling/PublicSchedulingPage", () => ({ default: ({ identifier }: { identifier: string }) => <h1>Agendar: {identifier}</h1> }));
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); restoreSession.mockClear(); });
describe("rota pública de agendamento", () => {
  it.each(["/agendar/ahhaaha", "/agendar/ahhaaha/?origem=link", "/agendar/consulta%20online"])("preserva %s sem iniciar navegação do painel", async (path) => {
    window.history.replaceState({ noriumView: "app" }, "", path);
    localStorage.setItem("norium-app-mode", "app");
    render(<NoriumApp/>);
    expect(await screen.findByRole("heading")).toHaveTextContent(/Agendar:/);
    expect(restoreSession).not.toHaveBeenCalled();
    expect(window.location.pathname + window.location.search).toBe(path);
  });
});
