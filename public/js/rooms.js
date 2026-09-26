// State for the Blocks & Rooms browser
let roomsState = { view: 'blocks', root: 'blocks', blockCode: null, floorNumber: null, floorsData: null };

function roomsBreadcrumb() {
  const el = document.getElementById('roomsBreadcrumb');
  if (roomsState.view === 'blocks' || roomsState.view === 'beds') { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const meta = BLOCK_META[roomsState.blockCode];
  // The floor/room drill-down is shared by two different entry points —
  // "Blocks & Rooms" and the dashboard's "Total beds" card — so the
  // breadcrumb's root has to reflect however you actually got here.
  const rootLabel = roomsState.root === 'beds' ? 'Beds' : 'Blocks';
  let html = `<button onclick="roomsGoTo('${roomsState.root}')">${rootLabel}</button>`;
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
  if (view === 'blocks' || view === 'beds') roomsState.root = view; // remember which top-level list to breadcrumb back to
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

  await loadBlockMeta();

  // Sub-admins now see the same block picker as Super Admin — they can
  // browse into any block (view-only there, per canManage from the API),
  // not just their own. Only write actions stay block-scoped on the backend.

  if (roomsState.view === 'blocks') {
    title.textContent = 'Blocks & Rooms';
    const blockEntries = Object.entries(BLOCK_META);

    if (blockEntries.length === 0) {
      subtitle.textContent = 'No blocks yet — create your first one to get started.';
      container.innerHTML = `
        <div class="empty-state">
          <div class="glyph">🏢</div>
          <h3>No blocks yet</h3>
          <p>Create a block (e.g. a hostel building or wing) to start adding floors and rooms.</p>
          <button class="btn gold" style="width:auto; margin-top:14px;" onclick="openBlockModal()">+ Create block</button>
        </div>`;
      return;
    }

    subtitle.textContent = 'Pick a block to manage its floors and rooms.';
    container.innerHTML = `<div class="block-grid">` + blockEntries.map(([code, b]) => `
      <div class="block-card ${b.css}" onclick="roomsGoTo('floors', ${code})">
        <div class="name">${escapeHtml(b.name)}</div>
        <div class="type">${escapeHtml(b.address) || 'No address set'}</div>
        <div class="stat" id="blockStat${code}">Loading…</div>
        ${me.role === 'super' ? `<button class="icon-btn" style="margin-top:10px;" onclick="event.stopPropagation(); openBlockModal('${code}')">Edit</button>` : ''}
      </div>`).join('') +
      (me.role === 'super' ? `
        <div class="block-card" style="display:flex; align-items:center; justify-content:center; cursor:pointer; border:2px dashed var(--line); background:none;" onclick="openBlockModal()">
          <div style="text-align:center; color:var(--pine-soft);"><div style="font-size:1.6rem;">+</div><div style="font-size:0.85rem; font-weight:600;">Create block</div></div>
        </div>` : '') +
      `</div>`;
    // fill in tenant counts async — cached so re-opening this tab doesn't
    // sit on "Loading…" every time (same pattern as Overview/Payments)
    function fillCounts(summary) {
      Object.entries(summary.perBlock).forEach(([code, b]) => {
        const el = document.getElementById('blockStat' + code);
        if (el) el.textContent = `${b.count} tenant${b.count === 1 ? '' : 's'}`;
      });
    }
    try {
      await swrLoad('getnesty_cache_block_counts', () => api('/admin/summary'), fillCounts);
    } catch (_) {}
    return;
  }

  if (roomsState.view === 'beds') {
    title.textContent = 'Beds';
    const blockEntries = Object.entries(BLOCK_META);

    if (blockEntries.length === 0) {
      subtitle.textContent = 'No blocks yet — create one from Blocks & Rooms first.';
      container.innerHTML = `
        <div class="empty-state">
          <div class="glyph">🛏️</div>
          <h3>No beds yet</h3>
          <p>Create a block and add rooms before there's any bed capacity to show here.</p>
        </div>`;
      return;
    }

    subtitle.textContent = 'Capacity and occupancy for every block — pick one to open its floors and beds.';
    container.innerHTML = `<div class="block-grid">` + blockEntries.map(([code, b]) => `
      <div class="block-card ${b.css}" onclick="roomsGoTo('floors', ${code})">
        <div class="name">${escapeHtml(b.name)}</div>
        <div class="type">${escapeHtml(b.address) || 'No address set'}</div>
        <div class="beds-mini" id="bedsMini${code}">
          <div class="skeleton" style="height:34px; margin-top:12px; border-radius:8px;"></div>
        </div>
      </div>`).join('') + `</div>`;

    // One dashboard call per block, scoped with ?block= (already supported
    // server-side for Super Admin), run in parallel — same "paint the
    // shell, fill in numbers async" pattern as the plain block list above.
    Promise.all(blockEntries.map(([code]) =>
      api(`/admin/dashboard?block=${code}`).then((d) => [code, d.occupancy]).catch(() => [code, null])
    )).then((results) => {
      results.forEach(([code, occ]) => {
        const el = document.getElementById('bedsMini' + code);
        if (!el) return;
        if (!occ) { el.innerHTML = `<div class="l" style="color:#a3ab9f; margin-top:10px;">Couldn't load bed data</div>`; return; }
        const pct = occ.totalBeds > 0 ? Math.round((occ.occupiedBeds / occ.totalBeds) * 100) : 0;
        el.innerHTML = `
          <div class="beds-mini-toprow"><b>${occ.totalBeds}</b> beds total<span>${pct}% occupied</span></div>
          <div class="beds-mini-bar"><div class="beds-mini-fill" style="width:${pct}%"></div></div>
          <div class="beds-mini-legend">
            <span><i class="dot" style="background:#2f6b3f;"></i>${occ.occupiedBeds} active</span>
            <span><i class="dot" style="background:#C9A227;"></i>${occ.bookedBeds} booked</span>
            <span><i class="dot" style="background:#E4CE83;"></i>${occ.vacantBeds} vacant</span>
          </div>`;
      });
    });
    return;
  }

  if (roomsState.view === 'floors' || roomsState.view === 'floor') {
    const meta = BLOCK_META[roomsState.blockCode];
    if (!meta) { roomsGoTo('blocks'); return; }
    title.textContent = meta.name;
    subtitle.textContent = meta.address || meta.description || '';

    const render = (data) => {
      roomsState.floorsData = data.floors;
      const canManageBlock = data.canManage;
      const floorNumbers = Object.keys(data.floors).map(Number).sort((a, b) => a - b);

      if (!canManageBlock) {
        subtitle.textContent = `Read-only — managed by the ${meta.name} block admin`;
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
          ${canManage ? `
            <div class="room-actions-wrap">
              <button class="room-actions-btn" title="Room options" onclick="toggleRoomMenu('${room.id}')">⋮</button>
              <div class="room-actions-menu" id="room-menu-${room.id}">
                <button onclick="addRoomAdjacent(${roomsState.blockCode}, ${roomsState.floorNumber}, ${room.roomNumber}, 'above')">↑ Add room above</button>
                <button onclick="addRoomAdjacent(${roomsState.blockCode}, ${roomsState.floorNumber}, ${room.roomNumber}, 'below')">↓ Add room below</button>
                <button onclick="resetRoom('${room.id}', '${room.label}')">↺ Reset room</button>
                <button class="danger" onclick="deleteRoom('${room.id}', '${room.label}')">✕ Delete room</button>
              </div>
            </div>
          ` : ''}
          <div class="bed-row">
            ${room.beds.map((bed) => `
              <div class="bed-box ${bed.occupied ? 'occupied' : bed.booked ? 'booked' : 'empty'}" onclick="openBedModal('${room.id}', ${bed.bedNumber}, '${bed.uid}', ${bed.occupied}, ${bed.booked}, '${bed.tenant ? bed.tenant.id : ''}', ${canManage}, ${room.activeBedCount})">
                ${bed.occupied
                  ? `<span class="initial">${(bed.tenant.name || '?')[0].toUpperCase()}</span>`
                  : bed.booked
                    ? `<span style="font-size:0.95rem;">📅</span>`
                    : `<span style="font-size:1.2rem;">${canManage ? '+' : ''}</span>`}
                <span class="bn">Bed ${bed.bedNumber}</span>
                ${bed.booked ? `<span style="font-size:0.62rem; color:#8A5A00; display:block;">from ${new Date(bed.tenant.joinDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>` : ''}
              </div>
            `).join('')}
            ${canManage ? `
              <button class="add-bed-btn" title="Add another bed to this room (reuses a deleted bed's slot first)" onclick="addBed('${room.id}')">+</button>
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
    };

    // Instant paint from whatever this block looked like last time (same
    // trick as Overview/Payments — see swrLoad in common.js), then quietly
    // refresh. Only show the loading skeleton when there's truly nothing
    // to show yet (first-ever visit to this block on this device).
    const cacheKey = `getnesty_cache_rooms_block_${roomsState.blockCode}`;
    const hasCache = !!sessionStorage.getItem(cacheKey);
    if (!silent && !hasCache) container.innerHTML = `<div class="skeleton" style="height:120px;"></div>`;
    try {
      await swrLoad(cacheKey, () => api(`/rooms?block=${roomsState.blockCode}`), render);
    } catch (e) {
      toast(e.message, 'err');
      if (!hasCache) container.innerHTML = `<div class="empty-state"><h3>Couldn't load rooms</h3></div>`;
    }
  }
}

// ---- Create / edit / delete block ----
const blockModal = document.getElementById('blockModalBackdrop');
window.openBlockModal = function (code) {
  document.getElementById('blockForm').reset();
  document.getElementById('blockCodeField').value = code || '';
  document.getElementById('deleteBlockBtn').style.display = code ? 'inline-block' : 'none';
  document.getElementById('clearBlockDataBtn').style.display = code ? 'inline-block' : 'none';
  document.getElementById('subAdminSection').style.display = code ? 'none' : 'block'; // only set up an admin when CREATING

  if (code && BLOCK_META[code]) {
    const b = BLOCK_META[code];
    document.getElementById('blockModalTitle').textContent = 'Edit block';
    document.getElementById('blockModalSub').textContent = `Editing ${b.name}.`;
    document.getElementById('blkName').value = b.name || '';
    document.getElementById('blkAddress').value = b.address || '';
    document.getElementById('blkOwner').value = b.owner || '';
    document.getElementById('blkDescription').value = b.description || '';
  } else {
    document.getElementById('blockModalTitle').textContent = 'Create block';
    document.getElementById('blockModalSub').textContent = 'A block is a building or wing — e.g. a hostel, a wing, a lodge.';
  }
  blockModal.classList.add('show');
};

document.getElementById('blockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = document.getElementById('blockCodeField').value;
  const payload = {
    name: document.getElementById('blkName').value.trim(),
    address: document.getElementById('blkAddress').value.trim(),
    owner: document.getElementById('blkOwner').value.trim(),
    description: document.getElementById('blkDescription').value.trim(),
  };
  if (!code) {
    const adminUid = document.getElementById('blkAdminUid').value.trim();
    if (adminUid) {
      payload.subAdmin = {
        uid: adminUid,
        phone: document.getElementById('blkAdminPhone').value.trim(),
        name: document.getElementById('blkAdminName').value.trim(),
        password: document.getElementById('blkAdminPassword').value,
      };
    }
  }
  try {
    let result;
    if (code) {
      result = await api(`/blocks/${code}`, { method: 'PUT', body: payload });
      toast('Block updated', 'ok');
    } else {
      result = await api('/blocks', { method: 'POST', body: payload });
      toast('Block created', 'ok');
      if (result.subAdminError) toast(result.subAdminError, 'err');
      else if (result.subAdmin) toast(`Admin login created — UID ${result.subAdmin.uid}`, 'ok');
    }
    blockModal.classList.remove('show');
    await loadBlockMeta(true);
    if (!code && result.block) roomsGoTo('floors', result.block.code);
    else renderRooms();
  } catch (err) { toast(err.message, 'err'); }
});

// Wipes rooms/tenants/payments/complaints for a block but KEEPS the block
// and its sub-admin — different from deleteBlockFromModal below, which
// deletes the block itself and requires it to already be empty. Requires
// typing the block's exact name back, since this can't be undone.
window.clearBlockDataFromModal = async function () {
  const code = document.getElementById('blockCodeField').value;
  const name = BLOCK_META[code]?.name || 'this block';
  const typed = prompt(`This permanently deletes every room, tenant, payment, and complaint in "${name}" — the block and its admin login stay. This can't be undone.\n\nType "${name}" to confirm:`);
  if (typed === null) return;
  if (typed.trim() !== name) { toast('Name didn\'t match — nothing was cleared', 'err'); return; }
  try {
    const result = await api(`/blocks/${code}/clear-data`, { method: 'POST', body: { confirmName: typed.trim() } });
    toast(`Cleared ${name} — removed ${result.tenantsRemoved} tenant(s) and ${result.roomsRemoved} room(s)`, 'ok');
    blockModal.classList.remove('show');
    renderRooms();
  } catch (e) { toast(e.message, 'err'); }
};

window.deleteBlockFromModal = async function () {
  const code = document.getElementById('blockCodeField').value;
  const name = BLOCK_META[code]?.name || 'this block';
  if (!confirm(`Delete ${name}? This only works if it has no rooms and no admin assigned.`)) return;
  try {
    await api(`/blocks/${code}`, { method: 'DELETE' });
    toast('Block deleted', 'ok');
    blockModal.classList.remove('show');
    await loadBlockMeta(true);
    roomsGoTo('blocks');
  } catch (e) { toast(e.message, 'err'); }
};

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

// ---- Room-level options menu: reset / delete / add adjacent room ----
window.toggleRoomMenu = function (roomId) {
  document.querySelectorAll('.room-actions-menu.show').forEach((el) => {
    if (el.id !== `room-menu-${roomId}`) el.classList.remove('show');
  });
  document.getElementById(`room-menu-${roomId}`)?.classList.toggle('show');
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('.room-actions-wrap')) {
    document.querySelectorAll('.room-actions-menu.show').forEach((el) => el.classList.remove('show'));
  }
});

// Room numbers can't be silently shifted to "make room" (a tenant's UID
// bakes the room number in) — so this asks for an explicit number, just
// suggesting one below/above the reference room as a starting point.
window.addRoomAdjacent = async function (blockCode, floorNumber, referenceRoomNumber, direction) {
  const suggested = direction === 'above' ? referenceRoomNumber - 1 : referenceRoomNumber + 1;
  const roomInput = prompt(`Room number for the new room (1-99):`, suggested >= 1 && suggested <= 99 ? suggested : '');
  if (roomInput === null) return;
  const roomNumber = parseInt(roomInput, 10);
  if (isNaN(roomNumber) || roomNumber < 1 || roomNumber > 99) { toast('Room number must be between 1 and 99', 'err'); return; }
  const bedInput = prompt('How many beds in this room?', '1');
  if (bedInput === null) return;
  const bedCount = parseInt(bedInput, 10);
  try {
    await api('/rooms', { method: 'POST', body: { blockCode, floorNumber, roomNumber, bedCount: isNaN(bedCount) ? 1 : bedCount } });
    toast('Room added', 'ok');
    renderRooms(true);
  } catch (e) { toast(e.message, 'err'); }
};

window.resetRoom = async function (roomId, label) {
  if (!confirm(`Reset room ${label}? Any booking in it is cancelled and any active tenant is moved out (their history is kept) — but the room and its beds stay. This can't be undone.`)) return;
  try {
    const res = await api(`/rooms/${roomId}/reset`, { method: 'POST' });
    toast(res.cleared ? `Room reset — ${res.cleared} occupant(s) cleared` : 'Room was already empty', 'ok');
    renderRooms(true);
  } catch (e) { toast(e.message, 'err'); }
};

window.deleteRoom = async function (roomId, label) {
  if (!confirm(`Delete room ${label} entirely — not just its tenants, the room slot itself? This can't be undone.`)) return;
  try {
    await api(`/rooms/${roomId}`, { method: 'DELETE' });
    toast('Room deleted', 'ok');
    renderRooms(true);
  } catch (e) { toast(e.message, 'err'); }
};

// ---- Add bed to existing room ----
window.addBed = async function (roomId) {
  try {
    await api(`/rooms/${roomId}/beds`, { method: 'POST' });
    toast('Bed added', 'ok');
    renderRooms(true); // silent — this is a small in-place change, not a navigation
  } catch (e) { toast(e.message, 'err'); }
};

// ---- Remove ONE SPECIFIC bed by number (only succeeds if it's empty — enforced server-side) ----
window.removeBed = async function (roomId, bedNumber) {
  if (!confirm(`Delete bed ${bedNumber}? This can't be undone, but you can add a bed back later to reuse the slot.`)) return false;
  try {
    await api(`/rooms/${roomId}/beds`, { method: 'DELETE', body: { bedNumber } });
    toast('Bed removed', 'ok');
    renderRooms(true); // silent
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
};

// Deleting a bed now lives inside the bed's own "Add tenant" modal (click the
// empty bed, then "Delete this bed") instead of a red icon sitting on the
// grid at all times — same underlying removeBed(), just closes the modal too,
// and only if the deletion actually went through (not on cancel/error).
window.deleteBedFromModal = async function (roomId, bedNumber) {
  const succeeded = await removeBed(roomId, bedNumber);
  if (succeeded) document.getElementById('bedModalBackdrop').classList.remove('show');
};

// ---- Bed click: view tenant or add one ----
const bedModal = document.getElementById('bedModalBackdrop');
window.openBedModal = async function (roomId, bedNumber, uid, occupied, booked, tenantId, canManage, bedCount) {
  const content = document.getElementById('bedModalContent');
  const isManager = canManage === true || canManage === 'true';
  const isBooked = booked === 'true' || booked === true;

  if (occupied === 'true' || occupied === true || isBooked) {
    content.innerHTML = `<div class="skeleton" style="height:180px;"></div>`;
    bedModal.classList.add('show');
    try {
      const [tData, payData] = await Promise.all([
        api(`/tenants/${tenantId}`),
        isManager ? api(`/payments/tenant/${tenantId}`) : Promise.resolve({ history: [] }),
      ]);
      const t = tData.tenant;
      const history = payData.history || [];
      const dueRows = history.filter((h) => h.status === 'due' || h.status === 'partial');

      content.innerHTML = `
        <h3>${escapeHtml(t.name)}</h3>
        <div class="sub">${tData.description}</div>
        ${isBooked ? `
          <div style="background:#FBF2D3; border:1px solid #C9A227; border-radius:8px; padding:10px 14px; margin:10px 0; font-size:0.85rem; color:#5c4708;">
            📅 <b>Booked</b> — moves in <b>${new Date(t.joinDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</b>.
            This bed is reserved and won't show as vacant, but the tenant isn't counted as occupying it until that date arrives.
          </div>
        ` : ''}
        ${t.vacateDate ? `
          <div style="background:#F1E9D2; border:1px solid #D8CFA8; border-radius:8px; padding:10px 14px; margin:10px 0; font-size:0.85rem; color:#5c4708;">
            🚪 Scheduled to vacate on <b>${new Date(t.vacateDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</b> — the bed frees up automatically that day.
          </div>
        ` : ''}
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
              <div style="margin-bottom:8px;">
                <div style="font-size:0.82rem; margin-bottom:4px;">
                  ${d.type === 'advance' ? 'Advance' : 'Rent'} (${d.period}) — ₹${d.remaining.toLocaleString('en-IN')} remaining
                  ${d.status === 'partial' ? `<span style="color:#8A5A00;"> (₹${d.amountPaid.toLocaleString('en-IN')} already paid)</span>` : ''}
                </div>
                <button type="button" class="btn ghost" style="width:auto; padding:8px 14px; margin-right:6px;" onclick="openCashPaymentFromBed('${d.id}', '${escapeHtml(t.name)}', ${d.remaining}, '${tenantId}', '${roomId}', ${bedNumber}, '${uid}', ${canManage}, ${bedCount})">Record cash</button>
                <button type="button" class="btn ${d.type === 'advance' ? 'gold' : 'ghost'}" style="width:auto; padding:8px 14px;" onclick="quickMarkPaid('${d.id}', '${tenantId}', '${roomId}', ${bedNumber}, '${uid}', ${canManage}, ${bedCount})">Mark fully paid</button>
              </div>
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
                    <td style="padding:4px 8px;">₹${h.amount.toLocaleString('en-IN')}${h.status === 'partial' ? ` <span style="color:#8A5A00;">(₹${h.remaining} left)</span>` : ''}</td>
                    <td style="padding:4px 0;">${h.status === 'paid' ? '✅ Paid' : (h.status === 'partial' ? '🟡 Partial' : '⏳ Due')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : ''}

        <div class="modal-foot">
          <button type="button" class="btn ghost" onclick="document.getElementById('bedModalBackdrop').classList.remove('show')">Close</button>
          ${isManager ? `
            <button type="button" class="btn danger" onclick="deleteTenantFromBed('${t.id}')">${isBooked ? 'Cancel booking' : 'Remove tenant'}</button>
            <button type="button" class="btn gold" onclick="editTenantFromBed('${t.id}')">Edit${isBooked ? ' / change dates' : ''}</button>
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
          <div class="field" style="flex:1;">
            <label>Join date</label>
            <input id="bfJoinDate" type="date" value="${new Date().toISOString().slice(0, 10)}" required />
            <div class="hint">A future date books this bed — it shows a distinct color and won't count as occupied until then.</div>
          </div>
          <div class="field" style="flex:1;">
            <label>Vacate date (optional)</label>
            <input id="bfVacateDate" type="date" />
            <div class="hint">Bed frees up automatically on this date, if set.</div>
          </div>
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
          ${bedCount > 1 ? `<button type="button" class="btn danger" onclick="deleteBedFromModal('${roomId}', ${bedNumber})">Delete this bed</button>` : ''}
          <button type="submit" class="btn gold" id="bfSaveBtn">Save tenant</button>
        </div>
      </form>
    `;
    bedModal.classList.add('show');
    document.getElementById('bedTenantForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const saveBtn = document.getElementById('bfSaveBtn');
      // Guard against double-submit: without this, a slow request (or an
      // impatient extra click/Enter while it's still in flight) fires a
      // second identical POST, which then fails with a "phone already
      // registered" error from the first request's own row — showing as a
      // wall of duplicate error toasts for what was really a single click.
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const result = await api('/tenants', {
          method: 'POST',
          body: {
            uid,
            name: document.getElementById('bfName').value.trim(),
            phone: document.getElementById('bfPhone').value.trim(),
            advanceAmount: document.getElementById('bfAdvance').value,
            monthlyRent: document.getElementById('bfMonthlyRent').value,
            joinDate: document.getElementById('bfJoinDate').value,
            vacateDate: document.getElementById('bfVacateDate').value || null,
            college: document.getElementById('bfCollege').value.trim(),
            hometown: document.getElementById('bfHometown').value.trim(),
            parentPhone: document.getElementById('bfParentPhone').value.trim(),
            age: document.getElementById('bfAge').value,
            gender: document.getElementById('bfGender').value,
          },
        });
        toast(result.tenant.status === 'booked' ? 'Bed booked — advance recorded' : 'Tenant added', 'ok');
        bedModal.classList.remove('show');
        renderRooms(true); // silent — this is the "adding a tenant deep in a long room list" case
      } catch (err) {
        toast(err.message, 'err');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save tenant';
      }
    });
  }
};

window.quickMarkPaid = async function (paymentId, tenantId, roomId, bedNumber, uid, canManage, bedCount) {
  if (!confirm('Mark this payment as received?')) return;
  try {
    await api(`/payments/${paymentId}/mark-paid`, { method: 'POST' });
    toast('Marked as paid', 'ok');
    openBedModal(roomId, bedNumber, uid, true, false, tenantId, canManage, bedCount); // refresh the modal in place
  } catch (e) { toast(e.message, 'err'); }
};

window.openCashPaymentFromBed = async function (paymentId, tenantName, remaining, tenantId, roomId, bedNumber, uid, canManage, bedCount) {
  const methodChoice = prompt(`How did ${tenantName} pay?\n\nType one of: cash / upi / bank / other`, 'cash');
  if (methodChoice === null) return;
  const methodKey = { cash: 'cash', upi: 'upi', bank: 'bank_transfer' }[methodChoice.trim().toLowerCase()] || 'other';

  const amount = prompt(`How much did ${tenantName} pay? (up to ₹${remaining.toLocaleString('en-IN')} remaining)`, remaining);
  if (amount === null) return;
  const num = Number(amount);
  if (isNaN(num) || num <= 0) { toast('Enter a valid amount', 'err'); return; }
  try {
    const result = await api(`/payments/${paymentId}/cash`, { method: 'POST', body: { amount: num, method: methodKey } });
    toast(result.payment.status === 'paid' ? 'Marked as fully paid' : `Recorded — ₹${result.payment.remaining.toLocaleString('en-IN')} still remaining`, 'ok');
    openBedModal(roomId, bedNumber, uid, true, false, tenantId, canManage, bedCount);
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
