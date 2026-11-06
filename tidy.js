// Tidy-up arm: drag things around the page; a robot arm puts them back.
(() => {
    const finePointer = matchMedia('(pointer: fine)').matches;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Links inside paragraphs can be pulled out on their own; grab the text around them to move the whole paragraph.
    const SELECTOR = finePointer
        ? '#site-title a, #site-title-small a, nav a, main img, main h1, main h2, main p, main p a, main li, main dt, main dd, .rotated-text-container p'
        : '#site-title a, #site-title-small a, nav a, main img, main h1, main h2, main dt, main dd';

    const IDLE_BEFORE_TIDY = 900;   // ms after the last drop
    const DRAG_THRESHOLD = 5;       // px before a press becomes a drag

    // ---------- Styles ----------
    const style = document.createElement('style');
    style.textContent = `
        html { overflow-x: hidden; }
        body > main > article { overflow: visible; }
        .tidy-item:not(a) { cursor: grab; }
        .rotated-text-container p { pointer-events: auto; }
        .tidy-moved { position: relative; z-index: 1500; }
        .tidy-moved:not(img) { background-color: var(--background); box-shadow: 0 0 0 6px var(--background); border-radius: 2px; }
        .tidy-dragging, .tidy-dragging * { cursor: grabbing !important; }
        .tidy-dragging { z-index: 1600; }
        .tidy-lifted { filter: drop-shadow(0 10px 14px rgba(0, 0, 0, 0.35)); }
        .tidy-no-select, .tidy-no-select * { user-select: none !important; -webkit-user-select: none !important; }
        #tidy-arm { position: fixed; inset: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 1900; }
    `;
    document.head.appendChild(style);

    // ---------- Items ----------
    const state = new Map(); // el -> { x, y, rot, dragging }

    function apply(el) {
        const s = state.get(el);
        const moved = Math.abs(s.x) > 0.5 || Math.abs(s.y) > 0.5 || Math.abs(s.rot) > 0.2;
        const out = moved || s.dragging || arm.held === el;
        if (s.inline) el.style.display = out ? 'inline-block' : '';
        el.style.transform = moved ? `translate(${s.x}px, ${s.y}px) rotate(${s.rot}deg)` : '';
        el.classList.toggle('tidy-moved', out);
    }

    function isMessy(s) {
        return Math.abs(s.x) > 1 || Math.abs(s.y) > 1 || Math.abs(s.rot) > 0.5;
    }

    function center(el) {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    // Where the item's centre sits when it is back in place (viewport coords).
    function home(el) {
        const c = center(el), s = state.get(el);
        return { x: c.x - s.x, y: c.y - s.y };
    }

    document.querySelectorAll(SELECTOR).forEach(el => {
            // Inline elements can't be transformed. They become inline-block only while out of place,
            // so long links in paragraphs still wrap normally the rest of the time.
            const inline = getComputedStyle(el).display === 'inline';
            state.set(el, { x: 0, y: 0, rot: 0, dragging: false, inline });
            el.classList.add('tidy-item');
            if (!finePointer) el.style.touchAction = 'none';
            if (el.tagName === 'IMG') el.draggable = false;
        });

    // ---------- Dragging ----------
    let press = null;
    let tidyTimer = null;

    document.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const el = e.target.closest('.tidy-item');
        if (!el) return;
        const s = state.get(el);
        press = { el, id: e.pointerId, sx: e.clientX, sy: e.clientY, bx: s.x, by: s.y, brot: s.rot, dragging: false };
    });

    window.addEventListener('pointermove', e => {
        if (!press || e.pointerId !== press.id) return;
        const dx = e.clientX - press.sx, dy = e.clientY - press.sy;
        const s = state.get(press.el);

        if (!press.dragging) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
            press.dragging = true;
            s.dragging = true;
            clearTimeout(tidyTimer);
            if (arm.held === press.el) arm.drop();
            window.getSelection()?.removeAllRanges();
            document.documentElement.classList.add('tidy-no-select', 'tidy-dragging');
            press.el.classList.add('tidy-lifted');
        }

        e.preventDefault();
        s.x = press.bx + dx;
        s.y = press.by + dy;
        s.rot = press.brot + Math.max(-10, Math.min(10, (e.movementX || 0) * 0.6));
        apply(press.el);
    }, { passive: false });

    function endPress(e, cancelled) {
        if (!press || e.pointerId !== press.id) return;
        const { el, dragging } = press;
        press = null;
        if (!dragging) return;

        const s = state.get(el);
        s.dragging = false;
        s.rot = (Math.random() * 2 - 1) * 7;
        apply(el);
        el.classList.remove('tidy-lifted');
        document.documentElement.classList.remove('tidy-no-select', 'tidy-dragging');

        // A drag shouldn't also count as a click on links.
        if (!cancelled) {
            const swallow = ev => { ev.preventDefault(); ev.stopPropagation(); };
            window.addEventListener('click', swallow, { capture: true, once: true });
            setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
        }

        clearTimeout(tidyTimer);
        tidyTimer = setTimeout(() => arm.tidy(), IDLE_BEFORE_TIDY);
    }

    window.addEventListener('pointerup', e => endPress(e, false));
    window.addEventListener('pointercancel', e => endPress(e, true));

    // ---------- Arm ----------
    // A multi-joint arm hanging from the top-right corner. Its links telescope, and both the
    // gripper's route and the arm's body are planned around the other things on the page.
    const canvas = document.createElement('canvas');
    canvas.id = 'tidy-arm';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const LINKS = finePointer ? 6 : 5;   // number of links (joints = LINKS + 1, base included)
    const CELL = 18;                     // planning grid resolution, px
    const MARGIN = 12;                   // clearance kept around obstacles, px

    let W = 0, H = 0, colors = {};

    function readColors() {
        const cs = getComputedStyle(document.documentElement);
        const v = name => cs.getPropertyValue(name).trim();
        colors = {
            body: v('--foreground') || '#ddd',
            rod: v('--secondary') || '#888',
            accent: v('--accent') || '#a358ff',
            bg: v('--background') || '#181818',
        };
    }

    function resize() {
        const dpr = window.devicePixelRatio || 1;
        W = window.innerWidth;
        H = window.innerHeight;
        canvas.width = Math.round(W * dpr);
        canvas.height = Math.round(H * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // On phones the nav sits in the top-right corner, so the arm retracts up out of view between jobs.
    const base = () => ({ x: W - (finePointer ? 56 : 14), y: -6 });
    const rest = () => finePointer ? { x: W - 120, y: 150 } : { x: W - 30, y: -12 };

    // ---------- Planning ----------
    // Every page item is an obstacle, except the one the arm is working on (and anything
    // nested in it or containing it, since those overlap it by definition).
    function obstacles(focus) {
        const rects = [];
        for (const el of state.keys()) {
            if (focus && (el === focus || el.contains(focus) || focus.contains(el))) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.bottom < -MARGIN || r.top > H + MARGIN || r.right < -MARGIN || r.left > W + MARGIN) continue;
            rects.push(r);
        }
        return rects;
    }

    // The planning grid for the arm's current job. The focus item's area (where it is now and
    // where it belongs) is always kept open, so the arm can reach it even when it overlaps other things.
    function gridFor(focus) {
        const carve = [];
        if (focus) {
            const r = focus.getBoundingClientRect(), s = state.get(focus);
            carve.push(r, { left: r.left - s.x, right: r.right - s.x, top: r.top - s.y, bottom: r.bottom - s.y });
        }
        return buildGrid(obstacles(focus), carve);
    }

    function buildGrid(rects, carve = []) {
        const cols = Math.ceil(W / CELL), rows = Math.ceil(H / CELL);
        const blocked = new Uint8Array(cols * rows);
        for (const r of rects) {
            const c0 = Math.max(0, Math.floor((r.left - MARGIN) / CELL));
            const c1 = Math.min(cols - 1, Math.floor((r.right + MARGIN) / CELL));
            const r0 = Math.max(0, Math.floor((r.top - MARGIN) / CELL));
            const r1 = Math.min(rows - 1, Math.floor((r.bottom + MARGIN) / CELL));
            for (let y = r0; y <= r1; y++) blocked.fill(1, y * cols + c0, y * cols + c1 + 1);
        }
        for (const r of carve) {
            const c0 = Math.max(0, Math.floor(r.left / CELL)), c1 = Math.min(cols - 1, Math.floor(r.right / CELL));
            const r0 = Math.max(0, Math.floor(r.top / CELL)), r1 = Math.min(rows - 1, Math.floor(r.bottom / CELL));
            for (let y = r0; y <= r1; y++) if (c0 <= c1) blocked.fill(0, y * cols + c0, y * cols + c1 + 1);
        }
        return { cols, rows, blocked };
    }

    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const cellOf = (g, p) => [clamp(Math.floor(p.x / CELL), 0, g.cols - 1), clamp(Math.floor(p.y / CELL), 0, g.rows - 1)];
    const cellCenter = (c, r) => ({ x: (c + 0.5) * CELL, y: (r + 0.5) * CELL });

    // How much of the straight segment a→b runs over obstacles (sample count).
    function blockedAlong(g, a, b) {
        const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (CELL / 2));
        let n = 0;
        for (let i = 1; i < steps; i++) {
            const [c, r] = cellOf(g, { x: a.x + (b.x - a.x) * i / steps, y: a.y + (b.y - a.y) * i / steps });
            if (g.blocked[r * g.cols + c]) n++;
        }
        return n;
    }
    const lineFree = (g, a, b) => blockedAlong(g, a, b) === 0;

    const OBSTACLE_COST = 30;   // crossing an obstacle is allowed but expensive, so there is always a way out

    // A* over the grid (8-connected), then shortcut the result into a few straight segments.
    // Obstacles are expensive rather than forbidden: if the gripper starts or ends inside one
    // (e.g. right after putting something back), the arm takes the shortest way out instead of giving up.
    function plan(g, from, to) {
        if (lineFree(g, from, to)) return [from, to];

        const { cols, rows, blocked } = g;
        const [sc, sr] = cellOf(g, from), [gc, gr] = cellOf(g, to);
        const start = sr * cols + sc, goal = gr * cols + gc;

        const gScore = new Float32Array(cols * rows).fill(Infinity);
        const came = new Int32Array(cols * rows).fill(-1);
        const closed = new Uint8Array(cols * rows);
        const heap = [];
        const push = (i, f) => {
            heap.push([f, i]);
            let k = heap.length - 1;
            while (k > 0) {
                const p = (k - 1) >> 1;
                if (heap[p][0] <= heap[k][0]) break;
                [heap[p], heap[k]] = [heap[k], heap[p]]; k = p;
            }
        };
        const pop = () => {
            const top = heap[0], last = heap.pop();
            if (heap.length) {
                heap[0] = last;
                let k = 0;
                for (;;) {
                    const l = 2 * k + 1, r = l + 1;
                    let m = k;
                    if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
                    if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
                    if (m === k) break;
                    [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
                }
            }
            return top[1];
        };
        const h = i => {
            const dx = Math.abs(i % cols - gc), dy = Math.abs(((i / cols) | 0) - gr);
            return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
        };

        gScore[start] = 0;
        push(start, h(start));
        let found = false;
        while (heap.length) {
            const cur = pop();
            if (cur === goal) { found = true; break; }
            if (closed[cur]) continue;
            closed[cur] = 1;
            const cx = cur % cols, cy = (cur / cols) | 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const nx = cx + dx, ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                    const n = ny * cols + nx;
                    if (closed[n]) continue;
                    const cost = gScore[cur] + (dx && dy ? 1.414 : 1) * (blocked[n] ? OBSTACLE_COST : 1);
                    if (cost < gScore[n]) {
                        gScore[n] = cost;
                        came[n] = cur;
                        push(n, cost + h(n));
                    }
                }
            }
        }
        if (!found) return [from, to];   // only if start or goal is off the grid entirely

        const cells = [];
        for (let i = goal; i !== -1; i = came[i]) cells.push(i);
        cells.reverse();
        const raw = [from, ...cells.slice(1, -1).map(i => cellCenter(i % cols, (i / cols) | 0)), to];

        // String-pull: replace runs of grid steps with straight lines, as long as the shortcut
        // doesn't run over more obstacle than the grid path it replaces.
        const cum = [0];
        for (let k = 1; k < raw.length; k++) cum.push(cum[k - 1] + blockedAlong(g, raw[k - 1], raw[k]));
        const out = [raw[0]];
        let i = 0;
        while (i < raw.length - 1) {
            let j = raw.length - 1;
            while (j > i + 1 && blockedAlong(g, raw[i], raw[j]) > cum[j] - cum[i]) j--;
            out.push(raw[j]);
            i = j;
        }
        return out;
    }

    function pathLength(pts) {
        let L = 0;
        for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        return L;
    }

    function pointAt(pts, d) {
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            const seg = Math.hypot(b.x - a.x, b.y - a.y);
            if (d <= seg || i === pts.length - 1) {
                const t = seg ? clamp(d / seg, 0, 1) : 0;
                return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
            }
            d -= seg;
        }
        return { ...pts[pts.length - 1] };
    }

    function resample(pts, n) {
        const L = pathLength(pts);
        return Array.from({ length: n + 1 }, (_, i) => pointAt(pts, (L * i) / n));
    }

    // ---------- Arm state and motion ----------
    const arm = {
        tip: null,
        joints: [],
        grip: 1,          // 1 = open, 0 = closed
        held: null,
        focus: null,      // item being fetched or carried (not an obstacle)
        busy: false,
        aborted: false,

        drop() {
            if (!this.held) return;
            this.held.classList.remove('tidy-lifted');
            this.held = null;
            this.aborted = true;
        },

        // Move the gripper along a planned, obstacle-free route to a (possibly moving) target.
        tween(getTarget, { onFrame, abortIf } = {}) {
            const from = { ...this.tip };
            const route = plan(gridFor(this.focus), from, getTarget());
            const length = pathLength(route);
            const duration = clamp(length * 1.0, 380, 1300);
            const start = performance.now();
            return new Promise(resolve => {
                const step = now => {
                    if (abortIf && abortIf()) return resolve(false);
                    const t = Math.min(1, (now - start) / duration);
                    const p = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
                    route[route.length - 1] = getTarget();   // follow the target if it moves (e.g. scrolling)
                    this.tip = pointAt(route, p * pathLength(route));
                    if (onFrame) onFrame(p);
                    if (t < 1) requestAnimationFrame(step);
                    else resolve(true);
                };
                requestAnimationFrame(step);
            });
        },

        gripTo(value, ms = 160) {
            const from = this.grip, start = performance.now();
            return new Promise(resolve => {
                const step = now => {
                    const t = Math.min(1, (now - start) / ms);
                    this.grip = from + (value - from) * t;
                    if (t < 1) requestAnimationFrame(step); else resolve();
                };
                requestAnimationFrame(step);
            });
        },

        nextItem() {
            let best = null, bestD = Infinity;
            for (const [el, s] of state) {
                if (s.dragging || !isMessy(s)) continue;
                const c = center(el);
                const d = Math.hypot(c.x - this.tip.x, c.y - this.tip.y);
                if (d < bestD) { best = el; bestD = d; }
            }
            return best;
        },

        async fetch(el) {
            const s = state.get(el);
            this.aborted = false;
            this.focus = el;

            const reached = await this.tween(() => center(el), { abortIf: () => s.dragging });
            if (!reached) { this.focus = null; return; }

            await this.gripTo(0);
            if (s.dragging) { await this.gripTo(1); this.focus = null; return; }
            this.held = el;
            el.classList.add('tidy-lifted');
            apply(el);

            const rot0 = s.rot;
            const placed = await this.tween(() => home(el), {
                abortIf: () => this.aborted,
                onFrame: p => {
                    const c = center(el);
                    s.x += this.tip.x - c.x;
                    s.y += this.tip.y - c.y;
                    s.rot = rot0 * (1 - p);
                    apply(el);
                },
            });

            if (placed && this.held === el) {
                s.x = 0; s.y = 0; s.rot = 0;
                this.held = null;
                el.classList.remove('tidy-lifted');
                apply(el);
                el.animate(
                    [{ transform: 'translateY(-4px)' }, { transform: 'translateY(1px)' }, { transform: 'none' }],
                    { duration: 220, easing: 'ease-out' }
                );
            }
            this.focus = null;
            await this.gripTo(1);
        },

        async tidy() {
            if (this.busy) return;
            this.busy = true;
            let el;
            while ((el = this.nextItem())) {
                await this.fetch(el);
            }
            await this.tween(rest);
            this.busy = false;
        },

        // Shape the body: joints spread evenly along an obstacle-free route from base to gripper,
        // eased toward that shape so the arm swings rather than snaps when the route changes.
        updateBody(now) {
            const b = base();
            const route = plan(gridFor(this.focus), b, this.tip);
            const target = resample(route, LINKS);

            if (!this.busy && !reduceMotion) {
                // Idle: a slow ripple down the arm so it looks alive.
                for (let i = 1; i < LINKS; i++) {
                    const a = target[i - 1], c = target[i + 1];
                    const dx = c.x - a.x, dy = c.y - a.y, len = Math.hypot(dx, dy) || 1;
                    const w = Math.sin(now / 650 - i * 0.9) * 5 * Math.sin((i / LINKS) * Math.PI);
                    target[i].x += (-dy / len) * w;
                    target[i].y += (dx / len) * w;
                }
            }

            if (this.joints.length !== target.length) this.joints = target.map(p => ({ ...p }));
            for (let i = 1; i < LINKS; i++) {
                this.joints[i].x += (target[i].x - this.joints[i].x) * 0.28;
                this.joints[i].y += (target[i].y - this.joints[i].y) * 0.28;
            }
            this.joints[0] = b;
            this.joints[LINKS] = { ...this.tip };
        },
    };

    // ---------- Drawing ----------
    function link(p0, p1, sleeve, sleeveW, rodW) {
        const dx = p1.x - p0.x, dy = p1.y - p0.y;
        const len = Math.hypot(dx, dy) || 1;
        const s = Math.min(sleeve, len * 0.6);
        ctx.lineCap = 'round';
        ctx.strokeStyle = colors.rod;
        ctx.lineWidth = rodW;
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
        ctx.strokeStyle = colors.body;
        ctx.lineWidth = sleeveW;
        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p0.x + dx / len * s, p0.y + dy / len * s); ctx.stroke();
    }

    function joint(p, r) {
        ctx.fillStyle = colors.bg;
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    function gripper(prev, tip) {
        const dx = tip.x - prev.x, dy = tip.y - prev.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;     // along the last link
        const nx = -uy, ny = ux;                // across it
        const gap = 5 + arm.grip * 11;
        const back = 10, front = 13;

        ctx.lineCap = 'round';
        ctx.strokeStyle = colors.body;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(tip.x - ux * back + nx * (gap + 2), tip.y - uy * back + ny * (gap + 2));
        ctx.lineTo(tip.x - ux * back - nx * (gap + 2), tip.y - uy * back - ny * (gap + 2));
        ctx.stroke();
        for (const side of [1, -1]) {
            ctx.beginPath();
            ctx.moveTo(tip.x - ux * back + nx * gap * side, tip.y - uy * back + ny * gap * side);
            ctx.lineTo(tip.x + ux * front + nx * gap * side * 0.8, tip.y + uy * front + ny * gap * side * 0.8);
            ctx.stroke();
        }
    }

    function draw(now) {
        arm.updateBody(now);
        const J = arm.joints;
        ctx.clearRect(0, 0, W, H);

        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetY = 3;
        for (let i = 0; i < LINKS; i++) {
            const k = i / (LINKS - 1);                       // taper from base to gripper
            link(J[i], J[i + 1], 22 - 8 * k, 14 - 5 * k, 7 - 2.5 * k);
        }
        gripper(J[LINKS - 1], J[LINKS]);

        // ceiling mount
        const b = J[0], r = finePointer ? 30 : 13;
        ctx.fillStyle = colors.body;
        ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, Math.PI); ctx.fill();
        ctx.restore();

        for (let i = 0; i < LINKS; i++) joint(J[i], (finePointer ? 10 : 7) - (finePointer ? 4 : 2) * (i / (LINKS - 1)));

        requestAnimationFrame(draw);
    }

    // ---------- Reduced motion: no arm, items just slide home ----------
    if (reduceMotion) {
        arm.tidy = () => {
            for (const [el, s] of state) {
                if (s.dragging || !isMessy(s)) continue;
                el.style.transition = 'transform 0.4s ease';
                s.x = 0; s.y = 0; s.rot = 0;
                apply(el);
                setTimeout(() => { el.style.transition = ''; apply(el); }, 450);
            }
        };
        canvas.remove();
        return;
    }

    readColors();
    resize();
    arm.tip = rest();
    window.addEventListener('resize', () => { resize(); if (!arm.busy) arm.tip = rest(); });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);
    requestAnimationFrame(draw);
})();
