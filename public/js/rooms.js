// State for the Blocks & Rooms browser
let roomsState = { view: 'blocks', blockCode: null, floorNumber: null, floorsData: null };

function roomsBreadcrumb() {
  const el = document.getElementById('roomsBreadcrumb');
  if (roomsState.view === 'blocks') { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const meta = BLOCK_META[roomsState.blockCode];
  let html = `<button onclick="roomsGoTo('blocks')">Blocks</button>`;
  if (roomsState.view === 'floors' || roomsState.view === 'floor') {
    html += `<span class="sep">/</span>`;
    html += roomsState.view === 'floors'
      ? `<span class="current">${meta.name}</span>`
      : `<button onclick="roomsGoTo('floors', roomsState.blockCode)">${meta.name}</button>`;
  }
  if (roomsState.view === 'floor') {
    html += `<span class="sep">/</span><span class="current">Floor ${roomsState.floorNumber}</span>`;
  }
  el.innerHTML = html;
}

function roomsGoTo(view, blockCode, floorNumber) {
  roomsState.view = view;
  if (blockCode !== undefined) roomsState.blockCode = blockCode;
  if (floorNumber !== undefined) roomsState.floorNumber = floorNumber;
  renderRooms();
}

async function renderRooms(silent = false) {
  const scrollY = window.scrollY; // capture before touching the DOM at all
  roomsBreadcrumb();
  const container = document.getElementById('roomsContent');
  const title = document.getElementById('roomsTitle');
  const subtitle = document.getElementById('roomsSubtitle');

  // Sub-admins skip the block picker entirely — straight to their own block's floors.
  if (me.role === 'sub' && roomsState.view === 'blocks') {
    roomsState.view = 'floors';
    roomsState.blockCode = me.blockCode;
  }

  if (roomsState.view === 'blocks') {
    title.textContent = 'Blocks & Rooms';
    subtitle.textContent = 'Pick a block to manage its floors and rooms.';
    container.innerHTML = `<div class="block-grid">` + Object.entries(BLOCK_META).map(([code, b]) => `
      <div class="block-card ${b.css}" onclick="roomsGoTo('floors', ${code})">
        <div class="name">${b.name}</div>
        <div class="type">${b.type}</div>
        <div class="stat" id="blockStat${code}">Loading…</div>
      </div>`).join('') + `</div>`;
    // fill in tenant counts async
    try {
      const summary = await api('/admin/summary');
      Object.entries(summary.perBlock).forEach(([code, b]) => {
        const el = document.getElementById('blockStat' + code);
        if (el) el.textContent = `${b.count} tenant${b.count === 1 ? '' : 's'}`;
      });
    } catch (_) {}
    return;
  }

  if (roomsState.view === 'floors' || roomsState.view === 'floor') {
    const meta = BLOCK_META[roomsState.blockCode];
    title.textContent = meta.name;
    subtitle.textContent = meta.type;
    // Only show the loading skeleton on a genuine navigation (switching block/floor).
    // For a "refresh after adding a bed / tenant" we already have content on screen —
    // blanking it out first is what causes the visible flicker and the scroll-to-top
    // jump (the page briefly shrinks to skeleton height, then snaps back).
    if (!silent) container.innerHTML = `<div class="skeleton" style="height:120px;"></div>`;
    try {
      const data = await api(`/rooms?block=${roomsState.blockCode}`);
      roomsState.floorsData = data.floors;
      const canManageBlock = data.canManage;
      const floorNumbers = Object.keys(data.floors).map(Number).sort((a, b) => a - b);

      if (!canManageBlock) {
        subtitle.textContent = `${meta.type} — read-only (managed by the ${meta.name} block admin)`;
      }

      if (floorNumbers.length === 0) {
        container.innerHTML = canManageBlock ? `
          <div class="empty-state">
            <div class="glyph">🏢</div>
            <h3>No floors yet</h3>
            <p>Add the first floor to start laying out rooms.</p>
            <button class="btn gold" style="width:auto; margin-top:14px;" onclick="openFloorModal()">+ Add floor</button>
          </div>` : `
          <div class="empty-state">
            <div class="glyph">🏢</div>
            <h3>No floors yet</h3>
            <p>This block hasn't been laid out yet.</p>
          </div>`;
        return;
      }

      if (roomsState.view === 'floors') {
        // pick the first floor by default
        roomsState.floorNumber = floorNumbers[0];
        roomsState.view = 'floor';
        roomsBreadcrumb();
      }
      if (!floorNumbers.includes(roomsState.floorNumber)) roomsState.floorNumber = floorNumbers[0];

      const tabs = floorNumbers.map((f) => `
        <button class="floor-tab ${f === roomsState.floorNumber ? 'active' : ''}" onclick="roomsGoTo('floor', ${roomsState.blockCode}, ${f})">Floor ${f}</button>
      `).join('') + (canManageBlock ? `<button class="floor-tab add-floor" onclick="openFloorModal()">+ Add floor</button>` : '');

      const rooms = data.floors[roomsState.floorNumber] || [];
      const canManage = canManageBlock;
      const roomsHtml = rooms.map((room) => `
        <div class="room-block">
          <div class="room-label">${room.label}</div>
          <div class="bed-row">
            ${room.beds.map((bed) => `
              <div class="bed-box ${bed.occupied ? 'occupied' : 'empty'}" onclick="openBedModal('${room.id}', ${bed.bedNumber}, '${bed.uid}', ${bed.occupied}, '${bed.tenant ? bed.tenant.id : ''}', ${canManage}, ${room.bedCount})">
                ${bed.occupied
                  ? `<span class="initial">${(bed.tenant.name || '?')[0].toUpperCase()}</span>`
                  : `<span style="font-size:1.2rem;">${canManage ? '+' : ''}</span>`}
                <span class="bn">Bed ${bed.bedNumber}</span>
              </div>
            `).join('')}
            ${canManage ? `
              <button class="add-bed-btn" title="Add another bed to this room" onclick="addBed('${room.id}')">+</button>
              ${room.bedCount > 1 ? `<button class="add-bed-btn" title="Remove the last empty bed" onclick="removeBed('${room.id}')">−</button>` : ''}
            ` : ''}
          </div>
        </div>
      `).join('');

      container.innerHTML = `<div class="floor-tabs">${tabs}</div><div class="room-grid">${roomsHtml}</div>`;

      if (silent) {
        // Restore exactly where the admin was looking — after the browser has
        // laid out the new (same-height) content, not before.
        requestAnimationFrame(() => window.scrollTo(0, scrollY));
      }
    } catch (e) {
      toast(e.message, 'err');
      container.innerHTML = `<div class="empty-state"><h3>Couldn't load rooms</h3></div>`;
    }
  }
}

// ---- Add floor ----
const floorModal = document.getElementById('floorModalBackdrop');
function openFloorModal() {
  document.getElementById('floorModalSub').textContent = `Add a floor to ${BLOCK_META[roomsState.blockCode].name}.`;
  document.getElementById('floorForm').reset();
  floorModal.classList.add('show');
}
document.getElementById('floorCancel').addEventListener('click', () => floorModal.classList.remove('show'));
document.getElementById('floorForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/rooms/floor', {
      method: 'POST',
      body: {
        blockCode: roomsState.blockCode,
        floorNumber: parseInt(document.getElementById('floorNumber').value, 10),
        roomCount: parseInt(document.getElementById('floorRoomCount').value, 10),
      },
    });
    toast('Floor created', 'ok');
    floorModal.classList.remove('show');
    roomsState.view = 'floor';
    roomsState.floorNumber = parseInt(document.getElementById('floorNumber').value, 10);
    renderRooms();
  } catch (err) { toast(err.message, 'err'); }
});

// ---- Add bed to existing room ----
window.addBed = async function (roomId) {
  try {
    await api(`/rooms/${roomId}/beds`, { method: 'POST' });
    toast('Bed added', 'ok');
    renderRooms(true); // silent — this is a small in-place change, not a navigation
  } catch (e) { toast(e.message, 'err'); }
};

// ---- Remove the last bed (only succeeds if it's empty — enforced server-side) ----
window.removeBed = async function (roomId) {
  try {
    await api(`/rooms/${roomId}/beds`, { method: 'DELETE' });
    toast('Bed removed', 'ok');
    renderRooms(true); // silent
  } catch (e) { toast(e.message, 'err'); }
};

// ---- Bed click: view tenant or add one ----
const bedModal = document.getElementById('bedModalBackdrop');
window.openBedModal = async function (roomId, bedNumber, uid, occupied, tenantId, canManage, bedCount) {
  const content = document.getElementById('bedModalContent');
  const isManager = canManage === true || canManage === 'true';

  if (occupied === 'true' || occupied === true) {
    content.innerHTML = `<div class="skeleton" style="height:180px;"></div>`;
    bedModal.classList.add('show');
    try {
      const [tData, payData] = await Promise.all([
        api(`/tenants/${tenantId}`),
        isManager ? api(`/payments/tenant/${tenantId}`) : Promise.resolve({ history: [] }),
      ]);
      const t = tData.tenant;
      const history = payData.history || [];
      const dueRows = history.filter((h) => h.status === 'due');

      content.innerHTML = `
        <h3>${escapeHtml(t.name)}</h3>
        <div class="sub">${tData.description}</div>
        <div class="tenant-detail-grid">
          <div class="item"><div class="l">UID</div><div class="v mono">${t.uid}</div></div>
          <div class="item"><div class="l">Phone</div><div class="v mono">${t.phone}</div></div>
          <div class="item"><div class="l">Advance</div><div class="v">₹${(t.advanceAmount || 0).toLocaleString('en-IN')}</div></div>
          <div class="item"><div class="l">Monthly rent</div><div class="v">₹${(t.monthlyRent || 0).toLocaleString('en-IN')}</div></div>
          <div class="item"><div class="l">College</div><div class="v">${escapeHtml(t.college) || '—'}</div></div>
          <div class="item"><div class="l">From</div><div class="v">${escapeHtml(t.hometown) || '—'}</div></div>
          <div class="item"><div class="l">Parent's phone</div><div class="v mono">${t.parentPhone || '—'}</div></div>
          <div class="item"><div class="l">Age / Gender</div><div class="v">${t.age || '—'} ${t.gender ? '· ' + t.gender : ''}</div></div>
          ${t.email ? `<div class="item"><div class="l">Email</div><div class="v">${escapeHtml(t.email)}</div></div>` : ''}
          ${t.notes ? `<div class="item"><div class="l">Notes</div><div class="v">${escapeHtml(t.notes)}</div></div>` : ''}
        </div>

        ${isManager && dueRows.length ? `
          <div style="margin-top:6px;">
            ${dueRows.map((d) => `
              <button type="button" class="btn ${d.type === 'advance' ? 'gold' : 'ghost'}" style="width:auto; padding:9px 16px; margin:2px 6px 2px 0;" onclick="quickMarkPaid('${d.id}', '${tenantId}', '${roomId}', ${bedNumber}, '${uid}', ${canManage}, ${bedCount})">
                Mark ${d.type === 'advance' ? 'advance' : 'rent'} paid (${d.period}) — ₹${d.amount.toLocaleString('en-IN')}
              </button>
            `).join('')}
          </div>
        ` : ''}

        ${isManager && history.length ? `
          <div style="margin-top:16px;">
            <div style="font-size:0.78rem; font-weight:600; color:#8a9690; margin-bottom:8px;">Payment history</div>
            <table style="font-size:0.8rem;">
              <tbody>
                ${history.map((h) => `
                  <tr>
                    <td style="padding:4px 8px 4px 0;">${h.period}</td>
                    <td style="padding:4px 8px;">${h.type === 'advance' ? 'Advance' : 'Rent'}</td>
                    <td style="padding:4px 8px;">₹${h.amount.toLocaleString('en-IN')}</td>
                    <td style="padding:4px 0;">${h.status === 'paid' ? '✅ Paid' : '⏳ Due'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : ''}

        <div class="modal-foot">
          <button type="button" class="btn ghost" onclick="document.getElementById('bedModalBackdrop').classList.remove('show')">Close</button>
          ${isManager ? `
            <button type="button" class="btn danger" onclick="deleteTenantFromBed('${t.id}')">Remove tenant</button>
            <button type="button" class="btn gold" onclick="editTenantFromBed('${t.id}')">Edit</button>
          ` : ''}
        </div>
      `;
    } catch (e) {
      toast(e.message, 'err');
      bedModal.classList.remove('show');
    }
  } else {
    if (!isManager) return;
    let defaultAdvance = '', defaultRent = '';
    try {
      const cfg = await getPaymentConfigCached();
      defaultAdvance = cfg.advanceAmount || '';
      const tiers = cfg.rentByBedCount || {};
      defaultRent = tiers[bedCount] || tiers[Object.keys(tiers).pop()] || '';
    } catch (_) {}

    content.innerHTML = `
      <h3>Add tenant</h3>
      <div class="sub">${renderKeycard(uid, 'sm')}</div>
      <form id="bedTenantForm">
        <div class="field"><label>Full name</label><input id="bfName" required /></div>
        <div class="field"><label>Phone (10 digits)</label><input id="bfPhone" class="mono" maxlength="10" required /></div>
        <div class="field-row" style="display:flex; gap:12px;">
          <div class="field" style="flex:1;"><label>Advance amount (₹)</label><input id="bfAdvance" type="number" min="1" value="${defaultAdvance}" required /></div>
          <div class="field" style="flex:1;"><label>Monthly rent (₹)</label><input id="bfMonthlyRent" type="number" min="1" value="${defaultRent}" required /></div>
        </div>
        <div class="field-row" style="display:flex; gap:12px;">
          <div class="field" style="flex:1;"><label>College (optional)</label><input id="bfCollege" /></div>
          <div class="field" style="flex:1;"><label>From place (optional)</label><input id="bfHometown" /></div>
        </div>
        <div class="field-row" style="display:flex; gap:12px;">
          <div class="field" style="flex:1;"><label>Parent's phone (optional)</label><input id="bfParentPhone" class="mono" maxlength="10" /></div>
          <div class="field" style="flex:0 0 80px;"><label>Age</label><input id="bfAge" type="number" min="14" max="100" /></div>
          <div class="field" style="flex:1;">
            <label>Gender</label>
            <select id="bfGender" style="width:100%; padding:13px 14px; border-radius:8px; border:1.5px solid var(--line); background:var(--sand);">
              <option value="">—</option><option value="Male">Male</option><option value="Female">Female</option><option value="Other">Other</option>
            </select>
          </div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" onclick="document.getElementById('bedModalBackdrop').classList.remove('show')">Cancel</button>
          <button type="submit" class="btn gold">Save tenant</button>
        </div>
      </form>
    `;
    bedModal.classList.add('show');
    document.getElementById('bedTenantForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const result = await api('/tenants', {
          method: 'POST',
          body: {
            uid,
            name: document.getElementById('bfName').value.trim(),
            phone: document.getElementById('bfPhone').value.trim(),
            advanceAmount: document.getElementById('bfAdvance').value,
            monthlyRent: document.getElementById('bfMonthlyRent').value,
            college: document.getElementById('bfCollege').value.trim(),
            hometown: document.getElementById('bfHometown').value.trim(),
            parentPhone: document.getElementById('bfParentPhone').value.trim(),
            age: document.getElementById('bfAge').value,
            gender: document.getElementById('bfGender').value,
          },
        });
        toast('Tenant added', 'ok');
        bedModal.classList.remove('show');
        renderRooms(true); // silent — this is the "adding a tenant deep in a long room list" case
        openWhatsAppInviteModal(result.tenant);
      } catch (err) { toast(err.message, 'err'); }
    });
  }
};

window.quickMarkPaid = async function (paymentId, tenantId, roomId, bedNumber, uid, canManage, bedCount) {
  if (!confirm('Mark this payment as received?')) return;
  try {
    await api(`/payments/${paymentId}/mark-paid`, { method: 'POST' });
    toast('Marked as paid', 'ok');
    openBedModal(roomId, bedNumber, uid, true, tenantId, canManage, bedCount); // refresh the modal in place
  } catch (e) { toast(e.message, 'err'); }
};

window.deleteTenantFromBed = async function (tenantId) {
  if (!confirm('Remove this tenant? This frees up the bed.')) return;
  try {
    await api(`/tenants/${tenantId}`, { method: 'DELETE' });
    toast('Tenant removed', 'ok');
    bedModal.classList.remove('show');
    renderRooms(true); // silent
  } catch (e) { toast(e.message, 'err'); }
};

window.editTenantFromBed = async function (tenantId) {
  bedModal.classList.remove('show');
  // Reuse the existing full tenant edit modal from admin.js
  await loadTenants();
  openEditTenant(tenantId);
};
