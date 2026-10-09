"""MkDocs hook: resolve links that leave docs/ for the documentation site.

The Markdown sources are written for GitHub, so they link to repository files
outside ``docs/`` (``../SKILL.md``, ``../LICENSE``, ``../examples/...``).
mkdocs-include-markdown-plugin rewrites the relative links of included files
(README.md, SKILL.md, PLAN.md) relative to their wrapper page first; this hook
then runs on the result, without changing any source file:

* repository Markdown files that have a wrapper page link to that page;
* every other repository file links to its GitHub blob URL on ``main``.

It also points the "Edit this page" button of a wrapper page at the included
source file, since the wrapper itself only holds the include directive.

Links inside ``docs/`` are untouched, so MkDocs still validates them strictly.
A link to a repository file that does not exist is logged as a warning, which
fails ``mkdocs build --strict``.
"""

from __future__ import annotations

import logging
import os
import posixpath
import re

from mkdocs.plugins import event_priority

# Repository files rendered on the site through include-markdown wrappers.
WRAPPED_PAGES = {
    "README.md": "install.md",
    "SKILL.md": "agent-skill.md",
    "PLAN.md": "plan.md",
}

# Inline Markdown link or image target: ](target) or ](target "title").
LINK_TARGET = re.compile(r'(\]\()([^)\s]+)((?:\s+"[^"]*")?\))')
SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")

log = logging.getLogger("mkdocs.hooks.repo_links")


def _rewrite(
    target: str, page_dir: str, blob_base: str, repo_root: str, page_uri: str,
) -> str | None:
    if SCHEME.match(target) or target.startswith(("#", "/")):
        return None
    path, sep, fragment = target.partition("#")
    resolved = posixpath.normpath(posixpath.join(page_dir, path))
    if not resolved.startswith("../"):
        return None  # inside docs/: leave for MkDocs to validate
    repo_path = resolved[len("../"):]
    if repo_path.startswith("../"):
        return None  # outside the repository: leave for MkDocs to report
    if not os.path.exists(os.path.join(repo_root, *repo_path.split("/"))):
        log.warning(
            "Doc file '%s' links to '%s', but '%s' does not exist in the repository.",
            page_uri, target, repo_path,
        )
        return None
    if repo_path in WRAPPED_PAGES:
        wrapper = posixpath.relpath(WRAPPED_PAGES[repo_path], page_dir or ".")
        return f"{wrapper}{sep}{fragment}"
    return f"{blob_base}{repo_path}{sep}{fragment}"


@event_priority(-100)  # after include-markdown (priority 100) inlines files
def on_page_markdown(markdown, page, config, files, **kwargs):
    page_dir = posixpath.dirname(page.file.src_uri)
    repo_url = config.repo_url.rstrip("/")
    blob_base = f"{repo_url}/blob/main/"
    repo_root = os.path.dirname(os.path.abspath(config.config_file_path))

    for source, wrapper in WRAPPED_PAGES.items():
        if page.file.src_uri == wrapper and page.edit_url:
            page.edit_url = f"{repo_url}/edit/main/{source}"

    def replace(match: re.Match[str]) -> str:
        new_target = _rewrite(
            match.group(2), page_dir, blob_base, repo_root, page.file.src_uri,
        )
        if new_target is None:
            return match.group(0)
        return f"{match.group(1)}{new_target}{match.group(3)}"

    return LINK_TARGET.sub(replace, markdown)
