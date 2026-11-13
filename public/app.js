(() => {
  const root = document.documentElement;
  const storedTheme = localStorage.getItem('campus-theme');
  if (storedTheme === 'dark' || storedTheme === 'light') root.dataset.theme = storedTheme;
  if (localStorage.getItem('campus-sidebar') === 'collapsed') document.body.classList.add('sidebar-collapsed');

  const applyIcons = () => window.lucide?.createIcons();
  document.addEventListener('DOMContentLoaded', () => {
    applyIcons();
    const themeSwitch = document.querySelector('[data-theme-switch]');
    const themeButtons = document.querySelectorAll('[data-theme-toggle]');
    const syncTheme = () => {
      const dark = root.dataset.theme === 'dark';
      if (themeSwitch) themeSwitch.checked = dark;
      themeButtons.forEach((button) => {
        button.innerHTML = `<i data-lucide="${dark ? 'sun' : 'moon'}"></i>`;
        button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      });
      applyIcons();
    };
    const setTheme = (theme) => {
      root.dataset.theme = theme;
      localStorage.setItem('campus-theme', theme);
      syncTheme();
      drawCharts();
    };
    themeButtons.forEach((button) => button.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark')));
    themeSwitch?.addEventListener('change', () => setTheme(themeSwitch.checked ? 'dark' : 'light'));
    syncTheme();

    document.querySelector('[data-menu-toggle]')?.addEventListener('click', () => document.body.classList.toggle('menu-open'));
    document.querySelector('[data-close-menu]')?.addEventListener('click', () => document.body.classList.remove('menu-open'));
    document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', () => document.body.classList.remove('menu-open')));
    const collapseButton = document.querySelector('[data-sidebar-collapse]');
    if (collapseButton) {
      collapseButton.setAttribute('aria-label', document.body.classList.contains('sidebar-collapsed') ? 'Expand navigation' : 'Collapse navigation');
      collapseButton.addEventListener('click', (event) => {
        document.body.classList.toggle('sidebar-collapsed');
        const collapsed = document.body.classList.contains('sidebar-collapsed');
        localStorage.setItem('campus-sidebar', collapsed ? 'collapsed' : 'expanded');
        event.currentTarget.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
        event.currentTarget.innerHTML = `<i data-lucide="${collapsed ? 'panel-left-open' : 'panel-left-close'}"></i>`;
        applyIcons();
      });
    }
    if (new URLSearchParams(location.search).has('focus')) document.querySelector('.search-field input')?.focus();

    document.querySelectorAll('[data-password-toggle]').forEach((button) => button.addEventListener('click', () => {
      const input = button.closest('.input-with-icon').querySelector('input');
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
      button.innerHTML = `<i data-lucide="${visible ? 'eye-off' : 'eye'}"></i>`;
      applyIcons();
    }));

    const dialog = document.querySelector('#confirm-dialog');
    let pendingForm = null;
    document.querySelectorAll('[data-confirm-delete]').forEach((form) => form.addEventListener('submit', (event) => {
      if (form.dataset.confirmed === 'true') {
        delete form.dataset.confirmed;
        return;
      }
      event.preventDefault();
      pendingForm = form;
      if (dialog?.showModal) dialog.showModal();
      else if (window.confirm('Delete this record? This action cannot be undone.')) form.requestSubmit();
    }));
    dialog?.addEventListener('close', () => {
      if (dialog.returnValue === 'confirm' && pendingForm) {
        pendingForm.dataset.confirmed = 'true';
        pendingForm.requestSubmit();
      }
      pendingForm = null;
    });

    document.querySelector('[data-print]')?.addEventListener('click', () => window.print());
    document.querySelectorAll('.toast-close').forEach((button) => button.addEventListener('click', () => button.closest('.toast').remove()));
    document.querySelectorAll('.toast').forEach((toast) => window.setTimeout(() => toast.remove(), 5500));
    document.querySelectorAll('form button[type="submit"]').forEach((button) => {
      button.closest('.auth-form, .student-form, .stacked-form')?.addEventListener('submit', () => {
        button.disabled = true;
        button.classList.add('is-loading');
        button.setAttribute('aria-busy', 'true');
      }, { once: true });
    });

    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (location.pathname === '/students') document.querySelector('.search-field input')?.focus();
        else window.location.assign('/students?focus=1');
      }
      if (event.key === 'Escape') document.body.classList.remove('menu-open');
    });

    drawCharts();
  });

  function drawCharts() {
    if (!window.Chart) return;
    const colors = getComputedStyle(root);
    const palette = [
      colors.getPropertyValue('--blue').trim() || '#2563eb',
      colors.getPropertyValue('--cyan').trim() || '#38bdf8',
      colors.getPropertyValue('--violet').trim() || '#8b5cf6',
      colors.getPropertyValue('--green').trim() || '#10b981',
      colors.getPropertyValue('--amber').trim() || '#f59e0b',
      colors.getPropertyValue('--rose').trim() || '#f43f5e'
    ];
    const text = colors.getPropertyValue('--muted').trim() || '#64748b';
    const line = colors.getPropertyValue('--border').trim() || '#e9edf5';
    const charts = document.querySelectorAll('canvas[data-chart]');
    charts.forEach((canvas) => {
      window.Chart.getChart(canvas)?.destroy();
      let rows;
      try {
        rows = JSON.parse(canvas.dataset.series || '[]');
      } catch {
        return;
      }
      const type = canvas.dataset.chart;
      const wrapper = canvas.parentElement;
      wrapper.querySelector('.chart-empty')?.remove();
      if (type !== 'enrollment' && !rows.length) {
        const empty = document.createElement('div');
        empty.className = 'chart-empty';
        empty.textContent = type === 'courses' ? 'Add courses to see enrollment.' : 'Student records will appear here.';
        wrapper.append(empty);
        return;
      }
      const labels = rows.map((row) => row.label || row.name || row.year_level);
      const values = rows.map((row) => Number(row.total));
      const base = {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 550, easing: 'easeOutQuart' },
        plugins: {
          legend: { display: type === 'gender', position: 'bottom', labels: { color: text, usePointStyle: true, pointStyle: 'circle', padding: 18, font: { family: 'DM Sans', size: 11 } } },
          tooltip: { backgroundColor: '#172554', padding: 11, cornerRadius: 9, titleFont: { family: 'DM Sans', weight: '600' }, bodyFont: { family: 'DM Sans' }, displayColors: true }
        }
      };
      let config;
      if (type === 'gender') {
        config = { type: 'doughnut', data: { labels, datasets: [{ data: values, backgroundColor: palette, borderWidth: 0, hoverOffset: 5 }] }, options: { ...base, cutout: '72%' } };
      } else if (type === 'enrollment') {
        config = { type: 'line', data: { labels, datasets: [{ label: 'New students', data: values, borderColor: palette[0], backgroundColor: `${palette[0]}20`, fill: true, tension: 0.38, borderWidth: 2.5, pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: '#fff', pointBorderWidth: 2 }] }, options: { ...base, plugins: { ...base.plugins, legend: { display: false } }, scales: axisOptions(text, line) } };
      } else {
        config = { type: 'bar', data: { labels, datasets: [{ label: 'Students', data: values, backgroundColor: type === 'courses' ? palette[0] : palette[1], borderRadius: 6, maxBarThickness: 30 }] }, options: { ...base, indexAxis: type === 'courses' ? 'y' : 'x', plugins: { ...base.plugins, legend: { display: false } }, scales: axisOptions(text, line, type === 'courses') } };
      }
      new window.Chart(canvas, config);
    });
  }

  function axisOptions(text, line, horizontal = false) {
    return {
      x: { grid: { display: horizontal, color: line, drawBorder: false }, border: { display: false }, ticks: { color: text, font: { family: 'DM Sans', size: 10 }, maxRotation: 0 } },
      y: { beginAtZero: true, grid: { color: line, drawBorder: false }, border: { display: false }, ticks: { color: text, font: { family: 'DM Sans', size: 10 }, precision: 0 } }
    };
  }
})();
