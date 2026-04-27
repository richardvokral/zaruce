"""Modal serverless face generator.

Public endpoints:
    GET  /face?slot=<n>&bucket=<id?>      — JPEG of a face, deterministic per slot
    GET  /admin/status                    — bucket coverage report
    POST /admin/regen                     — regenerate seed list for one bucket
    POST /admin/warm                      — pre-warm a list of slots

Behavior:
    * Derives the StyleGAN3 seed deterministically from the slot index, with
      an optional bucket override that picks a seed pre-classified to match
      the visitor's selfie attributes.
    * Generates a 256x256 JPEG (configurable up to 512).
    * Modal's response cache + Cloudflare in front handle reuse of the same seed.

Weights aren't bundled. On first deploy the volume is hydrated from the URL
in WEIGHTS_URL (defaults to NVIDIA's FFHQ-U checkpoint).
"""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import os
import struct
from typing import Optional

import modal

from population import current_total_slots

APP_NAME = "zaruce-face-generator"
WEIGHTS_VOLUME = "zaruce-stylegan-weights"
LOOKUP_VOLUME = "zaruce-bucket-lookup"

image = (
    # StyleGAN3's bias_act / filtered_lrelu / upfirdn2d ops are JIT-compiled
    # CUDA extensions, so the image needs the full CUDA toolchain (nvcc +
    # headers), not just the runtime libs that ship inside the torch wheel.
    # Pin to 12.1.1-devel to match torch==2.4.0's cu121 build.
    modal.Image.from_registry(
        "nvidia/cuda:12.1.1-devel-ubuntu22.04",
        add_python="3.11",
    )
    .apt_install("git", "build-essential", "libgl1", "libglib2.0-0")
    .pip_install(
        "torch==2.4.0",
        "numpy<2",
        "pillow>=10",
        "ninja",
        "scipy",
        "click",
        "fastapi",
        # StyleGAN3's dnnlib/util.py and torch_utils import these at module
        # load time (well before any of our code runs). Without them every
        # FaceGenerator container crashes during setup() with ModuleNotFound,
        # Modal retries indefinitely, and the HTTP request hangs forever.
        "requests",
        "imageio",
        "psutil",
    )
    # StyleGAN3 reference repo — pinned to the public NVIDIA release.
    .run_commands("git clone https://github.com/NVlabs/stylegan3 /opt/stylegan3")
    .env({"PYTHONPATH": "/opt/stylegan3"})
    # Bring local helper modules (population, build_lookup) into the image.
    .add_local_python_source("population", "build_lookup")
)

weights_volume = modal.Volume.from_name(WEIGHTS_VOLUME, create_if_missing=True)
lookup_volume = modal.Volume.from_name(LOOKUP_VOLUME, create_if_missing=True)

app = modal.App(APP_NAME, image=image)


# ---------------------------------------------------------------------------
# Seed derivation — must match packages/shared/src/seed.ts.

def _seed_for_slot(index: int, salt: str) -> int:
    payload = struct.pack(">Q", index)
    mac = hmac.new(salt.encode("utf-8"), payload, hashlib.sha256).digest()
    return struct.unpack(">I", mac[:4])[0]


def _pick_seed_from_bucket(index: int, seeds: list[int], salt: str) -> int:
    if not seeds:
        raise ValueError("empty bucket")
    payload = struct.pack(">Q", index)
    mac = hmac.new(salt.encode("utf-8"), payload, hashlib.sha256).digest()
    pick = struct.unpack(">I", mac[:4])[0]
    return seeds[pick % len(seeds)]


# ---------------------------------------------------------------------------


@app.cls(
    gpu="A10G",
    volumes={"/weights": weights_volume, "/lookup": lookup_volume},
    secrets=[modal.Secret.from_name("zaruce-secrets")],
    # Keep a warm GPU container around for ten minutes after the last request
    # so adjacent slot views (carousel scroll) don't each pay a cold-start.
    scaledown_window=600,
    min_containers=0,
    # First call has to download ~300 MB of StyleGAN3 weights from NVIDIA into
    # the volume and load the model into VRAM. Default 300 s isn't enough.
    timeout=1800,
)
class FaceGenerator:
    @modal.enter()
    def setup(self) -> None:
        import shutil
        import subprocess
        import sys
        import torch
        import pickle

        sys.path.insert(0, "/opt/stylegan3")

        # Surface the build environment up front so future cold-starts don't
        # need an extra debug round-trip to figure out what's missing.
        nvcc = shutil.which("nvcc") or "/usr/local/cuda/bin/nvcc"
        try:
            nvcc_version = subprocess.check_output([nvcc, "--version"], text=True).strip()
        except Exception as e:
            nvcc_version = f"<nvcc not runnable: {e!r}>"
        print(f"[setup] torch={torch.__version__} cuda_runtime={torch.version.cuda}", flush=True)
        print(f"[setup] nvcc path={nvcc}", flush=True)
        print(f"[setup] nvcc --version:\n{nvcc_version}", flush=True)
        if torch.cuda.is_available():
            cap = torch.cuda.get_device_capability(0)
            name = torch.cuda.get_device_name(0)
            print(f"[setup] gpu={name} compute_capability={cap[0]}.{cap[1]}", flush=True)
        else:
            print("[setup] WARNING: CUDA not available", flush=True)

        # Restrict JIT compile to the GPU arch we actually run on. Without this
        # nvcc tries every supported arch and can fail on the rare ones.
        os.environ.setdefault("TORCH_CUDA_ARCH_LIST", "8.0;8.6;8.9;9.0")

        weights_path = "/weights/stylegan3-r-ffhq-1024x1024.pkl"
        if not os.path.exists(weights_path):
            # Fail fast instead of trying a multi-minute download inside the
            # HTTP request path — Modal's web endpoint layer caps requests
            # around 5 minutes and the user just sees a timeout page.
            # Run `modal run main.py::download_weights` once after deploy.
            raise RuntimeError(
                f"weights missing at {weights_path}; "
                "run `modal run main.py::download_weights` once before serving"
            )

        with open(weights_path, "rb") as fh:
            self.G = pickle.load(fh)["G_ema"].cuda().eval()
        self.device = torch.device("cuda")

        # Pre-warm StyleGAN3's JIT-compiled CUDA plugins WITH verbose output so
        # any nvcc failure is visible in Modal logs. StyleGAN3's own _init()
        # swallows the real error behind a bare "Failed!" print, which is what
        # made the previous debug round so painful.
        self._warm_plugins()

        lookup_path = "/lookup/bucket_seeds.json"
        if os.path.exists(lookup_path):
            with open(lookup_path) as fh:
                self.bucket_lookup: dict[str, list[int]] = json.load(fh)
        else:
            self.bucket_lookup = {}

        self.salt = os.environ["SEED_SALT"]
        self.resolution = int(os.environ.get("FACE_RESOLUTION", "256"))

    def _warm_plugins(self) -> None:
        """Force JIT-compile of bias_act / filtered_lrelu / upfirdn2d at
        container startup, surfacing any compiler error explicitly. After this
        runs once the .so files are cached under /root/.cache/torch_extensions
        and subsequent generate() calls reuse them instantly."""
        from torch.utils import cpp_extension as _ext

        # Wrap torch's loader to force verbose=True so we see nvcc's stderr
        # in Modal logs even when StyleGAN3 catches the resulting exception.
        original_load = _ext.load
        def loud_load(*args, **kwargs):
            kwargs["verbose"] = True
            return original_load(*args, **kwargs)
        _ext.load = loud_load

        try:
            from torch_utils.ops import bias_act, filtered_lrelu, upfirdn2d  # noqa: F401
            for label, init in (
                ("bias_act", bias_act._init),
                ("filtered_lrelu", filtered_lrelu._init),
                ("upfirdn2d", upfirdn2d._init),
            ):
                print(f"[setup] warming {label}_plugin…", flush=True)
                ok = init()
                print(f"[setup] {label}_plugin _init() -> {ok}", flush=True)
        except Exception as e:
            print(f"[setup] plugin warm-up failed: {e!r}", flush=True)
            raise
        finally:
            _ext.load = original_load

    def _resolve_seed(self, slot_index: int, bucket_id: Optional[int]) -> int:
        if bucket_id is None:
            return _seed_for_slot(slot_index, self.salt)
        seeds = self.bucket_lookup.get(str(bucket_id))
        if seeds:
            return _pick_seed_from_bucket(slot_index, seeds, self.salt)
        # Fallback to anonymous derivation if the bucket is empty.
        return _seed_for_slot(slot_index, self.salt)

    @modal.method()
    def generate(self, slot_index: int, bucket_id: Optional[int] = None) -> bytes:
        import numpy as np
        import torch
        from PIL import Image

        seed = self._resolve_seed(slot_index, bucket_id)
        z = torch.from_numpy(np.random.RandomState(seed).randn(1, self.G.z_dim)).to(self.device)
        with torch.no_grad():
            img = self.G(z, None, truncation_psi=0.7, noise_mode="const")
        img = (img.clamp(-1, 1) + 1) * (255 / 2)
        img = img.permute(0, 2, 3, 1).to(torch.uint8).cpu().numpy()[0]
        pil = Image.fromarray(img, "RGB")
        if pil.size[0] != self.resolution:
            pil = pil.resize((self.resolution, self.resolution), Image.LANCZOS)
        buf = io.BytesIO()
        pil.save(buf, format="JPEG", quality=85, optimize=True)
        return buf.getvalue()


@app.function(
    image=image,
    volumes={"/weights": weights_volume},
    secrets=[modal.Secret.from_name("zaruce-secrets")],
    timeout=3600,
)
def download_weights() -> str:
    """One-shot: pull the StyleGAN3 checkpoint into the weights volume.

    Run from the CLI after the very first deploy:

        modal run services/face-generator/main.py::download_weights

    Splitting this out of FaceGenerator.setup() keeps the HTTP request path
    fast — Modal's fastapi_endpoint layer caps requests around 5 minutes,
    which isn't enough to download 300 MB from NVIDIA on a cold container.
    """
    import urllib.request

    weights_path = "/weights/stylegan3-r-ffhq-1024x1024.pkl"
    if os.path.exists(weights_path):
        return f"already present at {weights_path}"

    url = os.environ.get(
        "WEIGHTS_URL",
        "https://api.ngc.nvidia.com/v2/models/nvidia/research/stylegan3/versions/1/files/stylegan3-r-ffhqu-1024x1024.pkl",
    )
    os.makedirs(os.path.dirname(weights_path), exist_ok=True)
    urllib.request.urlretrieve(url, weights_path)
    weights_volume.commit()
    return f"downloaded {url} -> {weights_path}"


@app.function(
    image=image,
    volumes={"/weights": weights_volume, "/lookup": lookup_volume},
    secrets=[modal.Secret.from_name("zaruce-secrets")],
    # The HTTP request stays open while we wait for the GPU class to spin up
    # and produce the JPEG. Default 300 s expires before a cold first-deploy
    # finishes weight download + model load.
    timeout=900,
)
@modal.fastapi_endpoint(method="GET", label="face")
def face_endpoint(slot: int, bucket: Optional[int] = None):
    """Public HTTP entrypoint. Cloudflare sits in front and caches the response."""
    from fastapi import HTTPException
    from fastapi.responses import Response

    if slot < 0 or slot >= current_total_slots():
        raise HTTPException(status_code=404, detail="slot out of range")

    generator = FaceGenerator()
    body: bytes = generator.generate.remote(slot, bucket)
    return Response(
        content=body,
        media_type="image/jpeg",
        headers={"cache-control": "public, max-age=31536000, immutable"},
    )


# ---------------------------------------------------------------------------
# Admin surface — token-gated. Same ADMIN_TOKEN as the Vercel admin routes.
# ---------------------------------------------------------------------------


def _check_admin(authorization: Optional[str]) -> None:
    from fastapi import HTTPException

    expected = os.environ.get("ADMIN_TOKEN")
    if not expected:
        raise HTTPException(status_code=503, detail="admin disabled (no token configured)")
    if authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="unauthorized")


@app.function(
    image=image,
    volumes={"/lookup": lookup_volume},
    secrets=[modal.Secret.from_name("zaruce-secrets")],
)
@modal.fastapi_endpoint(method="GET", label="admin-status")
def admin_status(authorization: Optional[str] = None):
    """Bucket coverage report. Useful both as a CLI sanity check and as a
    lightweight dashboard endpoint."""
    _check_admin(authorization)

    lookup_path = "/lookup/bucket_seeds.json"
    if not os.path.exists(lookup_path):
        return {"buckets_filled": 0, "missing": None, "smallest": None, "largest": None}

    with open(lookup_path) as fh:
        data: dict[str, list[int]] = json.load(fh)

    sizes = {bid: len(seeds) for bid, seeds in data.items()}
    if not sizes:
        return {"buckets_filled": 0}
    smallest_id, smallest_n = min(sizes.items(), key=lambda kv: kv[1])
    largest_id, largest_n = max(sizes.items(), key=lambda kv: kv[1])
    return {
        "buckets_filled": len(sizes),
        "smallest": {"id": smallest_id, "count": smallest_n},
        "largest": {"id": largest_id, "count": largest_n},
        "total_seeds": sum(sizes.values()),
    }


@app.function(
    image=image,
    gpu="A10G",
    volumes={"/weights": weights_volume, "/lookup": lookup_volume},
    secrets=[modal.Secret.from_name("zaruce-secrets")],
    timeout=3600,
)
@modal.fastapi_endpoint(method="POST", label="admin-regen")
def admin_regen(bucket_id: int, samples: int = 5000, authorization: Optional[str] = None):
    """Re-sample seeds for a single bucket. Useful after the attribute
    taxonomy or classifier changes."""
    _check_admin(authorization)

    from build_lookup import regen_bucket
    written = regen_bucket(bucket_id=bucket_id, samples=samples)
    return {"bucket_id": bucket_id, "seeds_written": written}


@app.function(
    image=image,
    gpu="A10G",
    volumes={"/weights": weights_volume, "/lookup": lookup_volume},
    secrets=[modal.Secret.from_name("zaruce-secrets")],
    timeout=24 * 3600,
)
def build_lookup_entry(samples: int = 50_000) -> dict[str, int]:
    """Heavyweight job invoked from the admin CLI as
        modal run main.py::build_lookup_entry --samples 50000
    Generates `samples` faces, classifies each, dumps bucket_seeds.json,
    and commits the lookup volume."""
    from build_lookup import write_full_lookup
    counts = write_full_lookup(samples=samples)
    lookup_volume.commit()
    return counts


@app.function(
    image=image,
    gpu="A10G",
    volumes={"/weights": weights_volume, "/lookup": lookup_volume},
    secrets=[modal.Secret.from_name("zaruce-secrets")],
    timeout=600,
)
@modal.fastapi_endpoint(method="POST", label="admin-warm")
def admin_warm(indices: str, authorization: Optional[str] = None):
    """Pre-warm a comma-separated list of slot indices. Used before
    marketing screenshots or load tests."""
    _check_admin(authorization)

    parsed = [int(x) for x in indices.split(",") if x.strip()]
    generator = FaceGenerator()
    for idx in parsed:
        generator.generate.remote(idx, None)
    return {"warmed": len(parsed)}
