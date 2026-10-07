// Synthetic browser fixture: mounts the real Tasks screen and stylesheet.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import TasksDashboard from "../../src/components/tasks/TasksDashboard";
import type { AuthSession } from "../../src/types/auth";
const session = { token: "synthetic", availableModes: ["app"], user: { id: "owner", nome: "Synthetic owner", email: "owner@example.invalid", status: "ativo", role: "owner", plan: "equipe", permissions: {} } } as AuthSession;
createRoot(document.getElementById("root")!).render(
  <div className="app-shell norium-modern-shell flex h-screen overflow-hidden">
    <div className="norium-workspace flex flex-1 flex-col min-h-0">
      <header className="norium-topbar" style={{height: 64}}>Norium — synthetic fixture</header>
      <main className="app-main flex-1 min-h-0">
        <section className="app-panel app-panel-tasks flex flex-col h-full">
          <div className="norium-module-coach-compact">Nora</div>
          <TasksDashboard session={session} />
        </section>
      </main>
    </div>
  </div>
);
