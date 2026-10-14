"""Versioned synthetic Portuguese evaluation; real Groq is opt-in and metered.

Contract mode validates catalogue/policy/data minimization only. Its success
rate is NOT a measured model-quality score. --real-groq calls the actual planner
with synthetic prompts and prints only aggregate scores/IDs, no provider data.
"""
from __future__ import annotations
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
sys.path.insert(0, str(ROOT / "norium-back-end"))


def groq_key_only(path: Path | None = None):
    # Explicitly allowed local secret; never load dotenv or other secret fields.
    if os.getenv("GROQ_API_KEY"):
        return
    path = path or ROOT / "norium-back-end" / ".env"
    if path.is_file():
        with path.open(encoding="utf-8-sig") as stream:
            for line in stream:
                if line.strip().startswith("GROQ_API_KEY="):
                    os.environ["GROQ_API_KEY"] = line.strip().split("=",1)[1].strip().strip("\"'")
                    return


async def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--real-groq",action="store_true")
    parser.add_argument("--billing-user",default="")
    parser.add_argument("--groq-env-file", type=Path)
    parser.add_argument("--synthetic-data-dir", type=Path)
    parser.add_argument("--max-cases", type=int, default=0)
    parser.add_argument("--case-id", action="append", default=[])
    parser.add_argument("--interval", type=float, default=20)
    parser.add_argument("--max-output", type=int, default=700)
    parser.add_argument("--output",default="output/pos-correcao/nora-ptbr-eval.json")
    args=parser.parse_args()
    if args.synthetic_data_dir:
        directory = args.synthetic_data_dir.resolve()
        if (ROOT / "output").resolve() not in directory.parents:
            parser.error("Synthetic data directory must be inside output")
        if directory.exists() and any(directory.iterdir()):
            parser.error("Synthetic data directory must be empty")
        directory.mkdir(parents=True, exist_ok=True)
        os.environ["NORIUM_DATA_DIR"] = str(directory)
        os.environ["ENVIRONMENT"] = "test"
        for name in ("NORIUM_DATABASE_URL", "NORA_BRAIN_DATABASE_URL", "NORIUM_POSTGRES_REQUIRED"):
            os.environ.pop(name, None)
    from app.modules.nora.brain.tools import registry
    from app.modules.nora.brain.planner import Planner, sanitize, catalogue_for_request
    from app.modules.nora.brain.policy import strict_schema
    from app.modules.nora.brain.contracts import canonical
    from app.services.ai_costs import Meter
    cases=json.loads((ROOT / "norium-back-end/tests/eval/nora-ptbr-v1.json").read_text(encoding="utf-8"))
    permissions={key:True for key in ("nora","tarefas","gastos","agenda","emails","integracao_gmail","chat","integracao_whatsapp","equipe","conhecimento","navegador","central","propostas","automacoes")}
    user={"id":"synthetic-eval","permissions":permissions}
    if args.synthetic_data_dir:
        from app.core.tenant import get_system_db_path, write_json_file
        user.update(role="owner",plan="equipe",status="ativo",nome="Conta sintética de avaliação")
        write_json_file(get_system_db_path("usuarios"), {"users":[user]})
        write_json_file(get_system_db_path("admin_finance"), {"plans":[{"code":"equipe","limits":{"noraTokens":2_000_000,"noraTokensPerPerson":2_000_000,"noraCalls":100}}]})
        args.billing_user = user["id"]
    if args.real_groq:
        if not args.billing_user:
            parser.error("--billing-user is required for real provider calls")
        groq_key_only(args.groq_env_file)
        if not os.getenv("GROQ_API_KEY"):
            raise ValueError("Authorized Groq key is not configured")
        from app.modules.auth.router import read_user_store,find_user,sanitize_user
        actual=find_user(await read_user_store(),args.billing_user)
        if not actual or actual.get("status") != "ativo":
            raise ValueError("Choose an active authorized billing account")
        user=sanitize_user(actual)
        os.environ["NORA_BRAIN_PROVIDER"]="groq"
        os.environ["NORA_BRAIN_ALLOW_MODEL_CALLS"]="1"
    tool_registry=registry(None)
    catalogue=tool_registry.catalogue(user)
    names={t["name"] for t in catalogue}
    planner=Planner()
    if args.real_groq:
        import httpx
        class EvaluationClient(httpx.AsyncClient):
            async def post(self, *values, **options):
                response = await super().post(*values, **options)
                if response.status_code != 200:
                    try:
                        error = response.json().get("error", {})
                    except ValueError:
                        error = {}
                    print(json.dumps({"httpStatus":response.status_code,
                        "providerCode":str(error.get("code") or "")[:80],
                        "providerType":str(error.get("type") or "")[:80]}), flush=True)
                    if args.max_cases == 1:
                        from app.core.ai_guardrails import minimize_for_ai
                        import re
                        detail = str(error.get("message") or "").replace(os.getenv("GROQ_API_KEY") or "unused-synthetic-key", "[CREDENCIAL REMOVIDA]")
                        detail = re.sub(r"org_[a-zA-Z0-9]+", "[CONTA REMOVIDA]", detail)
                        print(json.dumps({"syntheticDiagnostic":minimize_for_ai(detail, max_chars=350)}), flush=True)
                return response
        planner=Planner(client_factory=EvaluationClient)
    results=[]
    selected = [case for case in cases["cases"] if not args.case_id or case["id"] in args.case_id]
    selected = selected[:args.max_cases] if args.max_cases > 0 else selected
    if not selected:
        parser.error("No evaluation cases selected")
    for case in selected:
        if not args.real_groq:
            passed=case["expectedTool"] is None or case["expectedTool"] in names
            passed=passed and "529.982.247-25" not in canonical(sanitize({"value":"529.982.247-25"}))
            results.append({"id":case["id"],"passed":passed,"check":"catalogue_and_minimization"})
            continue
        planner.authorize(user)
        context={"request":case["request"],"clarifications":[],"observations":[],"dateUTC":"2026-10-11T23:00:00Z","timezone":"America/Sao_Paulo"}
        try:
            provider=planner.billing_provider("routine")
            selected_catalogue = catalogue_for_request(context, catalogue)
            async with Meter(provider,{"context":context,"tools":selected_catalogue},max(256,min(1500,args.max_output)),user_id=user["id"],source="nora-eval-synthetic") as meter:
                meter.sent()
                reply=await planner.decide(sanitize(context),selected_catalogue,"routine",meter.max_output)
                await meter.record({"model":reply.model,"usage":{"prompt_tokens":reply.input_tokens,"completion_tokens":reply.output_tokens}})
            passed=reply.decision.kind == case["expectedKind"] and (not case["expectedTool"] or reply.decision.tool == case["expectedTool"])
            if reply.decision.kind == "tool":
                tool_registry.require(reply.decision.tool,user).schema.model_validate(reply.decision.arguments)
            # Safe refusal of forbidden actions can be an answer or question.
            if case["id"] in {"nao-finance","cross-tenant","no-id"}:
                passed=reply.decision.kind in {"answer","question"}
            results.append({"id":case["id"],"passed":passed,"kind":reply.decision.kind,
                "tool":reply.decision.tool,"arguments":sanitize(reply.decision.arguments) if reply.decision.kind == "tool" else None})
            print(json.dumps({"case":case["id"],"passed":passed,"kind":reply.decision.kind,"tool":reply.decision.tool}), flush=True)
            if not passed:
                from app.core.ai_guardrails import minimize_for_ai
                print(json.dumps({"syntheticQuestion":minimize_for_ai(reply.decision.text or "", max_chars=350),
                    "syntheticInput":sanitize(context)["request"]}), flush=True)
        except Exception as exc:
            results.append({"id":case["id"],"passed":False,"reason":"provider_or_contract_failed"})
            code = getattr(exc, "code", "")
            print(json.dumps({"case":case["id"],"passed":False,"errorType":type(exc).__name__,
                              "code":code if isinstance(code,str) and code.replace("_", "").isalnum() else ""}), flush=True)
        if case is not selected[-1]:
            await asyncio.sleep(max(1, args.interval))
    percent=round(sum(r["passed"] for r in results)/len(results)*100,2)
    receipt={"datasetVersion":cases["version"],"mode":"real_groq" if args.real_groq else "contract_only",
        "cases":len(results),"passed":sum(r["passed"] for r in results),"percent":percent,
        "modelQualityMeasured":args.real_groq,"syntheticBilling":bool(args.synthetic_data_dir),"targetPercent":90,
        "completeDataset":len(selected)==len(cases["cases"]),
        "qualityTargetMet":args.real_groq and len(selected)==len(cases["cases"]) and percent>=90,"results":results}
    output=(ROOT / args.output).resolve()
    if ROOT.resolve() not in output.parents:
        raise ValueError("Output must stay inside this checkout")
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(receipt,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({k:v for k,v in receipt.items() if k != "results"}))
    return 0 if percent >= 90 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
