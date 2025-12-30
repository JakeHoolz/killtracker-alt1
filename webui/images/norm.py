import os
import re

def normalize(name: str) -> str:
    name = name.lower()
    name = re.sub(r'[^a-z0-9 ]+', '_', name)   # replace symbols
    name = re.sub(r'_+', '_', name)            # collapse underscores
    return name.strip('_ ').strip()             # trim edges


for root, _, files in os.walk('.'):
    for filename in files:
        old_path = os.path.join(root, filename)

        base, ext = os.path.splitext(filename)
        new_base = normalize(base)
        new_name = new_base + ext
        new_path = os.path.join(root, new_name)

        if old_path != new_path:
            print(f"{old_path} -> {new_path}")
            os.rename(old_path, new_path)
