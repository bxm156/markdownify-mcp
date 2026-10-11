# Container builds and Docker Hub publication

The remote image runs the native HTTP MCP service and document converter. Supergateway is unnecessary for this entry point. It exposes `/mcp`, `/uploads/*`, `/livez` (alias `/healthz`, used by the image HEALTHCHECK) and `/readyz` on port 8000. The probe routes accept any Host so orchestrator probes work; all other routes still enforce the host allowlist. Each upload and conversion result belongs to one authenticated agent, including agents sharing a tenant.

## Build and run

From the repository root:

```sh
docker build -f Dockerfile.remote --build-arg VCS_REF="$(git rev-parse HEAD)" -t markdownify-remote:local .
```

The image compiles TypeScript with Bun 1.4.2, installs production JavaScript dependencies in a separate stage, and runs Node 22 with Python 3.12 and MarkItDown 0.1.5. TypeScript and Bun are excluded from the final runtime. OCI labels include the source repository, license, and revision; provide `VCS_REF` when building outside CI.

The container runs as UID/GID 10001. Persist `/data` in one named volume and run one server process per volume. Mount only the hashed agent registry at `/run/markdownify/agents.json`, read-only. Raw token files remain with their respective client runtimes. Secrets are excluded from the build context and never passed as Docker build arguments.

Follow [the fresh deployment quickstart](QUICKSTART.md) for credential provisioning, file permissions, and isolated client verification. [compose.multitenant.yaml](../compose.multitenant.yaml) builds locally and applies a read-only root filesystem, writable `/data`, bounded `/tmp`, resource limits, and dropped capabilities. Production traffic should terminate HTTPS at a reverse proxy preserving `Authorization` and `X-Upload-Token`, routing both `/mcp` and `/uploads/*`, and permitting PUT. Set the public HTTPS origin and host allowlist accordingly.

On SIGTERM, SIGINT or SIGHUP the server stops converters and releases the data-volume lock, and forces exit 1 if that takes longer than `MD_SHUTDOWN_TIMEOUT_MS` (default 10,000). Keep the container stop grace period (`stop_grace_period: 15s` in the bundled Compose files) above that value, or the runtime sends SIGKILL first and leaves `.lock` behind.

The image includes `/app/SKILL.md`, deployment documents, and the example client source for inspection. The client runs outside the server container using its own file access and credential; Bun is required to run that TypeScript example directly. Credentials are supplied at runtime, not embedded in documentation or image layers.

## Docker Hub configuration

The publication target is **`bryanmarty/markdownify-mcp`**. In this GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret** and configure:

| Repository secret | Value supplied privately by the operator |
| --- | --- |
| `DOCKERHUB_USERNAME` | Docker Hub login with write access to `bryanmarty/markdownify-mcp` |
| `DOCKERHUB_TOKEN` | Docker Hub personal access token with permission to push to that repository |

Use a token rather than an account password. Do not paste either credential into issues, PR descriptions, source files, or chat. Create the target Docker Hub repository and choose its visibility before enabling publication.

[Docker Hub publication](../.github/workflows/docker-publish.yml) runs on pushes to `main` and manual dispatches selecting `main`. Other branches cannot publish. It checks out the event commit, builds/tests the source, runs real converter checks, loads a `linux/amd64` image, and exercises the actual image with three disposable agent credentials. Only after those checks does it log into Docker Hub and tag/push that same tested image; there is no second rebuild.

Successful configured runs publish:

- `bryanmarty/markdownify-mcp:latest`
- `bryanmarty/markdownify-mcp:sha-<full tested commit SHA>`

Missing secrets leave the validation green and explicitly report that publication was skipped. A failing check stops publication. Concurrent publication runs are serialized, and a run skips publication if `main` has already advanced before the publication check. PR validation remains in the separate Remote MVP workflow; untrusted PRs do not receive Docker Hub secrets.

The current workflow publishes only `linux/amd64`; it makes no claim about tested ARM images. Pin deployments to a published image digest for reproducible selection. Commit tags identify the tested source but Docker Hub tags can be overwritten by operators. After the first successful publication:

```sh
docker pull bryanmarty/markdownify-mcp:latest
```

Publication is not deployment: it does not start a publicly hosted server or configure a LiteLLM installation.

References: [Docker's test-before-push pattern](https://docs.docker.com/build/ci/github-actions/test-before-push/), [Docker Hub login action](https://github.com/docker/login-action), and [Docker build action](https://github.com/docker/build-push-action).
