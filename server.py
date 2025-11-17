# save as server.py
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = 8888

class SharedArrayBufferHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=".", **kwargs)

    def end_headers(self):
        # Headers required for SharedArrayBuffer
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        if "lib" not in self.path:
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "revalidate")

        super().end_headers()


if __name__ == "__main__":
    httpd = HTTPServer(("0.0.0.0", PORT), SharedArrayBufferHandler)
    print(f"Serving current directory at http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
