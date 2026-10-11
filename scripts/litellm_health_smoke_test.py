"""Negative-path harness for litellm-health-smoke.py: a fake MCP server whose anonymous discovery
answers 403, 500, never (timeout) or succeeds must each fail verify(); 401 is the positive control.
Uses explicit raises, never bare assert, so it also proves the smoke's checks survive `python -O`."""
import asyncio, importlib.util, json, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location("smoke", Path(__file__).with_name("litellm-health-smoke.py"))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

class FakeMcp(BaseHTTPRequestHandler):
    mode = "401"
    def log_message(self, *args): pass
    def reply(self, status, body=None):
        data = json.dumps(body).encode() if body is not None else b""
        self.send_response(status)
        if body is not None: self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self): self.reply(405)
    def do_DELETE(self): self.reply(405)
    def do_POST(self):
        msg = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if "id" not in msg: return self.reply(202)
        result = {"protocolVersion": msg.get("params", {}).get("protocolVersion"), "capabilities": {}, "serverInfo": {"name": "fake", "version": "0"}} if msg["method"] == "initialize" else {}
        if msg["method"] == "tools/list":
            if self.mode == "timeout": time.sleep(3)
            if self.mode in ("401", "403", "500"): return self.reply(int(self.mode), {"error": "denied"})
            result = {"tools": []}
        self.reply(200, {"jsonrpc": "2.0", "id": msg["id"], "result": result})

def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeMcp)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        smoke.self_test()
        for mode in ("401", "403", "500", "timeout", "success"):
            FakeMcp.mode = mode
            try:
                asyncio.run(smoke.verify(base, timeout=1))
            except AssertionError as exc:
                if mode == "401": raise AssertionError(f"401 control unexpectedly failed: {exc}") from exc
                print(f"{mode}: rejected ({exc})")
            else:
                if mode != "401": raise AssertionError(f"verify() accepted anonymous discovery answering {mode}")
                print("401: accepted")
    finally:
        server.shutdown()
    print("LiteLLM health smoke negative paths passed")

if __name__ == "__main__":
    main()
