import BrandLogo from "../layout/BrandLogo";
import { navigateNoriumView } from "../../app/navigation/view";

type LegalKind = "terms" | "privacy";

const termsSections = [
  ["Uso autorizado", "O Norium deve ser usado por pessoas autorizadas, dentro das permissões da conta e da equipe. É proibido tentar acessar outro ambiente, contornar controles ou usar o serviço para atividade ilícita."],
  ["Conta e segurança", "Cada pessoa deve proteger suas credenciais, usar dados corretos e comunicar suspeitas de acesso indevido. Sessões podem ser revogadas e contas podem ser bloqueadas para proteger o ambiente."],
  ["Conteúdo e integrações", "O cliente conserva a responsabilidade e os direitos sobre o conteúdo inserido. Gmail, Agenda, mensageria, IA e outros provedores só são acionados quando configurados e autorizados; a conexão pode ser revogada a qualquer momento."],
  ["Disponibilidade, plano e encerramento", "Recursos, limites, suporte, preço e nível de serviço seguem o plano ou contrato aplicável. A conta pode ser encerrada nas configurações, após autenticação e tratamento dos vínculos ativos de equipe."],
];

const privacySections = [
  ["Papéis e dados tratados", "A organização cliente controla o conteúdo do seu workspace e o Norium o processa conforme as instruções dessa organização. Para a própria conta, o Norium trata cadastro, autenticação, preferências, auditoria de segurança, arquivos enviados e dados das integrações autorizadas."],
  ["Finalidades e bases", "Os dados são usados para executar o contrato e as funcionalidades solicitadas, autenticar e proteger o acesso, atender obrigações legais e exercer direitos. Consentimento é usado quando a lei ou a integração exigir e pode ser revogado sem afetar o tratamento anterior válido."],
  ["Compartilhamento e transferências", "Dados podem passar pela infraestrutura Microsoft Azure, pelo serviço de e-mail, pelos provedores conectados e por provedores de IA escolhidos no produto, apenas no escopo necessário. O Norium não vende cadastros pessoais."],
  ["Retenção e eliminação", "Dados ativos são mantidos durante a conta ou o contrato. Uma exclusão autenticada revoga sessões, elimina o diretório pessoal e anonimiza o cadastro; cópias de segurança protegidas são sobrescritas em até 35 dias. Registros fiscais, de segurança ou de defesa de direitos podem permanecer pelo prazo legal aplicável, com acesso restrito."],
  ["Direitos do titular", "Nas Configurações, o titular pode exportar seus dados e solicitar a exclusão da conta. Correção, confirmação, acesso, oposição, revisão, portabilidade e dúvidas podem ser solicitados a suporte@norium-ai.com. Pedidos sobre conteúdo de um workspace também devem ser dirigidos à organização que o controla."],
  ["Segurança e incidentes", "O Norium aplica segregação por conta e workspace, controle de acesso, criptografia de segredos, trilha de auditoria e backups protegidos. Incidentes relevantes são avaliados e comunicados às partes e autoridades nos casos exigidos."],
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
        <p className="mt-8 text-xs font-black uppercase tracking-[0.2em] text-[var(--primary)]">Versão 2026-09-20</p>
        <h1 className="mt-2 text-3xl font-black sm:text-4xl">{isTerms ? "Termos de Uso" : "Politica de Privacidade"}</h1>
        <p className="mt-4 text-sm font-semibold leading-7 text-[var(--text-secondary)]">
          Estes termos descrevem o funcionamento e os controles disponíveis no produto. Dúvidas e solicitações podem ser enviadas a suporte@norium-ai.com.
        </p>
        <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm font-bold text-amber-200">
          A identidade completa da empresa, o contrato comercial e este texto devem receber validação jurídica antes do lançamento público.
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
