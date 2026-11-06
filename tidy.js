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
        /* Shrink block items (headings, contact rows) to their text, so the box that moves,
           and the centre the gripper grabs, match what you see rather than the full column width. */
        .tidy-item:not(img) { width: fit-content; }
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
    const canvas = document.createElement('canvas');
    canvas.id = 'tidy-arm';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    let W = 0, H = 0, colors = {};

    function readColors() {
        const cs = getComputedStyle(document.documentElement);
        const v = name => cs.getPropertyValue(name).trim();
        colors = {
            body: v('--foreground') || '#ddd',
            rod: v('--secondary') || '#888',
            accent: v('--accent') || '#a358ff',
            faint: v('--accent-faint') || '#2f2035',
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

    // Mounted on the ceiling in the top-right corner. On phones the nav sits in that corner,
    // so the arm retracts up out of view between jobs.
    const base = () => ({ x: W - (finePointer ? 52 : 14), y: -6 });
    const rest = () => finePointer ? { x: base().x - 70, y: 110 } : { x: W - 30, y: -12 };

    const arm = {
        tip: null,
        grip: 1,          // 1 = open, 0 = closed
        held: null,
        busy: false,
        aborted: false,

        drop() {
            if (!this.held) return;
            this.held.classList.remove('tidy-lifted');
            this.held = null;
            this.aborted = true;
        },

        tween(getTarget, { ms, onFrame, abortIf } = {}) {
            const from = { ...this.tip };
            const target0 = getTarget();
            const dist = Math.hypot(target0.x - from.x, target0.y - from.y);
            const duration = ms ?? Math.max(320, Math.min(950, dist * 0.9));
            const start = performance.now();
            return new Promise(resolve => {
                const step = now => {
                    if (abortIf && abortIf()) return resolve(false);
                    const t = Math.min(1, (now - start) / duration);
                    const p = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
                    const target = getTarget();
                    this.tip = { x: from.x + (target.x - from.x) * p, y: from.y + (target.y - from.y) * p };
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

            const reached = await this.tween(() => center(el), { abortIf: () => s.dragging });
            if (!reached) return;

            await this.gripTo(0);
            if (s.dragging) { await this.gripTo(1); return; }
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
    };

    // ---------- Drawing ----------
    function elbowFor(b, t) {
        const dx = t.x - b.x, dy = t.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        const L = Math.max(d * 0.56, finePointer ? 46 : 24);   // telescoping links: each link stretches with reach
        const a = d / 2;
        const h = Math.sqrt(Math.max(L * L - a * a, 0));
        // Bend the elbow out to the right, away from the content.
        return { x: b.x + dx / 2 + (dy / d) * h, y: b.y + dy / 2 + (-dx / d) * h };
    }

    function link(p0, p1, sleeve, sleeveW, rodW) {
        const dx = p1.x - p0.x, dy = p1.y - p0.y;
        const len = Math.hypot(dx, dy) || 1;
        const s = Math.min(sleeve, len);
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
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    function gripper(elbow, tip) {
        const dx = tip.x - elbow.x, dy = tip.y - elbow.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;     // along the forearm
        const nx = -uy, ny = ux;                // across it
        const gap = 5 + arm.grip * 11;
        const back = 10, front = 13;

        ctx.lineCap = 'round';
        ctx.strokeStyle = colors.body;
        ctx.lineWidth = 5;
        // palm
        ctx.beginPath();
        ctx.moveTo(tip.x - ux * back + nx * (gap + 2), tip.y - uy * back + ny * (gap + 2));
        ctx.lineTo(tip.x - ux * back - nx * (gap + 2), tip.y - uy * back - ny * (gap + 2));
        ctx.stroke();
        // fingers
        for (const side of [1, -1]) {
            ctx.beginPath();
            ctx.moveTo(tip.x - ux * back + nx * gap * side, tip.y - uy * back + ny * gap * side);
            ctx.lineTo(tip.x + ux * front + nx * gap * side * 0.8, tip.y + uy * front + ny * gap * side * 0.8);
            ctx.stroke();
        }
    }

    function draw(now) {
        ctx.clearRect(0, 0, W, H);
        const b = base();
        let tip = arm.tip;
        if (!arm.busy && !reduceMotion) {
            tip = { x: tip.x + Math.sin(now / 900) * 3, y: tip.y + Math.cos(now / 1300) * 2.5 };
        }
        const e = elbowFor(b, tip);

        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetY = 3;

        link(b, e, 40, 15, 8);
        link(e, tip, 34, 12, 6);
        gripper(e, tip);

        // ceiling mount
        ctx.fillStyle = colors.body;
        ctx.beginPath(); ctx.arc(b.x, b.y, finePointer ? 30 : 13, 0, Math.PI); ctx.fill();
        ctx.restore();

        joint(b, 11);
        joint(e, 9);

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
