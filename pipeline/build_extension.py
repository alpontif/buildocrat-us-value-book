"""Package the Chrome extension (extension/) as docs/extension/buildocrat-value-lens.zip for download and Web Store upload."""
import os, zipfile, json
HERE = os.path.dirname(os.path.abspath(__file__)); SRC = os.path.join(HERE, '..', 'extension'); OUT = os.path.join(HERE, '..', 'docs', 'extension')
os.makedirs(OUT, exist_ok=True)
ver = json.load(open(os.path.join(SRC, 'manifest.json')))['version']
dst = os.path.join(OUT, 'buildocrat-value-lens.zip')
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(SRC):
        for f in sorted(files):
            p = os.path.join(root, f); z.write(p, os.path.relpath(p, SRC))
print('extension', ver, os.path.getsize(dst), 'bytes ->', dst)
