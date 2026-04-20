const state = {
  tab: 'users',
  users: { page: 1, totalPages: 1, total: 0, query: '', rows: [] },
  logs: { page: 1, totalPages: 1, query: '' },
  openUserMenuId: null,
  modal: null,
};

const elements = {
  healthStatus: document.getElementById('healthStatus'),
  tabs: Array.from(document.querySelectorAll('.tab')),
  panels: {
    users: document.getElementById('panel-users'),
    logs: document.getElementById('panel-logs'),
  },
  users: {
    search: document.getElementById('usersSearch'),
    refresh: document.getElementById('usersRefresh'),
    rows: document.getElementById('usersRows'),
    meta: document.getElementById('usersMeta'),
    pageLabel: document.getElementById('usersPageLabel'),
    prev: document.getElementById('usersPrev'),
    next: document.getElementById('usersNext'),
  },
  logs: {
    search: document.getElementById('logsSearch'),
    refresh: document.getElementById('logsRefresh'),
    rows: document.getElementById('logsRows'),
    meta: document.getElementById('logsMeta'),
    pageLabel: document.getElementById('logsPageLabel'),
    prev: document.getElementById('logsPrev'),
    next: document.getElementById('logsNext'),
  },
  modal: {
    backdrop: document.getElementById('adminModalBackdrop'),
    eyebrow: document.getElementById('adminModalEyebrow'),
    title: document.getElementById('adminModalTitle'),
    description: document.getElementById('adminModalDescription'),
    label: document.getElementById('adminModalLabel'),
    input: document.getElementById('adminModalInput'),
    form: document.getElementById('adminModalForm'),
    close: document.getElementById('adminModalClose'),
    cancel: document.getElementById('adminModalCancel'),
    submit: document.getElementById('adminModalSubmit'),
  },
};

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

function setActiveTab(tab) {
  state.tab = tab;
  elements.tabs.forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  Object.entries(elements.panels).forEach(([key, panel]) => {
    panel.classList.toggle('active', key === tab);
  });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }

  return response.json();
}

async function sendJson(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with ${response.status}`);
  }

  return payload;
}

function getUserRow(userId) {
  return state.users.rows.find((row) => row.id === userId) || null;
}

function renderUserMenu(row) {
  const verifyLabel = row.is_verified ? 'Mark unverified' : 'Verify user';

  return `
    <div class="row-menu">
      <button class="menu-item" type="button" data-user-action="email" data-user-id="${escapeHtml(row.id)}">
        <span>Update email</span>
      </button>
      <button class="menu-item" type="button" data-user-action="password" data-user-id="${escapeHtml(row.id)}">
        <span>Update password</span>
      </button>
      <button class="menu-item" type="button" data-user-action="verified" data-user-id="${escapeHtml(row.id)}">
        <span>${verifyLabel}</span>
      </button>
    </div>
  `;
}

function renderUsersTable(payload) {
  const { rows, page, totalPages, total } = payload;
  state.users.page = page;
  state.users.totalPages = totalPages;
  state.users.total = total;
  state.users.rows = rows;
  elements.users.meta.textContent = `${total} users`;
  elements.users.pageLabel.textContent = `Page ${page} of ${totalPages}`;
  elements.users.prev.disabled = page <= 1;
  elements.users.next.disabled = page >= totalPages;

  if (state.openUserMenuId && !rows.some((row) => row.id === state.openUserMenuId)) {
    state.openUserMenuId = null;
  }

  if (!rows.length) {
    elements.users.rows.innerHTML = '<tr><td colspan="6" class="empty">No users found.</td></tr>';
    return;
  }

  elements.users.rows.innerHTML = rows.map((row) => `
    <tr>
      <td class="user-cell">
        <strong>${escapeHtml(row.display_name || row.username)}</strong>
        <span class="subline">@${escapeHtml(row.username)}</span>
        <span class="subline">${escapeHtml(row.id)}</span>
      </td>
      <td>
        ${escapeHtml(row.email)}
        ${row.bio ? `<span class="subline">${escapeHtml(row.bio)}</span>` : ''}
      </td>
      <td>
        <span class="badge ${row.is_verified ? 'verified' : 'unverified'}">
          ${row.is_verified ? 'Verified' : 'Pending'}
        </span>
      </td>
      <td>${row.profile_id ? escapeHtml(row.profile_id) : '-'}</td>
      <td>${formatDate(row.created_at)}</td>
      <td class="actions-cell">
        <div class="row-actions">
          <button
            class="kebab-button"
            type="button"
            aria-label="Open user actions"
            data-user-menu="${escapeHtml(row.id)}"
          >
            ⋯
          </button>
          ${state.openUserMenuId === row.id ? renderUserMenu(row) : ''}
        </div>
      </td>
    </tr>
  `).join('');
}

function renderLogsTable(payload) {
  const { rows, page, totalPages, total } = payload;
  state.logs.page = page;
  state.logs.totalPages = totalPages;
  elements.logs.meta.textContent = `${total} log entries`;
  elements.logs.pageLabel.textContent = `Page ${page} of ${totalPages}`;
  elements.logs.prev.disabled = page <= 1;
  elements.logs.next.disabled = page >= totalPages;

  if (!rows.length) {
    elements.logs.rows.innerHTML = '<tr><td colspan="6" class="empty">No security logs found.</td></tr>';
    return;
  }

  elements.logs.rows.innerHTML = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.action)}</td>
      <td class="user-cell">
        <strong>${escapeHtml(row.username || 'Unknown')}</strong>
        <span class="subline">${escapeHtml(row.email || row.user_id || '-')}</span>
      </td>
      <td>${escapeHtml(row.ip_address || '-')}</td>
      <td>
        ${escapeHtml(row.path || '-')}
        ${row.user_agent ? `<span class="subline">${escapeHtml(row.user_agent)}</span>` : ''}
      </td>
      <td>${escapeHtml(row.device_fingerprint || '-')}</td>
      <td>${formatDate(row.created_at)}</td>
    </tr>
  `).join('');
}

function openModal(config) {
  state.modal = config;
  elements.modal.eyebrow.textContent = config.eyebrow || 'User action';
  elements.modal.title.textContent = config.title;
  elements.modal.description.textContent = config.description || '';
  elements.modal.label.textContent = config.label || 'Value';
  elements.modal.input.type = config.inputType || 'text';
  elements.modal.input.placeholder = config.placeholder || '';
  elements.modal.input.value = config.defaultValue || '';
  elements.modal.input.autocomplete = config.inputType === 'password' ? 'new-password' : 'off';
  elements.modal.submit.textContent = config.submitText || 'Save';
  elements.modal.backdrop.classList.remove('hidden');
  elements.modal.backdrop.setAttribute('aria-hidden', 'false');
  window.setTimeout(() => {
    elements.modal.input.focus();
    elements.modal.input.select();
  }, 0);
}

function closeModal() {
  state.modal = null;
  elements.modal.form.reset();
  elements.modal.backdrop.classList.add('hidden');
  elements.modal.backdrop.setAttribute('aria-hidden', 'true');
}

async function updateUser(userId, patch) {
  await sendJson(`/api/users/${encodeURIComponent(userId)}`, 'PATCH', patch);
  state.openUserMenuId = null;
  await loadUsers();
}

async function handleUserAction(action, userId) {
  const row = getUserRow(userId);
  if (!row) return;
  state.openUserMenuId = null;
  renderUsersTable({
    rows: state.users.rows,
    page: state.users.page,
    totalPages: state.users.totalPages,
    total: state.users.total,
  });

  if (action === 'email') {
    openModal({
      eyebrow: 'Users',
      title: `Update email for @${row.username}`,
      description: 'Use a valid address. The change is written directly to the users table.',
      label: 'Email address',
      inputType: 'email',
      defaultValue: row.email || '',
      placeholder: 'user@example.com',
      submitText: 'Update email',
      onSubmit: async (value) => {
        await updateUser(userId, { email: value.trim() });
      },
    });
    return;
  }

  if (action === 'password') {
    openModal({
      eyebrow: 'Users',
      title: `Update password for @${row.username}`,
      description: 'This writes a new Argon2id password hash into the users table.',
      label: 'New password',
      inputType: 'password',
      defaultValue: '',
      placeholder: 'Enter a new password',
      submitText: 'Update password',
      onSubmit: async (value) => {
        await updateUser(userId, { password: value });
      },
    });
    return;
  }

  if (action === 'verified') {
    const nextVerified = !row.is_verified;
    const confirmed = window.confirm(
      `${nextVerified ? 'Verify' : 'Mark unverified'} @${row.username}?`,
    );
    if (!confirmed) return;

    try {
      await updateUser(userId, { is_verified: nextVerified });
    } catch (error) {
      window.alert(error.message);
    }
  }
}

async function loadUsers() {
  elements.users.rows.innerHTML = '<tr><td colspan="6" class="empty">Loading users...</td></tr>';
  try {
    const payload = await fetchJson(`/api/users?page=${state.users.page}&q=${encodeURIComponent(state.users.query)}`);
    renderUsersTable(payload);
  } catch (error) {
    elements.users.rows.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function loadLogs() {
  elements.logs.rows.innerHTML = '<tr><td colspan="6" class="empty">Loading security logs...</td></tr>';
  try {
    const payload = await fetchJson(`/api/security-logs?page=${state.logs.page}&q=${encodeURIComponent(state.logs.query)}`);
    renderLogsTable(payload);
  } catch (error) {
    elements.logs.rows.innerHTML = `<tr><td colspan="6" class="error">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function loadHealth() {
  try {
    const payload = await fetchJson('/health');
    elements.healthStatus.textContent = payload.ok ? 'DB connected' : 'DB error';
  } catch {
    elements.healthStatus.textContent = 'DB error';
  }
}

elements.tabs.forEach((button) => {
  button.addEventListener('click', () => setActiveTab(button.dataset.tab));
});

elements.users.search.addEventListener('input', debounce((event) => {
  state.users.query = event.target.value.trim();
  state.users.page = 1;
  void loadUsers();
}));

elements.logs.search.addEventListener('input', debounce((event) => {
  state.logs.query = event.target.value.trim();
  state.logs.page = 1;
  void loadLogs();
}));

elements.users.refresh.addEventListener('click', () => void loadUsers());
elements.logs.refresh.addEventListener('click', () => void loadLogs());

elements.users.prev.addEventListener('click', () => {
  if (state.users.page <= 1) return;
  state.users.page -= 1;
  void loadUsers();
});

elements.users.next.addEventListener('click', () => {
  if (state.users.page >= state.users.totalPages) return;
  state.users.page += 1;
  void loadUsers();
});

elements.logs.prev.addEventListener('click', () => {
  if (state.logs.page <= 1) return;
  state.logs.page -= 1;
  void loadLogs();
});

elements.logs.next.addEventListener('click', () => {
  if (state.logs.page >= state.logs.totalPages) return;
  state.logs.page += 1;
  void loadLogs();
});

elements.users.rows.addEventListener('click', (event) => {
  const actionButton = event.target.closest('[data-user-action]');
  if (actionButton) {
    const { userAction, userId } = actionButton.dataset;
    void handleUserAction(userAction, userId);
    return;
  }

  const menuButton = event.target.closest('[data-user-menu]');
  if (!menuButton) return;

  const userId = menuButton.dataset.userMenu;
  state.openUserMenuId = state.openUserMenuId === userId ? null : userId;
  renderUsersTable({
    rows: state.users.rows,
    page: state.users.page,
    totalPages: state.users.totalPages,
    total: state.users.total,
  });
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.row-actions')) {
    if (state.openUserMenuId) {
      state.openUserMenuId = null;
      renderUsersTable({
        rows: state.users.rows,
        page: state.users.page,
        totalPages: state.users.totalPages,
        total: state.users.total,
      });
    }
  }
});

elements.modal.close.addEventListener('click', closeModal);
elements.modal.cancel.addEventListener('click', closeModal);
elements.modal.backdrop.addEventListener('click', (event) => {
  if (event.target === elements.modal.backdrop) {
    closeModal();
  }
});

elements.modal.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.modal) return;

  const value = elements.modal.input.value;
  elements.modal.submit.disabled = true;
  elements.modal.cancel.disabled = true;

  try {
    await state.modal.onSubmit(value);
    closeModal();
  } catch (error) {
    window.alert(error.message);
  } finally {
    elements.modal.submit.disabled = false;
    elements.modal.cancel.disabled = false;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (state.modal) {
      closeModal();
      return;
    }
    if (state.openUserMenuId) {
      state.openUserMenuId = null;
      renderUsersTable({
        rows: state.users.rows,
        page: state.users.page,
        totalPages: state.users.totalPages,
        total: state.users.total,
      });
    }
  }
});

setActiveTab('users');
void loadHealth();
void loadUsers();
void loadLogs();
