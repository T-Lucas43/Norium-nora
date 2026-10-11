import type { ReactNode } from "react";
import noraAvatar from "../../assets/nora-brand.webp";
import { navigateNoriumView } from "../../app/navigation/view";
import BrandLogo from "../layout/BrandLogo";
import { useAuthTheme } from "./useAuthTheme";
import "../../styles/screens/acesso.css";

/** Casca das telas de acesso: formulário à esquerda e painel da Nora à direita (ou largura total em "wide"). */
export default function AuthLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const theme = useAuthTheme();
  return (
    <main className={`ac${wide ? " is-wide" : ""}${theme === "escuro" ? " dark" : ""}`}>
      <div className="ac-main">
        <div className="ac-box">
          <BrandLogo className="ac-logo" />
          {children}
        </div>
        <nav className="ac-foot" aria-label="Documentos legais">
          <span>© {new Date().getFullYear()} Norium</span>
          <a className="ac-link" href="/" onClick={(event) => { event.preventDefault(); navigateNoriumView("terms"); }}>Termos de Uso</a>
          <a className="ac-link" href="/" onClick={(event) => { event.preventDefault(); navigateNoriumView("privacy"); }}>Política de Privacidade</a>
        </nav>
      </div>
      {!wide && (
        <aside className="ac-side" aria-label="Sobre o Norium">
          <img className="ac-nora" src={noraAvatar} alt="Nora" draggable={false} />
          <h2>Sua operação inteira,<br />com a Nora ao lado.</h2>
          <p>Conversas, e-mails, agenda, tarefas e financeiro em um só lugar. A Nora prepara, você aprova.</p>
        </aside>
      )}
    </main>
  );
}
