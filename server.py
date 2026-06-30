# save as server.py
from http.server import HTTPServer, SimpleHTTPRequestHandler
import os
import re
import shutil

PORT = 8888

class SharedArrayBufferHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        self.range = None
        super().__init__(*args, directory=".", **kwargs)

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        ctype = self.guess_type(path)
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        size = os.fstat(f.fileno()).st_size
        range_header = self.headers.get("Range")
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match or (not match.group(1) and not match.group(2)):
                f.close()
                self.send_error(400, "Invalid Range header")
                return None

            start_s, end_s = match.groups()
            if start_s:
                start = int(start_s)
                end = int(end_s) if end_s else size - 1
            else:
                suffix_length = int(end_s)
                if suffix_length == 0:
                    start = size
                    end = size - 1
                else:
                    start = max(size - suffix_length, 0)
                    end = size - 1
            if start >= size or end < start:
                f.close()
                self.send_response(416)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return None

            end = min(end, size - 1)
            self.range = (start, end)
            self.send_response(206)
            self.send_header("Content-type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(end - start + 1))
            self.send_header("Last-Modified", self.date_time_string(os.fstat(f.fileno()).st_mtime))
            self.end_headers()
            f.seek(start)
            return f

        self.range = None
        self.send_response(200)
        self.send_header("Content-type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(size))
        self.send_header("Last-Modified", self.date_time_string(os.fstat(f.fileno()).st_mtime))
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        if self.range is None:
            shutil.copyfileobj(source, outputfile)
            return

        remaining = self.range[1] - self.range[0] + 1
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

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
