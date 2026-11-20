"""Measured CO₂ exposure over a rolling day. Gaps never count as exposure."""

from collections import deque

DAY = 86400
# Allow scheduling jitter, but never bridge a missed five-second poll.
MAX_INTERVAL = 9


class Coverage:
    def __init__(self, segments=()):
        self.segments = deque(segments)
        self.previous = None

    def sample(self, now, value):
        while self.segments and self.segments[0][1] <= now - DAY:
            self.segments.popleft()
        if self.previous and value is not None:
            start, high = self.previous
            if 0 < now - start <= MAX_INTERVAL:
                if self.segments and self.segments[-1][1:] == [start, high]:
                    self.segments[-1][1] = now
                else:
                    self.segments.append([start, now, high])
        self.previous = (now, value > 1200) if value is not None else None

    def totals(self, now):
        covered = high = 0
        for start, end, exceeded in self.segments:
            duration = max(0, min(end, now) - max(start, now - DAY))
            covered += duration
            if exceeded:
                high += duration
        return {"covered": round(covered), "high": round(high) if covered else None}
