"""Optional integration check using LiteLLM 1.104.0's actual unauthenticated health client."""
import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import urllib.error
import socket

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
from litellm.experimental_mcp_client.client import MCPClient

async def verify(base):
    client = MCPClient(server_url=base + "/mcp", extra_headers={"Host": "127.0.0.1"}, timeout=10)
    async def noop(session):
        await session.send_ping()
        return "ok"
    # Same run_with_session(_noop) path used by health_check_server; no user/key/JWT.
    assert await client.run_with_session(noop) == "ok"
    async def forbidden(session):
        return await session.list_tools()
    try:
        await client.run_with_session(forbidden, quiet_on_error=True)
    except Exception:
        pass
    else:
        raise AssertionError("Anonymous discovery unexpectedly succeeded")

def main():
    assert importlib.metadata.version("litellm") == "1.104.0"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryDirectory(prefix="markdownify-litellm-health-") as data:
        env = {k: v for k, v in os.environ.items() if not k.startswith("MD_")}
        env.update(MD_HOST="127.0.0.1", MD_PORT=str(port), MD_PUBLIC_BASE_URL=base,
                   MD_ALLOWED_HOSTS="127.0.0.1", MD_DATA_DIR=data,
                   MD_JWT_ISSUER="https://litellm-health.test", MD_JWT_AUDIENCE="markdownify",
                   MD_JWT_JWKS_URL="https://litellm-health.test/.well-known/jwks.json")
        child = subprocess.Popen([os.environ.get("MD_TEST_NODE", "node"), "dist/remote/index.js"], env=env,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            health = None
            for _ in range(100):
                if child.poll() is not None:
                    raise AssertionError("Compiled server exited during startup")
                try:
                    req = urllib.request.Request(base + "/healthz", headers={"Host": "127.0.0.1"})
                    with urllib.request.urlopen(req, timeout=1) as response:
                        health = json.load(response)
                    break
                except (urllib.error.URLError, TimeoutError):
                    time.sleep(0.1)
            assert health and health["ready"], "Service did not become ready"
            assert health["checks"]["storage"]["writable"]
            assert health["checks"]["converter"]["available"]
            assert "own_jobs" not in health
            asyncio.run(verify(base))
            print("LiteLLM 1.104.0 actual anonymous health client passed; discovery denied; real readiness metrics verified")
        finally:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)

if __name__ == "__main__":
    main()
