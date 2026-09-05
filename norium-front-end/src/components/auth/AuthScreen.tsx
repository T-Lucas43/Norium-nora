import { useState } from "react";
import { ArrowRight, LockKeyhole, ShieldCheck, Sparkles, UserPlus } from "lucide-react";
import type { AppMode, AuthSession, UserPlan } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import BrandLogo from "../layout/BrandLogo";
import AccountEmailAction from "./AccountEmailAction";
import { navigateNoriumView } from "../../app/navigation/view";

interface AuthScreenProps {
  onAuthenticated: (session: AuthSession, mode: AppMode) => void;
}

type FormMode = "login" | "register";

const planOptions: Array<{ code: UserPlan; name: string; price: string; description: string; features: string[] }> = [
  { code: "free", name: "Free", price: "R$ 0", description: "Para testar o Norium com tarefas e central.", features: ["Dashboard", "Central", "Tarefas", "Perfil"] },
  { code: "individual", name: "Individual", price: "R$ 79", description: "Operação completa para uma conta.", features: ["Gmail", "Agenda", "Chat", "Gastos", "Nora"] },
  { code: "equipe", name: "Equipe", price: "R$ 179", description: "Usuários menores e permissões por módulo.", features: ["Modo equipe", "Chat interno", "Permissões", "Integrações"] },
  { code: "enterprise", name: "Enterprise", price: "R$ 399", description: "Governança e liberações avançadas.", features: ["Tudo do Equipe", "Tema personalizado", "Auditoria", "Admin assistido"] },
];

export default function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<FormMode>("login");
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [pendingSession, setPendingSession] = useState<AuthSession | null>(null);
  const [planSession, setPlanSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [forgot, setForgot] = useState(false);

  async function submit() {
    setError("");
    if (mode === "register") {
      if (nome.trim().length < 2) {
        setError("Informe seu nome com pelo menos 2 caracteres.");
        return;
      }
      if (password.length < 10) {
        setError("A senha deve ter pelo menos 10 caracteres.");
        return;
      }
      if (!legalAccepted) {
        setError("Aceite os Termos de Uso e a Politica de Privacidade para criar a conta.");
        return;
      }
    }
    setLoading(true);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload = mode === "login"
        ? { email, password }
        : { nome, email, password, acceptedTerms: true, acceptedPrivacy: true };
      const session = await authJson<AuthSession>(endpoint, undefined, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (session.user.requiresPlanSelection) {
        setPlanSession(session);
      } else if (session.availableModes.includes("admin")) {
        setPendingSession(session);
      } else {
        onAuthenticated(session, "app");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível entrar.");
    } finally {
      setLoading(false);
    }
  }

  async function choosePlan(plan: UserPlan) {
    if (!planSession) return;
    setError("");
    setLoading(true);
    try {
      const session = await authJson<AuthSession>("/api/auth/select-plan", planSession.token, {
        method: "POST",
        body: JSON.stringify({ plan }),
      });
      onAuthenticated(session, "app");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível escolher o plano.");
    } finally {
      setLoading(false);
    }
  }

  if (forgot) return <AccountEmailAction mode="forgot" onBack={() => setForgot(false)} />;

  if (planSession) {
    return (
      <main className="norium-modern-shell norium-auth-shell norium-auth-dark min-h-dvh bg-[var(--background)] p-4 text-[var(--text)]">
        <div className="mx-auto flex min-h-[calc(100dvh-32px)] max-w-6xl flex-col justify-center gap-6">
          <div className="text-center">
            <BrandLogo className="mx-auto h-14 w-[148px] text-[var(--text)]" />
            <h1 className="mt-6 text-4xl font-black">Escolha seu plano</h1>
            <p className="mt-2 text-sm font-semibold text-[var(--text-secondary)]">
              As permissões da conta serão aplicadas automaticamente.
            </p>
          </div>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {planOptions.map((plan) => (
              <button
                key={plan.code}
                onClick={() => void choosePlan(plan.code)}
                disabled={loading || plan.code !== "free"}
                className="group rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 text-left shadow-xl shadow-blue-950/16 transition hover:-translate-y-1 hover:border-cyan-300/45 hover:bg-[var(--surface-hover)] disabled:opacity-60"
              >
                <span className="text-sm font-bold text-[var(--primary)]">{plan.price}/mês</span>
                <span className="mt-3 block text-2xl font-black">{plan.name}</span>
                <span className="mt-2 block min-h-12 text-sm font-semibold leading-6 text-[var(--text-secondary)]">{plan.description}</span>
                <span className="mt-5 grid gap-2">
                  {plan.features.map((feature) => (
                    <span key={feature} className="text-xs font-bold text-[var(--text-secondary)]">- {feature}</span>
                  ))}
                </span>
                <span className="mt-6 inline-flex items-center gap-2 text-sm font-bold text-[var(--primary)]">
                  {plan.code === "free" ? `Escolher ${plan.name}` : "Ativacao administrativa necessaria"}
                  {plan.code === "free" && <ArrowRight size={16} className="transition group-hover:translate-x-1" />}
                </span>
              </button>
            ))}
          </section>
          {error && <div className="mx-auto max-w-xl rounded-xl border border-red-400/30 bg-red-500/12 px-4 py-3 text-sm font-bold text-red-100">{error}</div>}
        </div>
      </main>
    );
  }

  if (pendingSession) {
    return (
      <main className="norium-modern-shell norium-auth-shell norium-auth-dark min-h-dvh bg-[var(--background)] p-4 text-[var(--text)]">
        <div className="norium-auth-choice-layout mx-auto flex min-h-[calc(100dvh-32px)] max-w-5xl items-center justify-center">
          <section className="grid w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-2xl shadow-blue-950/30 backdrop-blur-2xl md:grid-cols-[1.1fr_.9fr]">
            <div className="norium-auth-feature relative min-h-[420px] overflow-hidden p-8 text-white">
              <div className="norium-auth-grid absolute inset-0" />
              <div className="relative z-10 flex h-full flex-col justify-between">
                <BrandLogo className="h-14 w-[148px] text-white" />
                <div>
                  <span className="mb-4 inline-flex items-center gap-2 rounded-full bg-white/16 px-4 py-2 text-sm font-bold">
                    <ShieldCheck size={16} /> Acesso principal reconhecido
                  </span>
                  <h1 className="max-w-xl text-4xl font-black leading-tight">Escolha como deseja entrar no Norium.</h1>
                  <p className="mt-4 max-w-lg text-sm font-semibold leading-6 text-white/82">
                    Seu login pode abrir o painel operacional ou a área administrativa do sistema.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col justify-center gap-4 p-6 sm:p-8">
              <button
                onClick={() => onAuthenticated(pendingSession, "app")}
                className="group rounded-lg border border-[var(--border)] bg-[var(--background)] p-5 text-left transition hover:bg-[var(--surface-hover)]"
              >
                <span className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-blue-500/16 text-blue-300">
                  <Sparkles size={22} />
                </span>
                <span className="block text-xl font-black">Usar sistema</span>
                <span className="mt-2 block text-sm font-semibold leading-6 text-[var(--text-secondary)]">
                  Abrir Dashboard, Gmail, Agenda, Chat, Tarefas, Gastos, Relatórios e Nora.
                </span>
                <span className="mt-5 inline-flex items-center gap-2 text-sm font-bold text-[var(--primary)]">
                  Entrar no painel <ArrowRight size={16} className="transition group-hover:translate-x-1" />
                </span>
              </button>

              <button
                onClick={() => onAuthenticated(pendingSession, "admin")}
                className="group rounded-lg border border-cyan-300/30 bg-cyan-400/12 p-5 text-left transition hover:bg-cyan-400/18"
              >
                <span className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-cyan-400/18 text-cyan-100">
                  <ShieldCheck size={22} />
                </span>
                <span className="block text-xl font-black">Gerenciar sistema</span>
                <span className="mt-2 block text-sm font-semibold leading-6 text-[var(--text-secondary)]">
                  Administrar usuários, planos, permissões, módulos e liberações por integração.
                </span>
                <span className="mt-5 inline-flex items-center gap-2 text-sm font-bold text-[var(--primary)]">
                  Abrir admin <ArrowRight size={16} className="transition group-hover:translate-x-1" />
                </span>
              </button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="norium-modern-shell norium-auth-shell norium-auth-dark min-h-dvh bg-[var(--background)] p-4 text-[var(--text)]">
      <div className="norium-auth-layout mx-auto grid min-h-[calc(100dvh-32px)] max-w-6xl items-center gap-6 lg:grid-cols-[1.1fr_.9fr]">
        <section className="norium-auth-feature relative overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8 shadow-2xl shadow-blue-950/30 backdrop-blur-2xl">
          <div className="norium-auth-grid absolute inset-0" />
          <div className="relative z-10">
            <BrandLogo className="h-16 w-[168px] text-white" />
            <span className="mt-10 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/12 px-4 py-2 text-sm font-bold">
              <Sparkles size={16} /> Operação unificada
            </span>
            <h1 className="mt-6 max-w-2xl text-5xl font-black leading-tight text-white drop-shadow-sm">
              Entre no Norium com segurança e controle por usuário.
            </h1>
            <p className="mt-5 max-w-xl text-base font-semibold leading-7 text-white/84">
              Login, cadastro, modo equipe, permissões por módulo e admin do sistema em uma base limpa e profissional.
            </p>
            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {["Permissoes", "Modo equipe", "Admin"].map((item) => (
                <div key={item} className="rounded-lg border border-white/16 bg-white/12 p-4 text-white backdrop-blur-xl">
                  <p className="text-sm font-bold">{item}</p>
                  <p className="mt-1 text-xs font-semibold text-white/68">Controle granular</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="norium-auth-form rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl shadow-blue-950/24 backdrop-blur-2xl sm:p-8">
          <div className="mb-6 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-2xl font-black">{mode === "login" ? "Entrar" : "Criar conta"}</h2>
              <p className="mt-1 text-sm font-semibold text-[var(--text-secondary)]">
                {mode === "login" ? "Acesse seu painel Norium." : "Crie um usuário principal individual."}
              </p>
            </div>
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-blue-500/16 text-blue-300">
              {mode === "login" ? <LockKeyhole size={22} /> : <UserPlus size={22} />}
            </span>
          </div>

          <div className="grid gap-3">
            {mode === "register" && (
              <label className="grid gap-2 text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">
                Nome
                <input
                  value={nome}
                  onChange={(event) => setNome(event.target.value)}
                  className="h-12 rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 text-sm font-semibold normal-case outline-none focus:border-blue-300"
                  placeholder="Seu nome"
                />
              </label>
            )}
            <label className="grid gap-2 text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">
              E-mail
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="h-12 rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 text-sm font-semibold normal-case outline-none focus:border-blue-300"
                placeholder="voce@email.com"
              />
            </label>
            <label className="grid gap-2 text-xs font-bold uppercase tracking-wide text-[var(--text-secondary)]">
              Senha
              <input
                type="password"
                value={password}
                minLength={mode === "register" ? 10 : 1}
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
                className="h-12 rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 text-sm font-semibold normal-case outline-none focus:border-blue-300"
                placeholder={mode === "login" ? "Sua senha" : "Mínimo de 10 caracteres"}
              />
            </label>
            {mode === "register" && (
              <label className="flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3 text-xs font-semibold leading-5 text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={legalAccepted}
                  onChange={(event) => setLegalAccepted(event.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0"
                />
                <span>
                  Li e aceito os <a className="font-black text-[var(--primary)] hover:underline" href="/" onClick={(event) => { event.preventDefault(); navigateNoriumView("terms"); }}>Termos de Uso</a>
                  {" "}e a <a className="font-black text-[var(--primary)] hover:underline" href="/" onClick={(event) => { event.preventDefault(); navigateNoriumView("privacy"); }}>Politica de Privacidade</a>.
                </span>
              </label>
            )}
          </div>

          {error && (
            <div className="mt-4 rounded-xl border border-red-400/30 bg-red-500/12 px-4 py-3 text-sm font-bold text-red-100">
              {error}
            </div>
          )}

          <button
            onClick={() => void submit()}
            disabled={loading || (mode === "register" && !legalAccepted)}
            className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-700 via-sky-600 to-cyan-500 px-5 text-sm font-bold text-white shadow-lg shadow-blue-950/25 transition hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Validando..." : mode === "login" ? "Entrar no Norium" : "Criar conta"}
            <ArrowRight size={17} />
          </button>

          <button
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError("");
            }}
            className="mt-4 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 py-3 text-sm font-bold text-[var(--text)] transition hover:bg-[var(--surface-hover)]"
          >
            {mode === "login" ? "Criar novo cadastro" : "Já tenho acesso"}
          </button>
          {mode === "login" && <button type="button" onClick={() => setForgot(true)} className="mt-4 w-full py-2 text-sm font-semibold text-[var(--primary)]">Esqueci minha senha</button>}
          <nav className="mt-5 flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs font-bold text-[var(--text-secondary)]">
            <a className="hover:text-[var(--primary)] hover:underline" href="/" onClick={(event) => { event.preventDefault(); navigateNoriumView("terms"); }}>Termos de Uso</a>
            <a className="hover:text-[var(--primary)] hover:underline" href="/" onClick={(event) => { event.preventDefault(); navigateNoriumView("privacy"); }}>Politica de Privacidade</a>
          </nav>
        </section>
      </div>
    </main>
  );
}
