#!/usr/bin/env python3
"""Generate content/citymap.json — the 100x50 ASCII NYC silhouette behind the
city-map screen. Land is grown around neighborhood positions (which are already
geographically faithful in 0-100 space), then rivers are carved wherever two
boroughs that are separated by water in reality come close. Template cells are
2:1 (one row = two pos-units of y) so the map reads right in a monospace grid.

Chars: '~' water · 'm' manhattan · 'b' brooklyn · 'q' queens · 'x' bronx · 's' staten island
"""
import json
import math
import os

ROOT = os.path.join(os.path.dirname(__file__), '..')
W, H = 100, 50

# How far land spreads from each borough's neighborhoods (pos units).
RADIUS = {
    'manhattan': 3.2,   # a narrow island; keep it skinny
    'bronx': 5.5,
    'queens': 7.5,
    'brooklyn': 6.0,
    'staten_island': 6.5,
}
CHAR = {'manhattan': 'm', 'brooklyn': 'b', 'queens': 'q', 'bronx': 'x', 'staten_island': 's'}
# Brooklyn–Queens share a land border; every other borough pair is across water.
CONTIGUOUS = {frozenset(('brooklyn', 'queens'))}
RIVER_W = 2.6  # carve water where rival boroughs' distance fields nearly tie


def main() -> None:
    seeds = json.load(open(os.path.join(ROOT, 'content', 'neighborhoods.json')))['neighborhoods']
    by_borough: dict[str, list[tuple[float, float]]] = {}
    for s in seeds:
        by_borough.setdefault(s['borough'], []).append(tuple(s['pos']))

    def nearest(px: float, py: float) -> dict[str, float]:
        return {
            b: min(math.hypot(px - x, py - y) for x, y in pts)
            for b, pts in by_borough.items()
        }

    rows = []
    for ty in range(H):
        row = []
        for tx in range(W):
            px, py = tx + 0.5, ty * 2 + 1.0
            d = nearest(px, py)
            b1 = min(d, key=lambda b: d[b])
            if d[b1] > RADIUS[b1]:
                row.append('~')
                continue
            # River check: a second borough almost as close, across real water.
            water = False
            for b2, d2 in d.items():
                if b2 == b1 or frozenset((b1, b2)) in CONTIGUOUS:
                    continue
                if d2 <= RADIUS[b2] + RIVER_W and d2 - d[b1] < RIVER_W:
                    water = True
                    break
            row.append('~' if water else CHAR[b1])
        rows.append(''.join(row))

    # Every hood must sit on its own borough's land — fix collateral carving.
    for s in seeds:
        tx, ty = min(W - 1, round(s['pos'][0])), min(H - 1, round(s['pos'][1] / 2))
        r = rows[ty]
        rows[ty] = r[:tx] + CHAR[s['borough']] + r[tx + 1:]

    out = {'w': W, 'h': H, 'rows': rows}
    path = os.path.join(ROOT, 'content', 'citymap.json')
    json.dump(out, open(path, 'w'), indent=1)
    print(f'wrote {path}')
    for r in rows:
        print(r.replace('~', '·'))


if __name__ == '__main__':
    main()
