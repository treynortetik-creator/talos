# Runs `<bun> <probe>` as a BACKGROUND job of an interactive bash whose controlling terminal is a real pty: how a supervisor
# started by hand from a terminal runs. Prints the probe's output, then the job's state (`Stopped (tty input)` when job control
# stopped it), then PROBE_DONE; HUNG when nothing finished within the limit. Python 3, standard library only.
import os, pty, select, sys, time

bun, probe, limit = sys.argv[1], sys.argv[2], float(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.execvp('bash', ['bash', '--norc', '--noprofile', '-i', '-c',
                       f'set -m; "{bun}" "{probe}" & wait $!; sleep 1; jobs -l; echo PROBE_DONE'])
out = b''
deadline = time.time() + limit
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
        if b'PROBE_DONE' in out:
            break
text = out.decode('utf8', 'replace')
print(text if 'PROBE_DONE' in text else text + '\nHUNG')
try:
    os.killpg(os.getpgid(pid), 9)
except Exception:
    pass
