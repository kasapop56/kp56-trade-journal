import os, sys

ROOT = '/Users/kasapopprapaspongsa/Documents/KP56/trade-journal'
# Set CWD before any stdlib import that depends on it. The preview-tool spawn
# context can land in a directory the process can't stat, which crashes
# http.server's argparse defaults at import time.
try:
    os.chdir(ROOT)
except Exception:
    pass

import http.server, socketserver

PORT = 3456

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'Serving {ROOT} at http://localhost:{PORT}', flush=True)
    httpd.serve_forever()
