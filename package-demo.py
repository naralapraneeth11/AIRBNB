from pathlib import Path
import base64
import zipfile

root = Path(__file__).resolve().parent
dist = root / 'dist'
html = (dist / 'index.html').read_text()
css = (dist / 'styles.css').read_text()
js = (dist / 'app.js').read_text()
for name in ('desert.jpg', 'coast.jpg', 'cabin.jpg'):
    data = 'data:image/jpeg;base64,' + base64.b64encode((dist / name).read_bytes()).decode()
    js = js.replace("'" + name + "'", "'" + data + "'")
html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>' + css + '</style>')
html = html.replace('<script src="app.js"></script>', '<script>' + js + '</script>')
(root / 'Airbnb-Automation.html').write_text(html)
with zipfile.ZipFile(root / 'Airbnb-Automation.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for path in [root/'Airbnb-Automation.html', root/'README.md', root/'package-demo.py', *dist.iterdir()]:
        if path.is_file():
            archive.write(path, Path('Airbnb-Automation') / path.relative_to(root))
print('Created Airbnb-Automation.html and Airbnb-Automation.zip')
