"""Local synthetic UI fixture. Serves only dist; never connects to Gmail/calendar."""
import argparse
import datetime as dt
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1] / "norium-front-end" / "dist"
SERVICE = {"id": "demo-service", "name": "Conversa de planejamento", "description": "Um encontro para ouvir suas ideias, alinhar prioridades e planejar os próximos passos.", "durations": [30, 60], "color": "#2563eb", "buffer_before": 0, "buffer_after": 0, "capacity": 1, "slot_interval": 30, "active": True, "location_type": "online", "maximum_days": 90}

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(ROOT), **kwargs)
    def log_message(self, *args): pass
    def json(self, value):
        content = json.dumps(value).encode(); self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(content))); self.end_headers(); self.wfile.write(content)
    def do_GET(self):
        path = urlsplit(self.path).path
        if path.startswith("/api/public/scheduling/pages/"):
            if path.endswith("/slots"):
                query = parse_qs(urlsplit(self.path).query); day = query.get("day", [dt.date.today().isoformat()])[0]; duration = int(query.get("duration", ["30"])[0]); rows = []
                for hour, minute in [(9, 0), (9, 30), (10, 0), (10, 30), (11, 0), (14, 0), (14, 30), (15, 0), (15, 30), (16, 0)]:
                    start = dt.datetime.fromisoformat(f"{day}T{hour:02}:{minute:02}:00-03:00"); rows.append({"startAt": start.isoformat(), "endAt": (start + dt.timedelta(minutes=duration)).isoformat(), "remaining": 1})
                return self.json({"slots": rows, "calendarVerified": True, "timezone": "America/Sao_Paulo"})
            return self.json({"page": {"id": "demo-page", "public_id": "demo-public", "title": "Vamos conversar?", "description": SERVICE["description"], "service_id": SERVICE["id"], "fields": [], "theme": {}, "active": True}, "service": SERVICE})
        if path.startswith("/api/"): self.send_error(404); return
        if path.startswith("/agendar/"): self.path = "/index.html"
        super().do_GET()
    def do_POST(self):
        if urlsplit(self.path).path.endswith("/bookings"):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            return self.json({"booking": {"public_id": "DEMO-2026", "status": "CONFIRMED"}, "cancelToken": "synthetic", "rescheduleToken": "synthetic"})
        self.send_error(404)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--port", type=int, default=8787); args = parser.parse_args()
    print(f"Synthetic scheduling preview http://127.0.0.1:{args.port}/agendar/demo", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
