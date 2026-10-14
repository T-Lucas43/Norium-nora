import { useEffect, useId, useState } from "react";
import { ArrowRight, Check, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import type { AppMode, AuthSession, PlanInfo, UserPlan } from "../../types/auth";
import { authJson } from "../../utils/authApi";
import { passwordSession } from "../../core/api/cookieSession";
import AccountEmailAction from "./AccountEmailAction";
import AuthLayout from "./AuthLayout";
import { navigateNoriumView } from "../../app/navigation/view";

interface AuthScreenProps {
  onAuthenticated: (session: AuthSession, mode: AppMode) => void;
}

type FormMode = "login" | "register";

function formatPlanPrice(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function ensureAuthSession(value: unknown): AuthSession {
  if (!value || typeof value !== "object") {
    throw new Error("Não foi possível validar sua sessão. Atualize a página e tente novamente.");
  }
  const session = value as Partial<AuthSession>;
  if (!session.user || typeof session.token !== "string" || !Array.isArray(session.availableModes)) {
    throw new Error("Não foi possível validar sua sessão. Atualize a página e tente novamente.");
  }
  return session as AuthSession;
}

export default function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<FormMode>("login");
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [persistent, setPersistent] = useState(true);
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [pendingSession, setPendingSession] = useState<AuthSession | null>(null);
  const [planSession, setPlanSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [forgot, setForgot] = useState(false);
  const [planOptions, setPlanOptions] = useState<PlanInfo[]>([]);
  const fieldId = useId();

  useEffect(() => {
    if (!planSession) return;
    let active = true;
    authJson<{ plans: PlanInfo[] }>("/api/auth/plans", planSession.token)
      .then((result) => { if (active) setPlanOptions(result.plans); })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : "Não foi possível carregar os planos."); });
    return () => { active = false; };
  }, [planSession]);

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
        setError("Aceite os Termos de Uso e a Política de Privacidade para criar a conta.");
        return;
      }
    }
    setLoading(true);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload = mode === "login"
        ? { email, password, persistent }
        : { nome, email, password, persistent, acceptedTerms: true, acceptedPrivacy: true };
      const session = ensureAuthSession(await passwordSession(endpoint, payload));
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
      const session = ensureAuthSession(await authJson<unknown>("/api/auth/select-plan", planSession.token, {
        method: "POST",
        body: JSON.stringify({ plan }),
      }));
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
      <AuthLayout wide>
        <div className="ac-center">
          <h1 className="ac-title">Escolha seu plano</h1>
          <p className="ac-sub">As permissões da conta serão aplicadas automaticamente.</p>
        </div>
        <section className="ac-plans" aria-label="Planos disponíveis">
          {planOptions.map((plan) => (
            <article key={plan.code} className={`ac-plan${plan.code === "free" ? " is-available" : ""}`}>
              <span className="ac-plan-n">{plan.name}</span>
              <span className="ac-plan-d">{plan.description}</span>
              <span className="ac-plan-p">{formatPlanPrice(plan.monthlyPrice)}<small>/mês</small></span>
              <ul className="ac-plan-f">
                {plan.features.map((feature) => (
                  <li key={feature}><Check size={15} aria-hidden="true" />{feature}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void choosePlan(plan.code)}
                disabled={loading || plan.code !== "free"}
                className={`ac-btn${plan.code === "free" ? " is-primary" : ""}`}
              >
                {plan.code === "free" ? `Escolher ${plan.name}` : "Ativação administrativa necessária"}
                {plan.code === "free" && <ArrowRight size={16} aria-hidden="true" />}
              </button>
            </article>
          ))}
        </section>
        {error && <div role="alert" className="ac-alert" style={{ marginTop: 20 }}>{error}</div>}
      </AuthLayout>
    );
  }

  if (pendingSession) {
    return (
      <AuthLayout>
        <span className="ac-kicker"><ShieldCheck size={16} aria-hidden="true" /> Acesso principal reconhecido</span>
        <h1 className="ac-title">Escolha como deseja entrar no Norium.</h1>
        <p className="ac-sub">Seu login pode abrir o painel operacional ou a área administrativa do sistema.</p>
        <div className="ac-choices">
          <button type="button" onClick={() => onAuthenticated(pendingSession, "app")} className="ac-choice">
            <span className="ac-choice-ic"><Sparkles size={20} aria-hidden="true" /></span>
            <span>
              <span className="ac-choice-t">Usar sistema</span>
              <span className="ac-choice-d">Abrir Dashboard, Gmail, Agenda, Chat, Tarefas, Gastos, Relatórios e Nora.</span>
              <span className="ac-choice-go">Entrar no painel <ArrowRight size={16} aria-hidden="true" /></span>
            </span>
          </button>
          <button type="button" onClick={() => onAuthenticated(pendingSession, "admin")} className="ac-choice is-admin">
            <span className="ac-choice-ic"><ShieldCheck size={20} aria-hidden="true" /></span>
            <span>
              <span className="ac-choice-t">Gerenciar sistema</span>
              <span className="ac-choice-d">Administrar usuários, planos, permissões, módulos e liberações por integração.</span>
              <span className="ac-choice-go">Abrir admin <ArrowRight size={16} aria-hidden="true" /></span>
            </span>
          </button>
        </div>
      </AuthLayout>
    );
  }

  const isLogin = mode === "login";
  const ids = { nome: `${fieldId}-nome`, email: `${fieldId}-email`, senha: `${fieldId}-senha` };

  return (
    <AuthLayout>
      <h1 className="ac-title">{isLogin ? "Entrar" : "Criar conta"}</h1>
      <p className="ac-sub">{isLogin ? "Acesse seu painel Norium." : "Crie um usuário principal individual."}</p>

      <div className="ac-form" aria-busy={loading}>
        {!isLogin && (
          <div className="ac-field">
            <label className="ac-label" htmlFor={ids.nome}>Nome</label>
            <span className="ac-input">
              <UserRound size={16} aria-hidden="true" />
              <input
                id={ids.nome}
                name="name"
                value={nome}
                autoComplete="name"
                onChange={(event) => setNome(event.target.value)}
                placeholder="Seu nome"
              />
            </span>
          </div>
        )}
        <div className="ac-field">
          <label className="ac-label" htmlFor={ids.email}>E-mail</label>
          <span className="ac-input">
            <Mail size={16} aria-hidden="true" />
            <input
              id={ids.email}
              name={isLogin ? "username" : "email"}
              type="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              value={email}
              autoComplete={isLogin ? "username" : "email"}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="voce@email.com"
            />
          </span>
        </div>
        <div className="ac-field">
          <div className="ac-label-row">
            <label className="ac-label" htmlFor={ids.senha}>Senha</label>
            {isLogin && <button type="button" onClick={() => setForgot(true)} className="ac-link">Esqueci minha senha</button>}
          </div>
          <span className="ac-input">
            <LockKeyhole size={16} aria-hidden="true" />
            <input
              id={ids.senha}
              name={isLogin ? "current-password" : "new-password"}
              type={showPassword ? "text" : "password"}
              value={password}
              minLength={isLogin ? 1 : 10}
              autoComplete={isLogin ? "current-password" : "new-password"}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              placeholder={isLogin ? "Sua senha" : "Mínimo de 10 caracteres"}
            />
            <button
              type="button"
              className="ac-eye"
              onClick={() => setShowPassword((current) => !current)}
              aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
              aria-pressed={showPassword}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </span>
        </div>
        {!isLogin && (
          <label className="ac-check">
            <input
              type="checkbox"
              checked={legalAccepted}
              onChange={(event) => setLegalAccepted(event.target.checked)}
            />
            <span>
              Li e aceito os <a className="ac-link" href="/" onClick={(event) => { event.preventDefault(); navigateNoriumView("terms"); }}>Termos de Uso</a>
              {" "}e a <a className="ac-link" href="/" onClick={(event) => { event.preventDefault(); navigateNoriumView("privacy"); }}>Política de Privacidade</a>.
            </span>
          </label>
        )}
        <label className="ac-check">
          <input type="checkbox" checked={persistent} onChange={(event) => setPersistent(event.target.checked)} />
          Manter conectado neste navegador por até 7 dias
        </label>
        {error && <div role="alert" className="ac-alert">{error}</div>}

        <button
          type="button"
          onClick={() => void submit()}
          disabled={loading || (!isLogin && !legalAccepted)}
          className="ac-btn is-primary"
        >
          {loading ? "Validando..." : isLogin ? "Entrar no Norium" : "Criar conta"}
          <ArrowRight size={16} aria-hidden="true" />
        </button>

        <p className="ac-alt">
          {isLogin ? "Ainda não tem conta? " : "Já tem conta? "}
          <button
            type="button"
            className="ac-link"
            onClick={() => {
              setMode(isLogin ? "register" : "login");
              setError("");
            }}
          >
            {isLogin ? "Criar novo cadastro" : "Já tenho acesso"}
          </button>
        </p>
      </div>
    </AuthLayout>
  );
}
