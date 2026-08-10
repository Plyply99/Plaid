#!/usr/bin/env python3
"""Plaid — stars-over-time chart generator (Dracula themed).

Fetches the stargazer history via the GitHub API and renders a
standalone SVG chart. Pure standard library, no dependencies.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

REPO = "Plyply99/Plaid"
TOKEN = os.environ.get("GITHUB_TOKEN", "")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "stars.svg")

BG = "#282a36"          # Dracula background
FG = "#f8f8f2"          # Dracula foreground
MUTED = "#6272a4"       # Dracula comment
GRID = "#44475a"        # Dracula selection
PURPLE = "#bd93f9"      # Plaid gradient color 1
GREEN = "#50fa7b"       # Plaid gradient color 2

W, H = 720, 240
ML, MR, MT, MB = 52, 16, 26, 34


def api(url):
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github.star+json",
            "User-Agent": "plaid-stars-chart",
            **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}),
        })
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def fetch_stargazers():
    stars = []
    page = 1
    while True:
        batch = api(
            f"https://api.github.com/repos/{REPO}/stargazers?per_page=100&page={page}")
        if not batch:
            break
        stars.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return stars


def fmt(d):
    return d.strftime("%b %d")


def main():
    stars = fetch_stargazers()
    if not stars:
        print("no stargazers yet")
        return

    days = sorted(datetime.fromisoformat(s["starred_at"].replace("Z", "+00:00"))
                  for s in stars)
    start = days[0].date()
    end = datetime.now(timezone.utc).date()
    span = max((end - start).days, 1)

    counts = {}
    for d in days:
        counts[d.date()] = counts.get(d.date(), 0) + 1

    total = len(stars)
    plot_w = W - ML - MR
    plot_h = H - MT - MB

    def x_at(day):
        return ML + plot_w * ((day - start).days / span)

    def y_at(n):
        return MT + plot_h * (1 - n / total)

    # daily cumulative points
    pts = []
    c = 0
    day = start
    while day <= end:
        c += counts.get(day, 0)
        pts.append((x_at(day), y_at(c)))
        day += timedelta(days=1)
    pts.append((x_at(end), y_at(c)))

    line = " ".join(f"{px:.1f},{py:.1f}" for px, py in pts)
    area = (f"M{pts[0][0]:.1f},{MT + plot_h:.1f} "
            f"L{line.replace(' ', ' L')} "
            f"L{pts[-1][0]:.1f},{MT + plot_h:.1f} Z")

    tick_n = 4
    step = max(1, round(total / tick_n))
    gridlines = ""
    ylabels = ""
    for n in range(0, total + 1, step):
        y = y_at(n)
        gridlines += f'<line x1="{ML}" y1="{y:.1f}" x2="{W - MR}" y2="{y:.1f}" stroke="{GRID}" stroke-width="1"/>'
        ylabels += f'<text x="{ML - 8}" y="{y + 4:.1f}" text-anchor="end" font-size="11" fill="{MUTED}">{n}</text>'

    xticks = ""
    for i in range(5):
        day = start + timedelta(days=round(span * i / 4))
        xticks += (f'<text x="{x_at(day):.1f}" y="{H - 12}" text-anchor="middle" '
                   f'font-size="11" fill="{MUTED}">{fmt(day)}</text>')

    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">
<defs>
<linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
<stop offset="0%" stop-color="{PURPLE}"/>
<stop offset="100%" stop-color="{GREEN}"/>
</linearGradient>
<linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="{PURPLE}" stop-opacity="0.28"/>
<stop offset="100%" stop-color="{GREEN}" stop-opacity="0.05"/>
</linearGradient>
</defs>
<rect width="{W}" height="{H}" fill="{BG}"/>
<text x="{ML}" y="18" font-size="13" font-weight="bold" fill="{FG}">Plaid — stars over time</text>
<text x="{W - MR}" y="18" text-anchor="end" font-size="12" fill="{GREEN}">{total} ★</text>
{gridlines}
{ylabels}
{xticks}
<path d="{area}" fill="url(#fill)"/>
<path d="M{line}" fill="none" stroke="url(#line)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
</svg>
"""

    with open(OUT, "w") as f:
        f.write(svg)
    print(f"chart written: {OUT} ({total} stars, {span + 1} days)")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"stars chart failed: {e}", file=sys.stderr)
        sys.exit(1)
