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
import httpx
from litellm.experimental_mcp_client.client import MCPClient


def check(condition, message):
    """Explicit check that, unlike a bare assert, is not stripped by `python -O`."""
    if not condition:
        raise AssertionError(message)


def _walk(exc, seen=None):
    """Yield exc and every exception reachable via __cause__, __context__ or ExceptionGroup.exceptions."""
    seen = set() if seen is None else seen
    if exc is None or id(exc) in seen:
        return
    seen.add(id(exc))
    yield exc
    yield from _walk(exc.__cause__, seen)
    yield from _walk(exc.__context__, seen)
    # ExceptionGroup / BaseExceptionGroup (Python 3.11+); the MCP SDK and anyio raise these.
    for inner in getattr(exc, "exceptions", None) or ():
        yield from _walk(inner, seen)


def has_http_401(exc):
    """True if an HTTP 401 is anywhere in the exception chain/groups of exc."""
    chain = list(_walk(exc))
    http_errors = [e for e in chain if isinstance(e, httpx.HTTPStatusError)]
    if http_errors:
        return any(e.response.status_code == 401 for e in http_errors)
    # Fallback, only when no httpx error object is present anywhere in the chain
    # (some wrappers flatten the error to text): accept a "401" in the message text.
    return any("401" in str(e) for e in chain)


async def verify(base):
    client = MCPClient(server_url=base + "/mcp", extra_headers={"Host": "127.0.0.1"}, timeout=10)
    async def noop(session):
        await session.send_ping()
        return "ok"
    # Runs LiteLLM's real MCPClient.run_with_session initialization path and additionally
    # sends ping, a superset of LiteLLM's no-op health callback (which only initializes).
    # No user/key/JWT.
    check(await client.run_with_session(noop) == "ok", "Anonymous initialize/ping did not return ok")
    async def forbidden(session):
        return await session.list_tools()
    try:
        await client.run_with_session(forbidden, quiet_on_error=True)
    except Exception as exc:
        if not has_http_401(exc):
            raise AssertionError("Anonymous discovery failed for a reason other than HTTP 401") from exc
    else:
        raise AssertionError("Anonymous discovery unexpectedly succeeded")

def main():
    check(importlib.metadata.version("litellm") == "1.104.0", "LiteLLM 1.104.0 is required")
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
            check(health and health["ready"], "Service did not become ready")
            check(health["checks"]["storage"]["writable"], "Storage is not writable")
            check(health["checks"]["converter"]["available"], "Converter is not available")
            check("own_jobs" not in health, "Public health leaked own_jobs")
            asyncio.run(verify(base))
            print("LiteLLM 1.104.0 actual anonymous health client passed; discovery denied with HTTP 401; real readiness metrics verified")
        finally:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)

if __name__ == "__main__":
    main()
