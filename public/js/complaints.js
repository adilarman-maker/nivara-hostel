async function loadComplaints() {
  document.getElementById('complaintsSubtitle').textContent =
    me.role === 'super' ? 'Issues raised by tenants across all blocks.' : `Issues raised by tenants in ${BLOCK_META[me.blockCode].name}.`;
  renderComplaints();
}

async function renderComplaints() {
  const list = document.getElementById('complaintsList');
  const empty = document.getElementById('complaintsEmpty');
  const statusFilter = document.getElementById('complaintsStatusFilter').value;
  list.innerHTML = `<div class="skeleton" style="height:80px; margin-bottom:12px;"></div>`;
  try {
    const data = await api('/complaints');
    let complaints = data.complaints;
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
        ${c.status === 'open' ? `<button class="icon-btn" onclick="resolveComplaint('${c.id}')">Mark resolved</button>` : `<div class="meta">Resolved ${new Date(c.resolvedAt).toLocaleString()}</div>`}
      </div>`;
    }).join('');
  } catch (e) { toast(e.message, 'err'); }
}
document.getElementById('complaintsStatusFilter').addEventListener('change', renderComplaints);

window.resolveComplaint = async function (id) {
  try {
    await api(`/complaints/${id}/resolve`, { method: 'POST' });
    toast('Marked resolved', 'ok');
    renderComplaints();
  } catch (e) { toast(e.message, 'err'); }
};
