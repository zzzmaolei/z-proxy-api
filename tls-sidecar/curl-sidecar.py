#!/usr/bin/env python3
"""
curl-cffi TLS Sidecar

A drop-in replacement for the Go TLS sidecar that uses curl_cffi
for full browser impersonation (TLS + HTTP/2 + headers).

Protocol:
  - Listens on 127.0.0.1:<port> (default 9092)
  - Expects X-Target-Url header for the real target
  - X-Proxy-Url for upstream proxy (optional)
  - All other headers are forwarded as-is
  - Response body (including SSE streaming) is proxied back
"""

import sys
import json
import uuid
import base64
import hashlib
import hmac
import http.server
import urllib.parse
import threading
import time
import os
import io

try:
    import curl_cffi.requests
except ImportError:
    print("curl_cffi not installed. Run: pip install curl_cffi", file=sys.stderr)
    sys.exit(1)

PORT = int(os.environ.get("SIDECAR_PORT", "9092"))
IMPERSONATE = os.environ.get("SIDECAR_IMPERSONATE", "chrome142")
DEFAULT_TIMEOUT = 300

# Session cache per thread
_thread_local = threading.local()


def get_session():
    """Get or create a thread-local curl_cffi session"""
    if not hasattr(_thread_local, "session"):
        _thread_local.session = curl_cffi.requests.Session(
            impersonate=IMPERSONATE,
        )
        _thread_local.session.headers.update({
            "Accept-Language": "zh-CN",
            "Accept": "*/*",
        })
    return _thread_local.session


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self._handle_request("GET")

    def do_POST(self):
        self._handle_request("POST")

    def do_PUT(self):
        self._handle_request("PUT")

    def do_DELETE(self):
        self._handle_request("DELETE")

    def _handle_request(self, method):
        target_url = self.headers.get("X-Target-Url", "")
        proxy_url = self.headers.get("X-Proxy-Url", "")

        if not target_url:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b"Missing X-Target-Url header")
            return

        # Read body
        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length) if content_length > 0 else b""

        # Build headers (exclude our special headers and Host)
        headers = {}
        for key, value in self.headers.items():
            key_lower = key.lower()
            if key_lower in ("x-target-url", "x-proxy-url", "host", "content-length"):
                continue
            headers[key] = value

        is_stream = method == "POST" and b"stream" in body and b"true" in body

        try:
            session = get_session()
            kwargs = {
                "headers": headers,
                "timeout": DEFAULT_TIMEOUT,
            }

            if proxy_url:
                kwargs["proxies"] = {"http": proxy_url, "https": proxy_url}

            if body:
                kwargs["data"] = body
                if "content-type" not in headers:
                    kwargs["headers"]["content-type"] = "application/json"

            # For POST requests, if body is JSON, use json parameter for proper serialization
            if method == "POST" and body:
                ct = headers.get("content-type", "").lower()
                if "json" in ct:
                    try:
                        json_body = json.loads(body)
                        kwargs["json"] = json_body
                        del kwargs["data"]
                    except json.JSONDecodeError:
                        pass  # Use data as-is

            if is_stream:
                kwargs["stream"] = True

            resp = session.request(method, target_url, **kwargs)

            if is_stream:
                # Streaming response - forward chunk by chunk
                self.send_response(resp.status_code)
                for key, value in resp.headers.items():
                    if key.lower() not in ("content-length", "transfer-encoding", "content-encoding"):
                        self.send_header(key, value)
                self.send_header("Content-Type", resp.headers.get("content-type", "text/event-stream"))
                self.end_headers()

                for chunk in resp.iter_content(chunk_size=4096):
                    if chunk:
                        self.wfile.write(chunk)
                        self.wfile.flush()
            else:
                # Non-streaming response
                self.send_response(resp.status_code)
                for key, value in resp.headers.items():
                    if key.lower() not in ("content-length", "transfer-encoding", "content-encoding"):
                        self.send_header(key, value)
                self.send_header("Content-Length", str(len(resp.content)))
                self.end_headers()
                self.wfile.write(resp.content)

        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(f"Upstream error: {type(e).__name__}: {e}".encode())

    def log_message(self, format, *args):
        pass  # Suppress default logging


def main():
    server = http.server.HTTPServer(("127.0.0.1", PORT), ProxyHandler)
    server.timeout = 0.5
    print(f"[curl-sidecar] Started on 127.0.0.1:{PORT} impersonating={IMPERSONATE}", file=sys.stderr, flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("[curl-sidecar] Shutdown", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
