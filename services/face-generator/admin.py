#!/usr/bin/env python3
"""Admin CLI for the Zaruce face generator.

Usage:
    python admin.py build-lookup --samples 50000
    python admin.py status
    python admin.py regen-bucket --bucket-id 1234 --samples 5000
    python admin.py rotate-salt --new-salt $(openssl rand -hex 32)
    python admin.py warm --indices 0,1,2,3,4

The CLI invokes the Modal app's HTTP endpoints (admin-status, admin-regen,
admin-warm) using ADMIN_TOKEN, so it works from anywhere with internet
access — no Modal client login required to run the read-only commands.

For `build-lookup` and `rotate-salt` (heavy operations) the CLI shells out
to `modal run` to execute the corresponding entrypoints inside the Modal
workspace, since they need GPU + secret access.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Optional

import click
import requests


MODAL_BASE_DEFAULT = os.environ.get("MODAL_FACE_BASE", "")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")


def _admin_url(label: str, base: Optional[str] = None) -> str:
    """Modal endpoint URLs follow `<workspace>--<app>-<endpointlabel>.modal.run`.
    We accept the face endpoint URL (the one the user has to remember anyway)
    and swap its label suffix to reach the admin endpoints."""
    base = base or MODAL_BASE_DEFAULT
    if not base:
        click.secho("MODAL_FACE_BASE is not set; either pass --base or export it.", fg="red")
        sys.exit(2)
    base = base.rstrip("/")
    if base.endswith(".modal.run"):
        host = base[: -len(".modal.run")]
        last_dash = host.rfind("-")
        if last_dash > 0:
            return host[:last_dash] + f"-{label}.modal.run"
    return f"{base}/{label}"  # custom domain fallback


def _headers() -> dict[str, str]:
    if not ADMIN_TOKEN:
        click.secho("ADMIN_TOKEN env var is required for admin operations.", fg="red")
        sys.exit(2)
    return {"authorization": f"Bearer {ADMIN_TOKEN}"}


@click.group()
def cli() -> None:
    """Admin operations for zaruce-face-generator."""


@cli.command("status")
@click.option("--base", default=None, help="Override MODAL_FACE_BASE")
def status(base: Optional[str]) -> None:
    """Show bucket coverage stats."""
    res = requests.get(_admin_url("admin-status", base), headers=_headers(), timeout=30)
    res.raise_for_status()
    click.echo(json.dumps(res.json(), indent=2))


@cli.command("regen-bucket")
@click.option("--bucket-id", type=int, required=True)
@click.option("--samples", type=int, default=5000)
@click.option("--base", default=None)
def regen_bucket(bucket_id: int, samples: int, base: Optional[str]) -> None:
    """Re-sample seeds for one bucket id."""
    res = requests.post(
        _admin_url("admin-regen", base),
        params={"bucket_id": bucket_id, "samples": samples},
        headers=_headers(),
        timeout=3600,
    )
    res.raise_for_status()
    click.echo(json.dumps(res.json(), indent=2))


@cli.command("warm")
@click.option("--indices", required=True, help="Comma-separated slot indices")
@click.option("--base", default=None)
def warm(indices: str, base: Optional[str]) -> None:
    """Pre-warm faces for marketing screenshots or load tests."""
    res = requests.post(
        _admin_url("admin-warm", base),
        params={"indices": indices},
        headers=_headers(),
        timeout=600,
    )
    res.raise_for_status()
    click.echo(json.dumps(res.json(), indent=2))


@cli.command("build-lookup")
@click.option("--samples", type=int, default=50_000)
def build_lookup_cmd(samples: int) -> None:
    """Run the full lookup builder inside Modal (GPU job).

    Requires the Modal CLI to be authenticated. Streams output until done.
    """
    cmd = ["modal", "run", "main.py::build_lookup_entry", "--samples", str(samples)]
    click.secho(f"$ {' '.join(cmd)}", fg="cyan")
    rc = subprocess.call(cmd, cwd=os.path.dirname(os.path.abspath(__file__)))
    sys.exit(rc)


@cli.command("rotate-salt")
@click.option("--new-salt", required=True)
def rotate_salt(new_salt: str) -> None:
    """Update the SEED_SALT secret in Modal and instruct ops to mirror it
    in Vercel. Does NOT touch existing slot rows; new generations use the
    new salt, cached faces stay at their old seeds until cache eviction."""
    cmd = ["modal", "secret", "create", "zaruce-secrets", f"SEED_SALT={new_salt}", "--force"]
    click.secho(f"$ {' '.join(cmd)}", fg="cyan")
    rc = subprocess.call(cmd)
    if rc != 0:
        sys.exit(rc)
    click.secho(
        "Modal secret updated. Mirror SEED_SALT to the Vercel project env vars "
        "before redeploying the web app, or new visitors will read faces a "
        "different generation than the carousel computes locally.",
        fg="yellow",
    )


if __name__ == "__main__":
    cli()
