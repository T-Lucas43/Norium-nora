from __future__ import annotations

import html


def oauth_result_html(
    *,
    provider: str,
    success: bool,
    title: str,
    message: str,
) -> str:
    safe_provider = html.escape(provider)
    safe_title = html.escape(title)
    safe_message = html.escape(message)
    status_label = "Integração concluída" if success else "Não foi possível concluir"
    tone = "success" if success else "error"
    symbol = "✓" if success else "!"
    next_step = (
        f"O {safe_provider} já está pronto para sincronizar com seu espaço de trabalho."
        if success
        else "Volte ao Norium e inicie a conexão novamente. O link anterior não poderá ser reutilizado."
    )
    return f"""<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <title>{safe_title} | Norium</title>
    <style>
      * {{ box-sizing: border-box; }}
      html, body {{ min-height: 100%; margin: 0; }}
      body {{
        min-height: 100vh;
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: max(24px, env(safe-area-inset-top)) 18px max(24px, env(safe-area-inset-bottom));
        overflow-y: auto;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #f8fafc;
        background:
          radial-gradient(circle at 50% 0%, rgba(31, 126, 255, .24), transparent 42%),
          linear-gradient(145deg, #050912 0%, #081222 58%, #07101c 100%);
      }}
      .card {{
        width: min(100%, 560px);
        overflow: hidden;
        border: 1px solid rgba(148, 163, 184, .22);
        border-radius: 26px;
        background: rgba(8, 14, 25, .94);
        box-shadow: 0 28px 90px rgba(0, 0, 0, .48);
      }}
      .accent {{ height: 4px; background: linear-gradient(90deg, #287cff, #13c9e8); }}
      .content {{ padding: clamp(26px, 7vw, 46px); }}
      .brand {{ display: flex; align-items: center; gap: 11px; margin-bottom: 34px; color: #dbeafe; font-weight: 800; letter-spacing: .13em; }}
      .brand-mark {{
        width: 36px; height: 36px; display: grid; place-items: center; border-radius: 11px;
        color: white; letter-spacing: 0; background: linear-gradient(145deg, #176bff, #14c5df);
        box-shadow: 0 10px 30px rgba(27, 121, 255, .32);
      }}
      .result-icon {{
        width: 64px; height: 64px; display: grid; place-items: center; margin-bottom: 22px;
        border-radius: 20px; font-size: 31px; font-weight: 850;
      }}
      .success .result-icon {{ color: #65f2c0; background: rgba(16, 185, 129, .13); border: 1px solid rgba(52, 211, 153, .3); }}
      .error .result-icon {{ color: #ff9aab; background: rgba(244, 63, 94, .12); border: 1px solid rgba(251, 113, 133, .28); }}
      .eyebrow {{ margin: 0 0 10px; color: #75aefc; font-size: 12px; font-weight: 850; letter-spacing: .11em; text-transform: uppercase; }}
      h1 {{ margin: 0; font-size: clamp(27px, 7vw, 38px); line-height: 1.1; letter-spacing: -.035em; }}
      .message {{ margin: 16px 0 0; color: #aebdd1; font-size: 16px; line-height: 1.65; }}
      .next {{
        margin: 26px 0; padding: 17px 18px; border: 1px solid rgba(96, 165, 250, .17); border-radius: 16px;
        color: #d4deec; background: rgba(30, 64, 110, .16); font-size: 14px; line-height: 1.55;
      }}
      .action {{
        display: flex; min-height: 50px; align-items: center; justify-content: center; gap: 9px;
        border-radius: 14px; color: #fff; text-decoration: none; font-weight: 800;
        background: linear-gradient(100deg, #2377f4, #14c6df); box-shadow: 0 13px 32px rgba(21, 115, 239, .25);
      }}
      .hint {{ margin: 15px 0 0; color: #73839a; text-align: center; font-size: 12px; line-height: 1.5; }}
      @media (max-width: 420px) {{
        body {{ place-items: start center; padding-inline: 12px; }}
        .card {{ border-radius: 20px; }}
        .content {{ padding-inline: 22px; }}
      }}
    </style>
  </head>
  <body>
    <main class="card {tone}" aria-labelledby="result-title">
      <div class="accent"></div>
      <div class="content">
        <div class="brand"><span class="brand-mark">N</span> NORIUM</div>
        <div class="result-icon" aria-hidden="true">{symbol}</div>
        <p class="eyebrow">{status_label}</p>
        <h1 id="result-title">{safe_title}</h1>
        <p class="message">{safe_message}</p>
        <p class="next">{next_step}</p>
        <a class="action" href="/">Voltar ao Norium <span aria-hidden="true">→</span></a>
        <p class="hint">Se esta página abriu em uma nova aba, você também pode fechá-la com segurança.</p>
      </div>
    </main>
  </body>
</html>"""
