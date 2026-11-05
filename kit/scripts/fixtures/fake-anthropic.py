#!/usr/bin/env python3
"""A fake Anthropic Messages API for test-plugin.sh: a request that has tools and no tool result yet is answered with one Bash tool call, every other
request with plain text. Each request body is appended to <log> as one JSON line. Usage: fake-anthropic.py PORT_FILE LOG"""
import http.server
import json
import sys

PORT_FILE, LOG = sys.argv[1:3]
N = [0]


def sse(ev, data):
    return ("event: %s\ndata: %s\n\n" % (ev, json.dumps(data))).encode()


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        with open(LOG, "ab") as fh:
            fh.write(body.replace(b"\n", b" ") + b"\n")
        if "/v1/messages" not in self.path or "count_tokens" in self.path:
            self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers()
            self.wfile.write(b'{"input_tokens": 10}'); return
        N[0] += 1
        tool = b'"tools"' in body and b'"tool_result"' not in body
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
        w = self.wfile.write
        w(sse("message_start", {"type": "message_start", "message": {"id": "msg_%d" % N[0], "type": "message", "role": "assistant", "model": "claude-fake", "content": [], "stop_reason": None, "usage": {"input_tokens": 10, "output_tokens": 1}}}))
        if tool:
            w(sse("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "toolu_fake1", "name": "Bash", "input": {}}}))
            w(sse("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": json.dumps({"command": "echo guard-probe", "description": "probe"})}}))
        else:
            w(sse("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}))
            w(sse("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "done"}}))
        w(sse("content_block_stop", {"type": "content_block_stop", "index": 0}))
        w(sse("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use" if tool else "end_turn"}, "usage": {"output_tokens": 5}}))
        w(sse("message_stop", {"type": "message_stop"}))


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
open(PORT_FILE, "w").write(str(srv.server_address[1]))
srv.serve_forever()
