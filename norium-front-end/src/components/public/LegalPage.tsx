import BrandLogo from "../layout/BrandLogo";
import { navigateNoriumView } from "../../app/navigation/view";

type LegalKind = "terms" | "privacy";

const termsSections = [
  ["Uso do Norium", "O Norium deve ser utilizado apenas por pessoas autorizadas e de acordo com as permissoes configuradas para a conta e a equipe."],
  ["Conta e seguranca", "Cada pessoa e responsavel por proteger suas credenciais e comunicar suspeitas de acesso indevido ao responsavel pelo ambiente."],
  ["Integracoes", "Conexoes com Gmail, Agenda, mensageria e outros provedores dependem das autorizacoes concedidas nesses servicos e podem ser revogadas pelo usuario."],
  ["Disponibilidade e suporte", "Os niveis de servico, canais de suporte, regras de cancelamento e condicoes comerciais precisam ser definidos no contrato aplicavel."],
];

const privacySections = [
  ["Dados tratados", "O produto pode tratar dados de cadastro, configuracoes, conteudos inseridos pelo usuario e dados obtidos das integracoes que ele autorizar."],
  ["Finalidades", "Os dados sao usados para autenticar o acesso, executar as funcionalidades solicitadas, manter a seguranca e permitir a operacao do ambiente."],
  ["Compartilhamento", "Dados de integracoes sao enviados aos respectivos provedores somente quando a funcionalidade exige essa comunicacao e conforme a autorizacao concedida."],
  ["Retencao e direitos", "Prazos de retencao, canal do encarregado, base legal e procedimentos para solicitacoes do titular precisam ser validados para a operacao real."],
];

export default function LegalPage({ kind, authenticated }: { kind: LegalKind; authenticated: boolean }) {
  const isTerms = kind === "terms";
  const sections = isTerms ? termsSections : privacySections;
  return (
    <main className="min-h-dvh bg-[var(--background)] px-4 py-8 text-[var(--text)] sm:px-6">
      <article className="mx-auto max-w-3xl rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-2xl shadow-blue-950/20 sm:p-10">
        <a href="/" onClick={(event) => { event.preventDefault(); navigateNoriumView(authenticated ? "app" : "login"); }} aria-label="Voltar ao Norium">
          <BrandLogo className="h-12 w-[132px] text-[var(--text)]" />
        </a>
        <p className="mt-8 text-xs font-black uppercase tracking-[0.2em] text-[var(--primary)]">Versao 2026-08-20</p>
        <h1 className="mt-2 text-3xl font-black sm:text-4xl">{isTerms ? "Termos de Uso" : "Politica de Privacidade"}</h1>
        <p className="mt-4 text-sm font-semibold leading-7 text-[var(--text-secondary)]">
          Esta pagina fornece a estrutura operacional minima do Norium. O texto final, dados da empresa,
          bases legais, prazos e condicoes comerciais devem ser revisados por assessoria juridica antes do uso comercial.
        </p>
        <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm font-bold text-amber-200">
          Validacao juridica necessaria antes da disponibilizacao comercial.
        </div>
        <div className="mt-8 grid gap-7">
          {sections.map(([title, body]) => (
            <section key={title}>
              <h2 className="text-lg font-black">{title}</h2>
              <p className="mt-2 text-sm font-semibold leading-7 text-[var(--text-secondary)]">{body}</p>
            </section>
          ))}
        </div>
        <nav className="mt-10 flex flex-wrap gap-3 border-t border-[var(--border)] pt-6 text-sm font-bold">
          <a className="text-[var(--primary)] hover:underline" href="/" onClick={(event) => { event.preventDefault(); navigateNoriumView("terms"); }}>Termos de Uso</a>
          <a className="text-[var(--primary)] hover:underline" href="/" onClick={(event) => { event.preventDefault(); navigateNoriumView("privacy"); }}>Politica de Privacidade</a>
          <a className="text-[var(--primary)] hover:underline" href="/" onClick={(event) => { event.preventDefault(); navigateNoriumView(authenticated ? "app" : "login"); }}>Voltar ao Norium</a>
        </nav>
      </article>
    </main>
  );
}
