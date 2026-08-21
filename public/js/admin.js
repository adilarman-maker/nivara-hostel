const session = guard('admin');
const me = session.user;

let tenantsCache = [];
let blocksCache = {};

// ---------- sidebar / identity ----------
document.getElementById('rolePill').textContent = me.role === 'super' ? 'Super Admin' : 'Sub-Admin';
document.getElementById('whoName').textContent = me.name;
document.getElementById('whoScope').textContent = me.role === 'super' ? 'All 4 blocks' : (BLOCK_META[me.blockCode]?.name + ' block only');
if (me.role === 'super') document.getElementById('superOnlyNav').style.display = 'block';

// ---------- tab switching ----------
const tabs = ['overview', 'rooms', 'payments', 'complaints', 'tenants', 'admins', 'audit'];
function showTab(name) {
  tabs.forEach((t) => {
    document.getElementById('tab-' + t).style.display = t === name ? 'block' : 'none';
  });
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.tab === name));
  if (name === 'overview') loadOverview();
  if (name === 'rooms') { roomsState = { view: 'blocks', blockCode: null, floorNumber: null, floorsData: null }; renderRooms(); }
  if (name === 'payments') loadPayments();
  if (name === 'complaints') loadComplaints();
  if (name === 'tenants') loadTenants();
  if (name === 'admins') loadAdmins();
  if (name === 'audit') loadAudit();
}
document.querySelectorAll('.nav-item[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

// ---------- overview ----------
async function loadOverview() {
  try {
    const data = await api('/admin/summary');
    const grid = document.getElementById('statGrid');
    const visibleBlocks = me.role === 'super'
      ? Object.entries(data.perBlock)
      : Object.entries(data.perBlock).filter(([code]) => Number(code) === me.blockCode);

    grid.innerHTML = `
      <div class="stat-card"><span class="tag">Total</span><div class="n">${data.totalTenants}</div><div class="l">Tenants in your scope</div></div>
      ${visibleBlocks.map(([code, b]) => `
        <div class="stat-card"><span class="tag">${b.type}</span><div class="n">${b.count}</div><div class="l">${b.name}</div></div>
      `).join('')}
    `;

    const list = document.getElementById('activityList');
    if (!data.recentActivity.length) {
      list.innerHTML = `<div class="empty-state"><div class="glyph">📜</div><h3>No activity yet</h3></div>`;
    } else {
      list.innerHTML = data.recentActivity.map((a) => `
        <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--line); font-size:0.87rem;">
          <span><b>${a.by}</b> — ${a.details}</span>
          <span style="color:#8a9690;">${new Date(a.ts).toLocaleString()}</span>
        </div>`).join('');
    }
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- tenants ----------
let tenantsState = { page: 1, limit: 50, search: '', block: '' };
let searchDebounceTimer = null;

async function loadTenants() {
  try {
    const params = new URLSearchParams();
    params.set('page', tenantsState.page);
    params.set('limit', tenantsState.limit);
    if (tenantsState.search) params.set('search', tenantsState.search);
    if (tenantsState.block) params.set('block', tenantsState.block);

    const data = await api('/tenants?' + params.toString());
    tenantsCache = data.tenants;
    blocksCache = data.blocks;

    const filterSel = document.getElementById('blockFilter');
    if (filterSel.options.length <= 1) {
      Object.entries(blocksCache).forEach(([code, b]) => {
        if (me.role === 'sub' && Number(code) !== me.blockCode) return;
        const opt = document.createElement('option');
        opt.value = code; opt.textContent = b.name;
        filterSel.appendChild(opt);
      });
    }
    renderTenantRows(data.total);
  } catch (e) { toast(e.message, 'err'); }
}

function renderTenantRows(total) {
  const tbody = document.getElementById('tenantRows');
  document.getElementById('tenantEmpty').style.display = tenantsCache.length ? 'none' : 'block';

  tbody.innerHTML = tenantsCache.map((t) => {
    const parsed = parseUidClient(t.uid);
    return `
    <tr class="row-hover">
      <td>${renderKeycard(t.uid, 'sm')}</td>
      <td><b>${escapeHtml(t.name)}</b>${t.email ? `<div style="font-size:0.76rem;color:#8a9690;">${escapeHtml(t.email)}</div>` : ''}</td>
      <td>${blockBadge(parsed.block)}</td>
      <td class="mono">${t.phone}</td>
      <td style="color:#8a9690; font-size:0.8rem;">${new Date(t.updatedAt).toLocaleDateString()}</td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" onclick="openEditTenant('${t.id}')">Edit</button>
          <button class="icon-btn danger" onclick="deleteTenant('${t.id}','${escapeHtml(t.name)}')">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  const start = total === 0 ? 0 : (tenantsState.page - 1) * tenantsState.limit + 1;
  const end = Math.min(tenantsState.page * tenantsState.limit, total);
  document.getElementById('tenantPageInfo').textContent = `Showing ${start}-${end} of ${total}`;
  document.getElementById('tenantPrevBtn').disabled = tenantsState.page <= 1;
  document.getElementById('tenantNextBtn').disabled = end >= total;
}

// Debounced search — waits ~300ms after typing stops before hitting the API,
// instead of firing a request on every keystroke.
document.getElementById('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    tenantsState.search = e.target.value.trim();
    tenantsState.page = 1;
    loadTenants();
  }, 300);
});
document.getElementById('blockFilter').addEventListener('change', (e) => {
  tenantsState.block = e.target.value;
  tenantsState.page = 1;
  loadTenants();
});
document.getElementById('tenantPrevBtn').addEventListener('click', () => {
  if (tenantsState.page > 1) { tenantsState.page -= 1; loadTenants(); }
});
document.getElementById('tenantNextBtn').addEventListener('click', () => {
  tenantsState.page += 1;
  loadTenants();
});

// ---- tenant modal ----
const tenantModal = document.getElementById('tenantModalBackdrop');
document.getElementById('openAddTenant').addEventListener('click', () => openAddTenant());
document.getElementById('cancelModal').addEventListener('click', () => tenantModal.classList.remove('show'));

async function openAddTenant() {
  document.getElementById('modalTitle').textContent = 'Add tenant';
  document.getElementById('tenantForm').reset();
  document.getElementById('tenantId').value = '';
  document.getElementById('uidPreview').style.display = 'none';
  if (me.role === 'sub') document.getElementById('fUid').value = String(me.blockCode);
  // Pre-fill fee fields with sensible 1-person defaults from settings — admin can change them per tenant.
  try {
    const config = await getPaymentConfigCached();
    document.getElementById('fAdvance').value = config.advanceAmount || '';
    document.getElementById('fMonthlyRent').value = (config.rentByBedCount && config.rentByBedCount[1]) || '';
  } catch (_) {}
  tenantModal.classList.add('show');
}
window.openEditTenant = function (id) {
  const t = tenantsCache.find((x) => x.id === id);
  if (!t) return;
  document.getElementById('modalTitle').textContent = 'Edit tenant';
  document.getElementById('tenantId').value = t.id;
  document.getElementById('fUid').value = t.uid;
  document.getElementById('fName').value = t.name;
  document.getElementById('fPhone').value = t.phone;
  document.getElementById('fAdvance').value = t.advanceAmount || '';
  document.getElementById('fMonthlyRent').value = t.monthlyRent || '';
  document.getElementById('fEmail').value = t.email || '';
  document.getElementById('fCollege').value = t.college || '';
  document.getElementById('fHometown').value = t.hometown || '';
  document.getElementById('fParentPhone').value = t.parentPhone || '';
  document.getElementById('fAge').value = t.age || '';
  document.getElementById('fGender').value = t.gender || '';
  document.getElementById('fNotes').value = t.notes || '';
  document.getElementById('uidPreview').style.display = 'none';
  tenantModal.classList.add('show');
};
window.deleteTenant = async function (id, name) {
  if (!confirm(`Remove ${name}? This frees up their UID for reassignment.`)) return;
  try {
    await api(`/tenants/${id}`, { method: 'DELETE' });
    toast('Tenant removed', 'ok');
    loadTenants(); loadOverview();
  } catch (e) { toast(e.message, 'err'); }
};

const fUid = document.getElementById('fUid');
fUid.addEventListener('input', async () => {
  fUid.value = fUid.value.replace(/\D/g, '').slice(0, 5);
  const preview = document.getElementById('uidPreview');
  const parsed = parseUidClient(fUid.value);
  if (!parsed) {
    if (fUid.value.length === 5) {
      preview.style.display = 'block'; preview.className = 'uid-preview bad';
      preview.textContent = 'Invalid UID — block digit must be 1-4, room/bed cannot be 0.';
    } else { preview.style.display = 'none'; }
    return;
  }
  const editingId = document.getElementById('tenantId').value;
  // skip live availability check while editing and UID unchanged
  const existing = tenantsCache.find(t => t.id === editingId);
  if (existing && existing.uid === fUid.value) {
    preview.style.display = 'block'; preview.className = 'uid-preview ok';
    preview.textContent = `${BLOCK_META[parsed.block].name} • Floor ${parsed.floor} • Room ${String(parsed.room).padStart(2,'0')} • Bed ${parsed.bed} (current)`;
    return;
  }
  try {
    const res = await api(`/tenants/validate/${fUid.value}`);
    preview.style.display = 'block';
    preview.className = 'uid-preview ' + (res.valid ? 'ok' : 'bad');
    preview.textContent = res.valid ? res.description : res.reason;
  } catch (e) { /* ignore live validation errors */ }
});

document.getElementById('tenantForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('saveTenantBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const id = document.getElementById('tenantId').value;
  const payload = {
    uid: document.getElementById('fUid').value.trim(),
    name: document.getElementById('fName').value.trim(),
    phone: document.getElementById('fPhone').value.trim(),
    advanceAmount: document.getElementById('fAdvance').value,
    monthlyRent: document.getElementById('fMonthlyRent').value,
    email: document.getElementById('fEmail').value.trim(),
    college: document.getElementById('fCollege').value.trim(),
    hometown: document.getElementById('fHometown').value.trim(),
    parentPhone: document.getElementById('fParentPhone').value.trim(),
    age: document.getElementById('fAge').value,
    gender: document.getElementById('fGender').value,
    notes: document.getElementById('fNotes').value.trim(),
  };
  try {
    let result;
    if (id) result = await api(`/tenants/${id}`, { method: 'PUT', body: payload });
    else result = await api('/tenants', { method: 'POST', body: payload });
    toast(id ? 'Tenant updated' : 'Tenant added', 'ok');
    tenantModal.classList.remove('show');
    loadTenants(); loadOverview();
    if (!id) openWhatsAppInviteModal(result.tenant);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Save tenant';
  }
});

// ---------- gate (removed — each admin now has their own UID/phone, see Admin Accounts) ----------

// ---------- admins (super only) ----------
async function loadAdmins() {
  try {
    const data = await api('/admin/admins');
    document.getElementById('adminRows').innerHTML = data.admins.map((a) => `
      <tr>
        <td><b>${a.name}</b></td>
        <td class="mono">${a.uid || '<span style="color:#c1502e;">not set</span>'}</td>
        <td class="mono">${a.phone || '<span style="color:#c1502e;">not set</span>'}</td>
        <td>${a.role === 'super' ? 'Super Admin' : 'Sub-Admin'}</td>
        <td>${a.blockCode ? blockBadge(a.blockCode) : '<span style="color:#8a9690;">All blocks</span>'}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn" onclick="openCredModal('${a.id}','${escapeHtml(a.name)}','${a.uid||''}','${a.phone||''}')">Edit UID/phone</button>
            <button class="icon-btn" onclick="openPwModal('${a.id}','${escapeHtml(a.name)}')">Reset password</button>
          </div>
        </td>
      </tr>`).join('');
  } catch (e) { toast(e.message, 'err'); }
}

const credModal = document.getElementById('credModalBackdrop');
window.openCredModal = function (id, name, uid, phone) {
  document.getElementById('credAdminId').value = id;
  document.getElementById('credModalSub').textContent = `Set the login UID and phone ${name} will use.`;
  document.getElementById('credUid').value = uid;
  document.getElementById('credPhone').value = phone;
  credModal.classList.add('show');
};
document.getElementById('credCancel').addEventListener('click', () => credModal.classList.remove('show'));
document.getElementById('credForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/admin/admins/${document.getElementById('credAdminId').value}/credentials`, {
      method: 'PUT',
      body: {
        uid: document.getElementById('credUid').value.trim(),
        phone: document.getElementById('credPhone').value.trim(),
      },
    });
    toast('Login UID/phone updated', 'ok');
    credModal.classList.remove('show');
    loadAdmins();
  } catch (err) { toast(err.message, 'err'); }
});
const pwModal = document.getElementById('pwModalBackdrop');
window.openPwModal = function (id, name) {
  document.getElementById('pwAdminId').value = id;
  document.getElementById('pwModalSub').textContent = `Set a new password for ${name}.`;
  document.getElementById('pwForm').reset();
  pwModal.classList.add('show');
};
document.getElementById('pwCancel').addEventListener('click', () => pwModal.classList.remove('show'));
document.getElementById('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/admin/admins/${document.getElementById('pwAdminId').value}/password`, {
      method: 'PUT', body: { password: document.getElementById('pwNew').value },
    });
    toast('Password updated', 'ok');
    pwModal.classList.remove('show');
  } catch (err) { toast(err.message, 'err'); }
});

// ---------- audit (super only) ----------
async function loadAudit() {
  try {
    const data = await api('/admin/summary');
    const rows = data.recentActivity;
    document.getElementById('auditRows').innerHTML = rows.length ? rows.map((a) => `
      <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--line); font-size:0.87rem;">
        <span><b>${a.by}</b> — ${a.action.replace(/_/g,' ')} — ${a.details}</span>
        <span style="color:#8a9690;">${new Date(a.ts).toLocaleString()}</span>
      </div>`).join('') : `<div class="empty-state"><div class="glyph">📜</div><h3>Nothing logged yet</h3></div>`;
  } catch (e) { toast(e.message, 'err'); }
}

showTab('overview');
