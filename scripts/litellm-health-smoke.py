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
import sys

os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
import httpx
# LiteLLM 1.104's MCP client is built on the httpx2 fork, so the status errors it raises are
# httpx2.HTTPStatusError, not httpx.HTTPStatusError. Match both.
import httpx2
from litellm.experimental_mcp_client.client import MCPClient

HTTP_STATUS_ERRORS = (httpx.HTTPStatusError, httpx2.HTTPStatusError)


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


def http_status_codes(exc):
    """Status codes of every real HTTP status error in the exception chain/groups of exc."""
    return sorted({e.response.status_code for e in _walk(exc) if isinstance(e, HTTP_STATUS_ERRORS)})


def has_http_401(exc):
    """True only if a real HTTP status error with status 401 is in the chain/groups of exc.

    Message text is deliberately not consulted: a timeout or 500 whose URL happens to contain
    "401" (for example a random port 40123) must not count as an authorization failure.
    """
    return 401 in http_status_codes(exc)


def _status_error(module, status, url="http://127.0.0.1:40123/mcp"):
    request = module.Request("POST", url)
    try:
        module.Response(status, request=request).raise_for_status()
    except module.HTTPStatusError as exc:
        return exc
    raise AssertionError(f"{module.__name__} did not raise for status {status}")


def self_test():
    """Regression cases for the 401 classifier. Runs before the integration check."""
    for module in (httpx, httpx2):
        name = module.__name__
        check(has_http_401(_status_error(module, 401)), f"{name} 401 not recognised")
        nested = ExceptionGroup("mcp", [RuntimeError("wrapper"), ExceptionGroup("inner", [_status_error(module, 401)])])
        check(has_http_401(nested), f"{name} 401 nested in exception groups not recognised")
        chained = RuntimeError("session failed")
        chained.__cause__ = _status_error(module, 401)
        check(has_http_401(chained), f"{name} 401 via __cause__ not recognised")
        for status in (403, 500):
            check(not has_http_401(_status_error(module, status)), f"{name} {status} misclassified as 401")
            check(http_status_codes(_status_error(module, status)) == [status], f"{name} {status} not reported")
        check(not has_http_401(_status_error(module, 500, "http://127.0.0.1:401/mcp")), f"{name} 500 at port 401 misclassified")
    check(not has_http_401(TimeoutError("timed out connecting to http://127.0.0.1:40123/mcp")), "timeout mentioning 401 misclassified")
    check(not has_http_401(RuntimeError("HTTP 401 Unauthorized")), "message text alone must not count as 401")
    check(not has_http_401(ExceptionGroup("mcp", [TimeoutError("http://127.0.0.1:40123/mcp")])), "grouped timeout misclassified")
    check(http_status_codes(TimeoutError("x")) == [], "no status codes expected for a timeout")


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
            codes = http_status_codes(exc)
            detail = f"HTTP {codes}" if codes else "no HTTP status error (transport error or timeout)"
            raise AssertionError(f"Anonymous discovery failed for a reason other than HTTP 401: {detail}") from exc
    else:
        raise AssertionError("Anonymous discovery unexpectedly succeeded")

def main():
    check(importlib.metadata.version("litellm") == "1.104.0", "LiteLLM 1.104.0 is required")
    self_test()
    if "--self-test" in sys.argv[1:]:
        print("401 classifier self-test passed")
        return
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
