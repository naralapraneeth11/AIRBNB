"""Create a reproducible, source-only ZIP for manual GitHub upload."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import hashlib

root = Path(__file__).resolve().parents[1]
destination = root.parent / "Airbnb-Automation-Source.zip"
folders = ("src", "prisma", "public", "scripts", "tests", "docs", ".github")
files = ("README.md", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
         "tsconfig.json", "next-env.d.ts", "next.config.ts", "vercel.json",
         ".env.example", ".gitignore", ".prettierignore")
paths = [root / file for file in files]
paths += [p for folder in folders for p in (root / folder).rglob("*") if p.is_file()]
paths = sorted(set(paths))
with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
    for path in paths:
        relative = path.relative_to(root)
        if any(part.startswith(".env") and part != ".env.example" for part in relative.parts):
            raise RuntimeError(f"Refusing environment secret file: {relative}")
        if path.is_symlink() or path.name in (".DS_Store",) or "__pycache__" in relative.parts:
            continue
        info = ZipInfo("airbnb-automation/" + relative.as_posix(), (2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes())
digest = hashlib.sha256(destination.read_bytes()).hexdigest()
destination.with_suffix(".zip.sha256").write_text(f"{digest}  {destination.name}\n")
print(f"Created {destination} ({destination.stat().st_size:,} bytes)")
print(f"SHA-256 {digest}")
