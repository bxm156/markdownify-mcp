"""Negative-path harness for litellm-health-smoke.py: a fake MCP server whose anonymous discovery
answers 403, 500, never (timeout) or succeeds must each fail verify(); 401 is the positive control.
A mixed 401+500 (or 401+403) exception group from the client must fail too: any status other than 401
anywhere in the group means the gateway is broken or misconfigured, whatever else was observed.
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

def check(condition, message):
    if not condition:
        raise AssertionError(message)


def mixed_group_cases():
    """verify() must reject a client error group that mixes 401 with any other HTTP status."""
    if not smoke.GROUPS:
        print("Python < 3.11: skipping mixed exception group cases")
        return
    real_client = smoke.MCPClient

    def client_raising(errors):
        class GroupClient(real_client):
            async def run_with_session(self, callback, *args, **kwargs):
                if callback.__name__ != "forbidden":
                    return await super().run_with_session(callback, *args, **kwargs)
                raise ExceptionGroup("mcp", errors())
        return GroupClient

    cases = {
        # name: (statuses in the group, whether verify() should accept it)
        "401+401": ([401, 401], True),
        "401+500": ([401, 500], False),
        "500+401": ([500, 401], False),
        "401+403": ([401, 403], False),
    }
    FakeMcp.mode = "success"  # initialize/ping work; the discovery error is injected by the client
    try:
        for name, (statuses, accepted) in cases.items():
            for module in (smoke.httpx, smoke.httpx2):
                smoke.MCPClient = client_raising(lambda: [smoke._status_error(module, status) for status in statuses])
                try:
                    asyncio.run(smoke.verify(BASE[0], timeout=2))
                except AssertionError as exc:
                    check(not accepted, f"{name} ({module.__name__}) unexpectedly rejected: {exc}")
                    print(f"{name} ({module.__name__}): rejected ({exc})")
                else:
                    check(accepted, f"verify() accepted a {name} group from {module.__name__}")
                    print(f"{name} ({module.__name__}): accepted")
    finally:
        smoke.MCPClient = real_client


BASE = [""]


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeMcp)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_port}"
    BASE[0] = base
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
        mixed_group_cases()
    finally:
        server.shutdown()
    print("LiteLLM health smoke negative paths passed")

if __name__ == "__main__":
    main()
