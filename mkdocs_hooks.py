"""MkDocs hook: resolve links that leave docs/ for the documentation site.

The Markdown sources are written for GitHub, so they link to repository files
outside ``docs/`` (``../SKILL.md``, ``../LICENSE``, ``../examples/...``).
mkdocs-include-markdown-plugin rewrites the relative links of included files
(README.md, SKILL.md, PLAN.md) relative to their wrapper page first; this hook
then runs on the result, without changing any source file:

* repository Markdown files that have a wrapper page link to that page;
* other repository files link to ``<repo_url>/blob/main/<path>``, and
  directories to ``<repo_url>/tree/main/<path>``.

Fenced code blocks and inline code spans are left untouched. Only inline
links and images (``[text](target)``) are rewritten: reference-style link
definitions (``[id]: target``) and raw HTML (``<a href>``) are deliberately
left alone, since the docs do not use them for repository links; MkDocs still
validates whatever it can of those. Links inside
``docs/`` are left for MkDocs, which still validates them strictly. A link to a
repository path that does not exist is logged as a warning, which fails
``mkdocs build --strict``.

It also points the "Edit this page" button of a wrapper page at the included
source file, since the wrapper itself only holds the include directive.

Run ``python mkdocs_hooks.py`` for a self-check (no MkDocs build needed).
"""

from __future__ import annotations

import logging
import os
import posixpath
import re
from dataclasses import dataclass

try:
    from mkdocs.plugins import event_priority
except ImportError:  # self-check without MkDocs installed
    def event_priority(priority):
        return lambda func: func

# Repository files rendered on the site through include-markdown wrappers.
WRAPPED_PAGES = {
    "README.md": "install.md",
    "SKILL.md": "agent-skill.md",
    "PLAN.md": "plan.md",
}

# Inline Markdown link or image target: ](target) or ](target "title").
LINK_TARGET = re.compile(r'(\]\()([^)\s]+)((?:\s+"[^"]*")?\))')
SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")
# Opening/closing line of a fenced code block (``` or ~~~, up to 3 spaces in).
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
# Inline code span: a backtick run closed by a run of the same length. It may
# wrap onto the next line but never crosses a blank line (paragraph boundary),
# so a stray backtick cannot hide links in a later paragraph (LF or CRLF).
CODE_SPAN = re.compile(
    r"(?<!`)(`+)(?!`)(?:(?!\r?\n[ \t]*\r?\n).)+?(?<!`)\1(?!`)", re.DOTALL,
)

log = logging.getLogger("mkdocs.hooks.repo_links")


@dataclass
class LinkContext:
    repo_url: str  # e.g. https://github.com/owner/repo
    repo_root: str  # local checkout root (directory holding mkdocs.yml)
    page_uri: str  # page path relative to docs/, e.g. "QUICKSTART.md"

    @property
    def page_dir(self) -> str:
        return posixpath.dirname(self.page_uri)


def _rewrite_target(target: str, ctx: LinkContext) -> str | None:
    """Return the replacement for one link target, or None to keep it."""
    if SCHEME.match(target) or target.startswith(("#", "/")):
        return None
    path, sep, fragment = target.partition("#")
    resolved = posixpath.normpath(posixpath.join(ctx.page_dir, path))
    if not resolved.startswith("../"):
        return None  # inside docs/: leave for MkDocs to validate
    repo_path = resolved[len("../"):]
    if repo_path.startswith("../"):
        return None  # outside the repository: leave for MkDocs to report
    local_path = os.path.join(ctx.repo_root, *repo_path.split("/"))
    if not os.path.exists(local_path):
        log.warning(
            "Doc file '%s' links to '%s', but '%s' does not exist in the repository.",
            ctx.page_uri, target, repo_path,
        )
        return None
    if repo_path in WRAPPED_PAGES:
        wrapper = posixpath.relpath(WRAPPED_PAGES[repo_path], ctx.page_dir or ".")
        return f"{wrapper}{sep}{fragment}"
    kind = "tree" if os.path.isdir(local_path) else "blob"
    return f"{ctx.repo_url}/{kind}/main/{repo_path}{sep}{fragment}"


def _rewrite_prose(text: str, ctx: LinkContext) -> str:
    """Rewrite link targets in Markdown prose, skipping inline code spans."""

    def replace(match: re.Match[str]) -> str:
        new_target = _rewrite_target(match.group(2), ctx)
        if new_target is None:
            return match.group(0)
        return f"{match.group(1)}{new_target}{match.group(3)}"

    parts = []
    last = 0
    for span in CODE_SPAN.finditer(text):
        parts.append(LINK_TARGET.sub(replace, text[last:span.start()]))
        parts.append(span.group(0))
        last = span.end()
    parts.append(LINK_TARGET.sub(replace, text[last:]))
    return "".join(parts)


def rewrite_links(markdown: str, ctx: LinkContext) -> str:
    """Rewrite repository links in ``markdown``, outside fenced code blocks."""
    out: list[str] = []
    prose: list[str] = []
    fence: str | None = None  # the opening fence marker while inside a block
    for line in markdown.splitlines(keepends=True):
        match = FENCE.match(line)
        if fence is None:
            if match:
                out.append(_rewrite_prose("".join(prose), ctx))
                prose = []
                fence = match.group(1)
                out.append(line)
            else:
                prose.append(line)
        else:
            out.append(line)
            if (
                match
                and match.group(1)[0] == fence[0]
                and len(match.group(1)) >= len(fence)
                and not line.strip().lstrip(fence[0])
            ):
                fence = None
    out.append(_rewrite_prose("".join(prose), ctx))
    return "".join(out)


@event_priority(-100)  # after include-markdown (priority 100) inlines files
def on_page_markdown(markdown, page, config, files, **kwargs):
    repo_url = config.repo_url.rstrip("/")
    for source, wrapper in WRAPPED_PAGES.items():
        if page.file.src_uri == wrapper and page.edit_url:
            page.edit_url = f"{repo_url}/edit/main/{source}"
    ctx = LinkContext(
        repo_url=repo_url,
        repo_root=os.path.dirname(os.path.abspath(config.config_file_path)),
        page_uri=page.file.src_uri,
    )
    return rewrite_links(markdown, ctx)


def _self_check() -> None:
    root = os.path.dirname(os.path.abspath(__file__))
    repo = "https://github.com/bxm156/markdownify-mcp"
    ctx = LinkContext(repo_url=repo, repo_root=root, page_uri="QUICKSTART.md")
    source = "\n".join([
        "See [license](../LICENSE), [skill](../SKILL.md#convert-a-file),",
        "[helper dir](../examples/) and [errors](ERRORS.md).",
        "Inline `[x](../LICENSE)` and ``[y](../SKILL.md)`` stay as code.",
        "```markdown",
        "[fenced](../LICENSE)",
        "```",
        "~~~~",
        "[tilde](../SKILL.md)",
        "```",
        "[still fenced](../LICENSE)",
        "~~~~",
        "After: [plan](../PLAN.md)",
        "A stray ` backtick here.",
        "",
        "Next paragraph [license](../LICENSE).",
        "",
        "Span `wrapping",
        "lines [x](../LICENSE)` is code.",
        "",
    ])
    expected = "\n".join([
        f"See [license]({repo}/blob/main/LICENSE), [skill](agent-skill.md#convert-a-file),",
        f"[helper dir]({repo}/tree/main/examples) and [errors](ERRORS.md).",
        "Inline `[x](../LICENSE)` and ``[y](../SKILL.md)`` stay as code.",
        "```markdown",
        "[fenced](../LICENSE)",
        "```",
        "~~~~",
        "[tilde](../SKILL.md)",
        "```",
        "[still fenced](../LICENSE)",
        "~~~~",
        "After: [plan](plan.md)",
        "A stray ` backtick here.",
        "",
        f"Next paragraph [license]({repo}/blob/main/LICENSE).",
        "",
        "Span `wrapping",
        "lines [x](../LICENSE)` is code.",
        "",
    ])
    actual = rewrite_links(source, ctx)
    assert actual == expected, f"unexpected rewrite:\n{actual}"
    # The same fixture with CRLF line endings (several source docs use CRLF).
    actual_crlf = rewrite_links(source.replace("\n", "\r\n"), ctx)
    expected_crlf = expected.replace("\n", "\r\n")
    assert actual_crlf == expected_crlf, f"unexpected CRLF rewrite:\n{actual_crlf!r}"
    print("mkdocs_hooks self-check passed")


if __name__ == "__main__":
    _self_check()
