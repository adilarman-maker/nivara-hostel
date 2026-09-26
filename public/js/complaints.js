let _complaintsFull = []; // the full unfiltered list from the last successful fetch

async function loadComplaints() {
  document.getElementById('complaintsSubtitle').textContent =
    me.role === 'super' ? 'Issues raised by tenants across all blocks.' : `Issues raised by tenants in ${BLOCK_META[me.blockCode].name}.`;

  function render(data) {
    _complaintsFull = data.complaints;
    renderComplaintsFromCache();
  }

  try {
    await swrLoad('getnesty_cache_complaints', () => api('/complaints'), render);
  } catch (e) { toast(e.message, 'err'); }
}

// Re-renders from whatever was last fetched — used both by the initial
// load and by the status filter dropdown, which doesn't need to hit the
// network at all since it's just re-slicing data already in memory.
function renderComplaintsFromCache() {
  const list = document.getElementById('complaintsList');
  const empty = document.getElementById('complaintsEmpty');
  const statusFilter = document.getElementById('complaintsStatusFilter').value;
  let complaints = _complaintsFull;
  if (statusFilter) complaints = complaints.filter((c) => c.status === statusFilter);

  empty.style.display = complaints.length ? 'none' : 'block';
  list.innerHTML = complaints.map((c) => {
    const parsed = parseUidClient(c.tenantUid);
    return `
    <div class="complaint-card ${c.status}">
      <div class="head">
        <div>
          <div class="who">${escapeHtml(c.tenantName)} <span class="mono" style="font-weight:400; color:#8a9690;">· ${c.tenantUid}</span> ${blockBadge(parsed.block)}</div>
          <div class="meta">${new Date(c.createdAt).toLocaleString()} · ${c.tenantPhone}</div>
        </div>
        <span class="status-pill ${c.status}">${c.status}</span>
      </div>
      <div class="msg">${escapeHtml(c.message)}</div>
      ${c.status === 'open' ? ((me.role === 'super' || String(parsed.block) === String(me.blockCode)) ? `<button class="icon-btn" onclick="resolveComplaint('${c.id}')">Mark resolved</button>` : `<span style="color:#8a9690; font-size:0.78rem;">Open — view only</span>`) : `<div class="meta">Resolved ${new Date(c.resolvedAt).toLocaleString()}</div>`}
    </div>`;
  }).join('');
}
document.getElementById('complaintsStatusFilter').addEventListener('change', renderComplaintsFromCache);

window.resolveComplaint = async function (id) {
  try {
    await api(`/complaints/${id}/resolve`, { method: 'POST' });
    toast('Marked resolved', 'ok');
    loadComplaints();
  } catch (e) { toast(e.message, 'err'); }
};
