#!/usr/bin/env python3
"""Generate the DepLens VS Code extension icon."""

import math
import struct
import zlib

W = H = 128

def create_png(width, height, pixels):
    """Create a PNG file from RGBA pixel data."""
    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)
        return struct.pack('>I', len(data)) + c + crc

    header = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))

    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter none
        for x in range(width):
            idx = (y * width + x) * 4
            raw += bytes(pixels[idx:idx+4])

    idat = chunk(b'IDAT', zlib.compress(raw, 9))
    iend = chunk(b'IEND', b'')
    return header + ihdr + idat + iend


def lerp(a, b, t):
    return a + (b - a) * max(0, min(1, t))

def lerp_color(c1, c2, t):
    return tuple(int(lerp(c1[i], c2[i], t)) for i in range(len(c1)))

def dist(x1, y1, x2, y2):
    return math.sqrt((x1-x2)**2 + (y1-y2)**2)

def alpha_blend(bg, fg, alpha):
    """Blend fg over bg with given alpha (0-1)."""
    a = alpha
    return tuple(int(bg[i] * (1-a) + fg[i] * a) for i in range(3))


# ── Color palette ──
BG_TOP = (15, 28, 48)       # deep navy
BG_BOT = (8, 45, 58)        # dark teal
RING_OUTER = (40, 180, 200) # bright teal
RING_INNER = (80, 210, 230) # cyan highlight
HANDLE_COLOR = (30, 140, 165)
GLASS_TINT = (20, 90, 120)
NODE_COLOR = (255, 255, 255)
EDGE_COLOR = (80, 200, 220)
GLOW = (60, 200, 230)

cx, cy = 54, 54         # lens center
lens_r = 34              # lens radius
ring_width = 4.5
handle_angle = math.radians(135)  # bottom-right
handle_len = 32
handle_w = 7

# ── Dependency graph nodes (inside lens) ──
nodes = [
    (54, 42, 5.5),   # top center — main package
    (38, 56, 4.0),   # bottom left
    (54, 62, 4.0),   # bottom center
    (70, 56, 4.0),   # bottom right
    (42, 42, 3.0),   # left satellite
    (66, 42, 3.0),   # right satellite
]

edges = [
    (0, 1), (0, 2), (0, 3), (0, 4), (0, 5),
    (1, 2), (2, 3),
]

pixels = [0] * (W * H * 4)

for y in range(H):
    for x in range(W):
        idx = (y * W + x) * 4

        # ── Background gradient ──
        t = y / H
        bg = lerp_color(BG_TOP, BG_BOT, t)

        # Subtle radial vignette
        d_center = dist(x, y, W/2, H/2) / (W * 0.7)
        vignette = max(0, min(1, d_center * 0.3))
        r = int(bg[0] * (1 - vignette))
        g = int(bg[1] * (1 - vignette))
        b = int(bg[2] * (1 - vignette))
        color = (r, g, b)
        alpha = 255

        d_lens = dist(x, y, cx, cy)

        # ── Outer glow around lens ──
        if d_lens < lens_r + 12 and d_lens > lens_r + ring_width/2:
            glow_t = 1.0 - (d_lens - lens_r - ring_width/2) / 12
            glow_t = max(0, glow_t) ** 2 * 0.15
            color = alpha_blend(color, GLOW, glow_t)

        # ── Glass area (inside lens) ──
        if d_lens < lens_r - ring_width/2:
            # Glass tint with slight magnification effect
            glass_t = 0.3 + 0.1 * (1 - d_lens / lens_r)
            color = alpha_blend(color, GLASS_TINT, glass_t)

            # Subtle inner radial gradient for depth
            inner_t = d_lens / lens_r
            highlight = lerp_color((40, 120, 160), (15, 60, 90), inner_t)
            color = alpha_blend(color, highlight, 0.2)

            # ── Draw edges inside lens ──
            for i1, i2 in edges:
                nx1, ny1, _ = nodes[i1]
                nx2, ny2, _ = nodes[i2]

                # Point-to-segment distance
                dx_e = nx2 - nx1
                dy_e = ny2 - ny1
                len_sq = dx_e*dx_e + dy_e*dy_e
                if len_sq > 0:
                    t_param = max(0, min(1, ((x - nx1)*dx_e + (y - ny1)*dy_e) / len_sq))
                    proj_x = nx1 + t_param * dx_e
                    proj_y = ny1 + t_param * dy_e
                    d_edge = dist(x, y, proj_x, proj_y)
                    if d_edge < 1.8:
                        edge_a = (1.0 - d_edge / 1.8) * 0.6
                        color = alpha_blend(color, EDGE_COLOR, edge_a)

            # ── Draw nodes inside lens ──
            for nx, ny, nr in nodes:
                d_node = dist(x, y, nx, ny)
                if d_node < nr + 1.0:
                    if d_node < nr - 0.5:
                        node_a = 0.95
                    else:
                        node_a = (1.0 - (d_node - nr + 0.5) / 1.5) * 0.95
                    node_a = max(0, min(1, node_a))
                    # Center node is slightly brighter/larger
                    c = NODE_COLOR
                    color = alpha_blend(color, c, node_a)

            # ── Glass specular highlight (top-left) ──
            spec_cx, spec_cy = cx - 14, cy - 14
            d_spec = dist(x, y, spec_cx, spec_cy)
            if d_spec < 18:
                spec_t = (1.0 - d_spec / 18) ** 2 * 0.18
                color = alpha_blend(color, (255, 255, 255), spec_t)

        # ── Lens ring ──
        ring_inner = lens_r - ring_width/2
        ring_outer = lens_r + ring_width/2
        if d_lens >= ring_inner - 1 and d_lens <= ring_outer + 1:
            # Anti-aliased ring
            if d_lens < ring_inner:
                ring_a = 1.0 - (ring_inner - d_lens)
            elif d_lens > ring_outer:
                ring_a = 1.0 - (d_lens - ring_outer)
            else:
                ring_a = 1.0
            ring_a = max(0, min(1, ring_a))

            # Metallic gradient across ring
            angle = math.atan2(y - cy, x - cx)
            metal_t = (math.sin(angle * 2) + 1) / 2
            ring_color = lerp_color(RING_OUTER, RING_INNER, metal_t)

            # Slight highlight on top edge
            if d_lens < lens_r:
                edge_highlight = 0.2 * max(0, (cy - y) / lens_r)
                ring_color = alpha_blend(ring_color, (200, 240, 255), edge_highlight)

            color = alpha_blend(color, ring_color, ring_a)

        # ── Handle ──
        hx_start = cx + math.cos(handle_angle) * (lens_r + ring_width/2 - 2)
        hy_start = cy + math.sin(handle_angle) * (lens_r + ring_width/2 - 2)
        hx_end = hx_start + math.cos(handle_angle) * handle_len
        hy_end = hy_start + math.sin(handle_angle) * handle_len

        # Point-to-segment distance for handle
        hdx = hx_end - hx_start
        hdy = hy_end - hy_start
        h_len_sq = hdx*hdx + hdy*hdy
        if h_len_sq > 0:
            ht = max(0, min(1, ((x - hx_start)*hdx + (y - hy_start)*hdy) / h_len_sq))
            hpx = hx_start + ht * hdx
            hpy = hy_start + ht * hdy
            d_handle = dist(x, y, hpx, hpy)

            # Tapered handle — wider at base, narrower at tip
            local_w = lerp(handle_w/2, handle_w/2 - 1.5, ht)

            if d_handle < local_w + 1:
                if d_handle < local_w - 0.5:
                    h_a = 0.95
                else:
                    h_a = (1.0 - (d_handle - local_w + 0.5) / 1.5) * 0.95
                h_a = max(0, min(1, h_a))

                # Gradient along handle for depth
                h_color = lerp_color(HANDLE_COLOR, lerp_color(HANDLE_COLOR, (20, 100, 130), 0.5), ht)

                # Highlight on one side
                perp_angle = handle_angle + math.pi/2
                side = (x - hpx) * math.cos(perp_angle) + (y - hpy) * math.sin(perp_angle)
                if side < 0:
                    h_color = alpha_blend(h_color, RING_INNER, 0.25)

                color = alpha_blend(color, h_color, h_a)

                # Handle edge highlight
                if abs(d_handle - local_w) < 1.0:
                    edge_a = (1.0 - abs(d_handle - local_w)) * 0.3
                    color = alpha_blend(color, RING_INNER, edge_a)

        # ── Small accent: version arrow indicator (bottom-right area, subtle) ──
        # A tiny upward arrow near bottom-right to hint at "upgrade"
        arrow_cx, arrow_cy = 102, 100
        d_arrow = dist(x, y, arrow_cx, arrow_cy)
        if d_arrow < 12:
            # Arrow shaft
            if abs(x - arrow_cx) < 1.5 and arrow_cy - 7 < y < arrow_cy + 5:
                shaft_a = (1.0 - abs(x - arrow_cx) / 1.5) * 0.5
                color = alpha_blend(color, RING_INNER, shaft_a)
            # Arrow head
            dy_head = y - (arrow_cy - 7)
            if 0 <= dy_head <= 5:
                head_half_w = dy_head * 1.0
                if abs(x - arrow_cx) <= head_half_w + 1:
                    if abs(x - arrow_cx) <= head_half_w:
                        head_a = 0.5
                    else:
                        head_a = 0.5 * (1.0 - (abs(x - arrow_cx) - head_half_w))
                    color = alpha_blend(color, RING_INNER, max(0, head_a))

        pixels[idx] = max(0, min(255, color[0]))
        pixels[idx+1] = max(0, min(255, color[1]))
        pixels[idx+2] = max(0, min(255, color[2]))
        pixels[idx+3] = alpha

png_data = create_png(W, H, pixels)
with open('/Users/andre/dev/code/dep-lens/icon.png', 'wb') as f:
    f.write(png_data)

print(f"Icon generated: {len(png_data)} bytes")
