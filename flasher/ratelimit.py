"""Per-client request limits, in memory: a public page shouldn't let anyone use it to hammer
GitHub or fill the pod's bandwidth. Lost on restart, which is fine."""

import threading
import time
from collections import deque


class RateLimiter:
    def __init__(self, limit, window, clock=time.monotonic, max_clients=10000):
        self.limit = limit
        self.window = window
        self.clock = clock
        self.max_clients = max_clients
        self._hits = {}
        self._lock = threading.Lock()

    def allow(self, client):
        """(True, 0) if the client may go ahead, else (False, seconds until it may)."""
        with self._lock:
            now = self.clock()
            if len(self._hits) > self.max_clients:
                self._prune(now)
            q = self._hits.setdefault(client, deque())
            while q and now - q[0] >= self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False, max(1, int(self.window - (now - q[0])) + 1)
            q.append(now)
            return True, 0

    def _prune(self, now):
        for k in [k for k, q in self._hits.items() if not q or now - q[-1] >= self.window]:
            del self._hits[k]
