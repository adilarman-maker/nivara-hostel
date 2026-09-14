const session = guard('admin');
const me = session.user;

let tenantsCache = [];
let blocksCache = [];

// ---------- sidebar / identity ----------
document.getElementById('rolePill').textContent = me.role === 'super' ? 'Super Admin' : 'Sub-Admin';
document.getElementById('whoName').textContent = me.name;
if (me.role === 'super') document.getElementById('superOnlyNav').style.display = 'block';
if (me.role === 'super') {
  document.getElementById('moreAdminsItem').style.display = 'flex';
  document.getElementById('moreAuditItem').style.display = 'flex';
}
document.getElementById('moreSheetWho').textContent = `${me.name} · ${me.role === 'super' ? 'Super Admin' : 'Sub-Admin'}`;

// Sub-admins get full control of their own block's tenants and view-only
// everywhere else — nothing to hide up front, per-row checks below handle it.
loadBlockMeta().then(() => {
  document.getElementById('whoScope').textContent = me.role === 'super'
    ? `All ${Object.keys(BLOCK_META).length} block${Object.keys(BLOCK_META).length === 1 ? '' : 's'}`
    : (BLOCK_META[me.blockCode]?.name ? BLOCK_META[me.blockCode].name + ' block only' : 'No block assigned');
});

// ---------- mobile bottom tab bar + sheets ----------
// Purely a navigation layer on top of the same showTab() used everywhere
// else — phones get a bottom bar instead of the sidebar-turned-top-row,
// nothing about the underlying tabs/data changes.
window.mobileGoToTab = function (name) {
  showTab(name);
};
window.openQuickActions = function () {
  closeSheets();
  document.getElementById('quickActionsBackdrop').classList.add('show');
};
window.openMoreSheet = function () {
  closeSheets();
  document.getElementById('moreSheetBackdrop').classList.add('show');
};
window.closeSheets = function (e) {
  // clicking inside the sheet itself shouldn't close it — only the dimmed backdrop
  if (e && e.target !== e.currentTarget) return;
  document.getElementById('quickActionsBackdrop').classList.remove('show');
  document.getElementById('moreSheetBackdrop').classList.remove('show');
};

// ---------- tab switching ----------
const tabs = ['overview', 'rooms', 'payments', 'complaints', 'messages', 'tenants', 'admins', 'audit'];
let _overviewPollTimer = null;
let _paymentsPollTimer = null;
function stopLivePolling() {
  if (typeof _msgStopPolling === 'function') _msgStopPolling(); // no need to poll a tab that isn't open
  if (_overviewPollTimer) { clearInterval(_overviewPollTimer); _overviewPollTimer = null; }
  if (_paymentsPollTimer) { clearInterval(_paymentsPollTimer); _paymentsPollTimer = null; }
}
function showTab(name) {
  tabs.forEach((t) => {
    document.getElementById('tab-' + t).style.display = t === name ? 'block' : 'none';
  });
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.tab === name));
  document.querySelectorAll('.mtab[data-tab]').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
  stopLivePolling();
  // Overview and Payments show live totals/graphs — a Sub-Admin confirming a
  // payment should surface in the Super Admin's dashboard (and vice versa)
  // without anyone needing to refresh the page. Polling only while that tab
  // is actually open keeps this cheap, matching the tenant-side pattern.
  if (name === 'overview') { loadOverview(); _overviewPollTimer = setInterval(loadOverview, 10000); }
  if (name === 'rooms') { roomsState = { view: 'blocks', blockCode: null, floorNumber: null, floorsData: null }; renderRooms(); }
  if (name === 'payments') { loadPayments(); _paymentsPollTimer = setInterval(refreshPaymentsData, 8000); }
  if (name === 'complaints') loadComplaints();
  if (name === 'tenants') loadTenants();
  if (name === 'admins') loadAdmins();
  if (name === 'audit') loadAudit();
  if (name === 'messages') initMessagesBoard('messagesBoardContainer');
}
document.querySelectorAll('.nav-item[data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

// ---------- overview ----------
let _overviewOccChart = null;
let _overviewCollChart = null;

async function loadOverview() {
  try {
    // One request instead of three-to-four (summary + blocks + monthly
    // chart + admin count) — see the comment on GET /admin/dashboard for why
    // this matters far more than it might seem.
    const data = await api('/admin/dashboard');
    const occ = data.occupancy;
    const monthly = data.monthly;
    const visibleBlockCount = me.role === 'super' ? data.blocks.length : 1;
    const subAdminCount = me.role === 'super' ? (data.subAdminCount ?? 0) : 1;
    _blocksCache = data.blocks; // keep the shared cache warm for other tabs (e.g. Payments' block filter)

    document.getElementById('iconStatGrid').innerHTML = `
      <div class="icon-stat-card" data-tone="teal" style="cursor:pointer;" onclick="showTab('rooms')" title="Go to Blocks & Rooms"><div class="icon">🏢</div><div><div class="n">${visibleBlockCount}</div><div class="l">${me.role === 'super' ? 'Blocks' : 'Your block'}</div></div></div>
      <div class="icon-stat-card" data-tone="green" style="cursor:pointer;" onclick="showTab('rooms')" title="Go to Blocks & Rooms"><div class="icon">🛏️</div><div><div class="n">${occ.totalBeds}</div><div class="l">Total beds</div></div></div>
      <div class="icon-stat-card" data-tone="blue" style="cursor:pointer;" onclick="showTab('tenants')" title="Go to All Tenants"><div class="icon">👤</div><div><div class="n">${data.totalTenants}</div><div class="l">Tenants</div></div></div>
      <div class="icon-stat-card" data-tone="gold" style="cursor:pointer;" onclick="showTab('${me.role === 'super' ? 'admins' : 'rooms'}')" title="${me.role === 'super' ? 'Go to Admin Accounts' : 'Go to Blocks & Rooms'}"><div class="icon">🛡️</div><div><div class="n">${subAdminCount}</div><div class="l">${me.role === 'super' ? 'Sub-admins' : 'Your role'}</div></div></div>
    `;

    document.getElementById('ovActiveBeds').textContent = occ.occupiedBeds;
    document.getElementById('ovBookedBeds').textContent = occ.bookedBeds;
    document.getElementById('ovVacantBeds').textContent = occ.vacantBeds;
    document.getElementById('ovTotalBeds').textContent = occ.totalBeds;

    if (typeof Chart !== 'undefined') {
      const occCtx = document.getElementById('overviewOccupancyChart').getContext('2d');
      if (_overviewOccChart) _overviewOccChart.destroy();
      if (occ.totalBeds > 0) {
        _overviewOccChart = new Chart(occCtx, {
          type: 'doughnut',
          data: { datasets: [{ data: [occ.occupiedBeds, occ.bookedBeds, occ.vacantBeds], backgroundColor: ['#3B6B4A', '#C9A227', '#E4CE83'], borderWidth: 0 }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, cutout: '68%' },
        });
      }

      const collCtx = document.getElementById('overviewCollectionChart').getContext('2d');
      if (_overviewCollChart) _overviewCollChart.destroy();
      const labels = monthly.months.map((m) => {
        const [y, mo] = m.period.split('-');
        return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('en-IN', { month: 'short' });
      });
      _overviewCollChart = new Chart(collCtx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Received', data: monthly.months.map((m) => m.collected), backgroundColor: '#3B6B4A', borderRadius: 4 },
            { label: 'Still due', data: monthly.months.map((m) => Math.max(0, m.due - m.collected)), backgroundColor: '#C9A227', borderRadius: 4 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { callback: (v) => '₹' + v.toLocaleString('en-IN') } } },
          plugins: { legend: { position: 'bottom' } },
        },
      });
    }

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

// Small cache so switching tabs back to Overview doesn't re-fetch the block
// list every time — blocks change rarely (only via Blocks & Rooms actions).
let _blocksCache = null;
async function db_listBlocksCached(forceRefresh = false) {
  if (_blocksCache && !forceRefresh) return _blocksCache;
  const data = await api('/blocks');
  _blocksCache = data.blocks;
  return _blocksCache;
}

// ---------- tenants ----------
let tenantsState = { page: 1, limit: 50, search: '', block: '', statusFilter: 'active' };
let searchDebounceTimer = null;

async function loadTenants() {
  try {
    const params = new URLSearchParams();
    params.set('page', tenantsState.page);
    params.set('limit', tenantsState.limit);
    if (tenantsState.search) params.set('search', tenantsState.search);
    if (tenantsState.block) params.set('block', tenantsState.block);
    if (tenantsState.statusFilter && tenantsState.statusFilter !== 'active') params.set('status', tenantsState.statusFilter);
    else params.set('status', 'active');

    const data = await api('/tenants?' + params.toString());
    tenantsCache = data.tenants;
    blocksCache = data.blocks; // now an array of {code, name, ...} — dynamic blocks

    const filterSel = document.getElementById('blockFilter');
    if (filterSel.options.length <= 1) {
      blocksCache.forEach((b) => {
        if (me.role === 'sub' && String(b.code) !== String(me.blockCode)) return;
        const opt = document.createElement('option');
        opt.value = b.code; opt.textContent = b.name;
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
      <td>${t.status === 'booked' ? `<span style="color:#8A5A00; font-weight:600;">📅 Booked</span>` : t.status === 'moved_out' ? `<span style="color:#8a9690;">Moved out</span>` : `<span style="color:#3B6B4A; font-weight:600;">Active</span>`}</td>
      <td style="color:#8a9690; font-size:0.8rem;">${new Date(t.updatedAt).toLocaleDateString()}</td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" onclick="openTenantHistory('${t.id}')">History</button>
          ${(t.status !== 'moved_out' && (me.role === 'super' || String(parsed.block) === String(me.blockCode))) ? `
          <button class="icon-btn" onclick="openEditTenant('${t.id}')">Edit</button>
          <button class="icon-btn danger" onclick="deleteTenant('${t.id}','${escapeHtml(t.name)}', '${t.status}')">Delete</button>` : ''}
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
function setTenantStatusFilter(status) {
  tenantsState.statusFilter = status;
  tenantsState.page = 1;
  document.querySelectorAll('.tenant-status-filter-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.status === status);
  });
  loadTenants();
}
document.querySelectorAll('.tenant-status-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => setTenantStatusFilter(btn.dataset.status));
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
  document.getElementById('fJoinDate').value = new Date().toISOString().slice(0, 10);
  if (me.role === 'sub') document.getElementById('fUid').value = String(me.blockCode);
  // Pre-fill fee fields with sensible 1-person defaults from settings — admin can change them per tenant.
  try {
    const config = await getPaymentConfigCached();
    document.getElementById('fAdvance').value = config.advanceAmount || '';
    document.getElementById('fMonthlyRent').value = (config.rentByBedCount && config.rentByBedCount[1]) || '';
  } catch (_) {}
  tenantModal.classList.add('show');
}
window.openTenantHistory = async function (id) {
  const modal = document.getElementById('tenantHistoryModalBackdrop');
  const content = document.getElementById('tenantHistoryContent');
  content.innerHTML = `<div class="skeleton" style="height:80px;"></div>`;
  modal.classList.add('show');
  try {
    const data = await api(`/tenants/${id}`);
    const t = data.tenant;
    const joined = new Date(t.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
    document.getElementById('tenantHistorySub').innerHTML =
      `${escapeHtml(t.name)} · ${renderKeycard(t.uid, 'sm')} · Joined ${joined}`;

    const totalPaid = data.payments.reduce((sum, p) => sum + Number(p.amountPaid || 0), 0);
    const rows = data.payments.map((p) => {
      const statusColor = p.status === 'paid' ? '#3B6B4A' : p.status === 'partial' ? '#8A5A00' : '#b33';
      const typeLabel = p.type === 'advance' ? 'Advance' : 'Rent';
      const paidOn = p.paidAt ? new Date(p.paidAt).toLocaleDateString('en-IN') : '—';
      return `
        <tr>
          <td>${p.period}</td>
          <td>${typeLabel}</td>
          <td>₹${Number(p.amount).toLocaleString('en-IN')}</td>
          <td>₹${Number(p.amountPaid || 0).toLocaleString('en-IN')}</td>
          <td style="color:${statusColor}; font-weight:600; text-transform:capitalize;">${p.status}</td>
          <td style="color:#8a9690;">${escapeHtml(p.method || '—')}</td>
          <td style="color:#8a9690;">${paidOn}</td>
        </tr>`;
    }).join('');

    content.innerHTML = `
      <div style="display:flex; gap:20px; margin:10px 0 16px;">
        <div><div style="font-size:1.3rem; font-weight:700;">₹${totalPaid.toLocaleString('en-IN')}</div><div style="font-size:0.76rem; color:#8a9690;">Total paid, all time</div></div>
        <div><div style="font-size:1.3rem; font-weight:700;">${data.payments.length}</div><div style="font-size:0.76rem; color:#8a9690;">Payment records</div></div>
      </div>
      <table style="width:100%; font-size:0.82rem;">
        <thead><tr style="color:#8a9690; text-align:left;"><th>Period</th><th>Type</th><th>Due</th><th>Paid</th><th>Status</th><th>Method</th><th>Paid on</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="color:#8a9690; padding:12px 0;">No payment records yet.</td></tr>'}</tbody>
      </table>`;
  } catch (e) {
    content.innerHTML = `<p style="color:#b33;">${escapeHtml(e.message)}</p>`;
  }
};

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
  document.getElementById('fJoinDate').value = t.joinDate ? new Date(t.joinDate).toISOString().slice(0, 10) : '';
  document.getElementById('fVacateDate').value = t.vacateDate ? new Date(t.vacateDate).toISOString().slice(0, 10) : '';
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
window.deleteTenant = async function (id, name, status) {
  const isBooking = status === 'booked';
  const confirmMsg = isBooking
    ? `Cancel ${name}'s booking? This removes them entirely and frees the bed.`
    : `Remove ${name}? They'll be marked as moved out — their bed frees up immediately and their payment history stays available under History, but they'll disappear from this list.`;
  if (!confirm(confirmMsg)) return;
  try {
    await api(`/tenants/${id}`, { method: 'DELETE' });
    toast(isBooking ? 'Booking cancelled' : 'Tenant moved out — bed freed, history kept', 'ok');
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
      preview.textContent = 'Invalid UID — block digit must be 1-9, room/bed cannot be 0.';
    } else { preview.style.display = 'none'; }
    return;
  }
  const editingId = document.getElementById('tenantId').value;
  // skip live availability check while editing and UID unchanged
  const existing = tenantsCache.find(t => t.id === editingId);
  if (existing && existing.uid === fUid.value) {
    const blockName = BLOCK_META[parsed.block]?.name || `Block ${parsed.block}`;
    preview.style.display = 'block'; preview.className = 'uid-preview ok';
    preview.textContent = `${blockName} • Floor ${parsed.floor} • Room ${String(parsed.room).padStart(2,'0')} • Bed ${parsed.bed} (current)`;
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
    joinDate: document.getElementById('fJoinDate').value,
    vacateDate: document.getElementById('fVacateDate').value || null,
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
    await loadBlockMeta();
    const data = await api('/admin/admins');
    document.getElementById('adminRows').innerHTML = data.admins.map((a) => `
      <tr>
        <td><b>${a.name}</b></td>
        <td class="mono">${a.uid || '<span style="color:#c1502e;">not set</span>'}</td>
        <td class="mono">${a.phone || '<span style="color:#c1502e;">not set</span>'}</td>
        <td>${a.role === 'super' ? 'Super Admin' : 'Sub-Admin'}</td>
        <td>${a.blockCode ? blockBadge(a.blockCode) : '<span style="color:#8a9690;">All blocks</span>'}</td>
        <td>${a.role === 'super' ? '<span style="color:#8a9690;">Always allowed</span>' : paymentScopeLabel(a.paymentConfirmBlocks)}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn" onclick="openCredModal('${a.id}','${escapeHtml(a.name)}','${a.uid||''}','${a.phone||''}')">Edit UID/phone</button>
            <button class="icon-btn" onclick="openPwModal('${a.id}','${escapeHtml(a.name)}')">Reset password</button>
            ${a.role === 'sub' ? `<button class="icon-btn" onclick='openPayScopeModal(${attrJson(a.id)}, ${attrJson(a.name)}, ${attrJson(a.paymentConfirmBlocks || [])})'>Payment access</button>` : ''}
            ${a.role === 'sub' ? `<button class="icon-btn danger" onclick="deleteAdminAccount('${a.id}','${escapeHtml(a.name)}')">Delete</button>` : ''}
          </div>
        </td>
      </tr>`).join('');
  } catch (e) { toast(e.message, 'err'); }
}

// Safe to drop into a single-quoted HTML attribute (e.g. onclick='...') —
// escapes any literal "'" so it can't terminate the attribute early.
function attrJson(x) { return JSON.stringify(x).replace(/'/g, '&#39;'); }

function paymentScopeLabel(scope) {
  if (!scope || !scope.length) return '<span style="color:#c1502e;">No access</span>';
  if (scope.includes('*')) return '<span style="color:#2f7a4d;">All blocks</span>';
  return `<span style="color:#2f7a4d;">${scope.map((c) => BLOCK_META[c]?.name || `Block ${c}`).join(', ')}</span>`;
}

const payScopeModal = document.getElementById('payScopeModalBackdrop');
window.openPayScopeModal = async function (id, name, currentScope) {
  await loadBlockMeta();
  document.getElementById('payScopeAdminId').value = id;
  document.getElementById('payScopeModalSub').textContent = `Choose which blocks' payments ${name} can confirm.`;
  const isAll = currentScope.includes('*');
  document.getElementById('payScopeAll').checked = isAll;
  const list = document.getElementById('payScopeBlockList');
  list.innerHTML = Object.entries(BLOCK_META).map(([code, b]) => `
    <label><input type="checkbox" class="payScopeBlockCb" value="${code}" ${currentScope.includes(String(code)) ? 'checked' : ''} /> ${escapeHtml(b.name)}</label>
  `).join('') || '<span style="color:#8a9690;">No blocks yet</span>';
  toggleBlockListDisabled();
  payScopeModal.classList.add('show');
};
function toggleBlockListDisabled() {
  const disabled = document.getElementById('payScopeAll').checked;
  document.querySelectorAll('.payScopeBlockCb').forEach((cb) => { cb.disabled = disabled; });
}
document.getElementById('payScopeAll').addEventListener('change', toggleBlockListDisabled);
document.getElementById('payScopeCancel').addEventListener('click', () => payScopeModal.classList.remove('show'));
document.getElementById('payScopeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const all = document.getElementById('payScopeAll').checked;
    let scope;
    if (all) scope = 'all';
    else {
      const picked = Array.from(document.querySelectorAll('.payScopeBlockCb:checked')).map((cb) => cb.value);
      scope = picked.length ? picked : 'none';
    }
    const id = document.getElementById('payScopeAdminId').value;
    await api(`/admin/admins/${id}/payment-scope`, { method: 'PUT', body: { scope } });
    toast('Payment confirmation access updated', 'ok');
    payScopeModal.classList.remove('show');
    loadAdmins();
  } catch (err) { toast(err.message, 'err'); }
});

window.deleteAdminAccount = async function (id, name) {
  if (!confirm(`Remove ${name}'s admin account? Their block will have no admin until you reassign one.`)) return;
  try {
    await api(`/admin/admins/${id}`, { method: 'DELETE' });
    toast('Admin removed', 'ok');
    loadAdmins();
  } catch (e) { toast(e.message, 'err'); }
};

const newAdminModal = document.getElementById('newAdminModalBackdrop');
window.openNewAdminModal = async function () {
  document.getElementById('newAdminForm').reset();
  await loadBlockMeta();
  const sel = document.getElementById('naBlock');
  sel.innerHTML = Object.entries(BLOCK_META).map(([code, b]) => `<option value="${code}">${escapeHtml(b.name)}</option>`).join('')
    || '<option value="">No blocks yet — create one first</option>';
  newAdminModal.classList.add('show');
};
document.getElementById('naCancel').addEventListener('click', () => newAdminModal.classList.remove('show'));
document.getElementById('newAdminForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/admin/admins', {
      method: 'POST',
      body: {
        name: document.getElementById('naName').value.trim(),
        blockCode: document.getElementById('naBlock').value,
        uid: document.getElementById('naUid').value.trim(),
        phone: document.getElementById('naPhone').value.trim(),
        password: document.getElementById('naPassword').value,
      },
    });
    toast('Sub-admin created', 'ok');
    newAdminModal.classList.remove('show');
    loadAdmins();
  } catch (err) { toast(err.message, 'err'); }
});

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
