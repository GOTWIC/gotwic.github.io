// Blog posts open in a side panel.
// - Hover a title (mouse/trackpad) or click/tap it to open.
// - Close with the × button, Escape, or a click outside the panel.
// - Each post has its own URL (#post-N), so posts can be linked directly.
document.addEventListener('DOMContentLoaded', function () {
    const links = document.querySelectorAll('.blog-link');
    const panels = document.querySelectorAll('.sidebar');
    const canHover = window.matchMedia('(hover: hover)').matches;
    let current = null;

    function open(panel) {
        if (!panel || panel === current) return;
        if (current) current.classList.remove('active');
        panel.classList.add('active');
        panel.scrollTop = 0;
        current = panel;
        if (location.hash !== '#' + panel.id) {
            history.replaceState(null, '', '#' + panel.id);
        }
    }

    function close() {
        if (!current) return;
        current.classList.remove('active');
        current = null;
        history.replaceState(null, '', location.pathname + location.search);
    }

    links.forEach(function (link) {
        const panel = document.getElementById(link.getAttribute('aria-controls'));
        link.addEventListener('click', function (event) {
            event.preventDefault();
            open(panel);
            panel.querySelector('.sidebar-close').focus({ preventScroll: true });
        });
        if (canHover) {
            link.addEventListener('mouseenter', function () { open(panel); });
        }
    });

    panels.forEach(function (panel) {
        panel.querySelector('.sidebar-close').addEventListener('click', close);
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') close();
    });

    document.addEventListener('click', function (event) {
        if (current && !current.contains(event.target) && !event.target.closest('.blog-link')) {
            close();
        }
    });

    // Open the post named in the URL, e.g. /blog/#post-4
    if (location.hash) {
        const fromHash = document.getElementById(location.hash.slice(1));
        if (fromHash && fromHash.classList.contains('sidebar')) open(fromHash);
    }
});
