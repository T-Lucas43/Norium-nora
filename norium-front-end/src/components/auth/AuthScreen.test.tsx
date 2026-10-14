import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuthScreen from "./AuthScreen";
import { passwordSession } from "../../core/api/cookieSession";
import { navigateNoriumView } from "../../app/navigation/view";
import type { AuthSession } from "../../types/auth";

const fakeSession = (modes: string[]) => ({ token: "t", user: { id: "u" }, availableModes: modes }) as unknown as AuthSession;

vi.mock("../../core/api/cookieSession", () => ({ passwordSession: vi.fn() }));
vi.mock("../../utils/authApi", () => ({ authJson: vi.fn() }));
vi.mock("../../app/navigation/view", () => ({ navigateNoriumView: vi.fn() }));
vi.mock("../../core/api/client", () => ({ apiRequest: vi.fn() }));
const login = vi.mocked(passwordSession);
const navigate = vi.mocked(navigateNoriumView);

beforeEach(() => { login.mockReset(); navigate.mockReset(); });

describe("AuthScreen", () => {
  it("keeps labelled login fields, password toggle, persistence and Enter submit", async () => {
    login.mockResolvedValue(fakeSession(["app"]));
    const done = vi.fn();
    render(<AuthScreen onAuthenticated={done} />);
    const email = screen.getByLabelText("E-mail");
    const password = screen.getByLabelText("Senha");
    expect(email).toHaveAttribute("autocomplete", "username");
    expect(email).toHaveAttribute("name", "username");
    expect(email).toHaveAttribute("autocapitalize", "none");
    expect(email).toHaveAttribute("spellcheck", "false");
    expect(password).toHaveAttribute("autocomplete", "current-password");
    expect(password).toHaveAttribute("name", "current-password");
    fireEvent.click(screen.getByRole("button", { name: "Mostrar senha" }));
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Ocultar senha" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByLabelText("Manter conectado neste navegador por até 7 dias"));
    fireEvent.change(email, { target: { value: "a@b.invalid" } });
    fireEvent.change(password, { target: { value: "segredo" } });
    fireEvent.keyDown(password, { key: "Enter" });
    await waitFor(() => expect(done).toHaveBeenCalledWith(expect.objectContaining({ token: "t" }), "app"));
    expect(login).toHaveBeenCalledWith("/api/auth/login", { email: "a@b.invalid", password: "segredo", persistent: false });
  });

  it("validates registration locally and keeps legal links", () => {
    render(<AuthScreen onAuthenticated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Criar novo cadastro" }));
    expect(screen.getByLabelText("Senha")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Senha")).toHaveAttribute("name", "new-password");
    expect(screen.getByLabelText("Nome")).toHaveAttribute("name", "name");
    const submit = screen.getByRole("button", { name: "Criar conta" });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Li e aceito/ }));
    fireEvent.click(submit);
    expect(screen.getByRole("alert")).toHaveTextContent("Informe seu nome com pelo menos 2 caracteres.");
    expect(login).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("link", { name: "Política de Privacidade" })[0]);
    expect(navigate).toHaveBeenCalledWith("privacy");
    fireEvent.click(screen.getByRole("button", { name: "Já tenho acesso" }));
    expect(screen.getByRole("heading", { name: "Entrar" })).toBeInTheDocument();
  });

  it("opens password recovery", () => {
    render(<AuthScreen onAuthenticated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Esqueci minha senha" }));
    expect(screen.getByRole("heading", { name: "Recupere seu acesso" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar link de recuperação" })).toBeInTheDocument();
  });

  it("offers both modes to a main admin account", async () => {
    const session = fakeSession(["app", "admin"]);
    login.mockResolvedValue(session);
    const done = vi.fn();
    render(<AuthScreen onAuthenticated={done} />);
    fireEvent.click(screen.getByRole("button", { name: /Entrar no Norium/ }));
    expect(await screen.findByText("Acesso principal reconhecido")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Gerenciar sistema/ }));
    expect(done).toHaveBeenCalledWith(session, "admin");
    fireEvent.click(screen.getByRole("button", { name: /Usar sistema/ }));
    expect(done).toHaveBeenLastCalledWith(session, "app");
  });
});
