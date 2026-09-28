(function(){
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm = s => String(s || '').toUpperCase().replace(/\s+/g,'').replace(/[^A-Z0-9_\-]/g,'');
const store = { get(k,d){ try{ const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); }catch(e){ return d; } }, set(k,v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} } };
const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10); };
const fmtDate = iso => { if(!iso) return '—'; const [y,m,d] = iso.slice(0,10).split('-'); return `${d}.${m}.${y}`; };
const fmtTime = iso => iso ? new Date(iso).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';
const ageFrom = dob => { if(!dob) return ''; const b = new Date(dob), n = new Date(); let a = n.getFullYear()-b.getFullYear(); if(n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--; return isFinite(a) ? a : ''; };
const PAY = { paid:['Paid','ok'], pending:['Awaiting payment','warn'], comp:['Complimentary','info'], refunded:['Refunded','bad'] };
const payPill = st => { const p = PAY[st] || ['Unknown','plain']; return `<span class="pill ${p[1]}">${p[0]}</span>`; };
const labPill = k => k.status === 'received' ? `<span class="pill ok">Received ${esc(fmtDate(k.receivedAt))}</span>` : `<span class="pill plain">Not received</span>`;
let me = null, currentCode = null;

async function api(method, url, body){
  const r = await fetch(url, { method, headers: { 'Content-Type':'application/json', 'X-Requested-With':'kit-app' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { location.reload(); throw new Error('Signed out'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong.'); e.status = r.status; throw e; }
  return j;
}
let toastT;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(()=>t.hidden = true, 2800); }

/* tabs */
const TABS = ['scan','records','checkin','settings'];
function showTab(name){
  if (!TABS.includes(name)) name = 'scan';
  TABS.forEach(t => $('#tab-'+t).hidden = t !== name);
  document.querySelectorAll('nav button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === name));
  store.set('kt.tab', name);
  if (name === 'scan') setTimeout(()=>$('#scanInput').focus(), 30);
  if (name === 'records') loadRecords();
  if (name === 'checkin') setTimeout(()=>{ if(!$('#ciCode').value) $('#ciCode').focus(); }, 30);
  if (name === 'settings') loadSettings();
}
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#logout').addEventListener('click', async () => { await api('POST','/api/logout'); location.reload(); });

/* stats */
async function loadStats(){
  try {
    const s = await api('GET','/api/stats');
    $('#stRecv').textContent = s.received; $('#stOut').textContent = s.transit; $('#stUnpaid').textContent = s.unpaid;
    $('#evTitle').textContent = s.event || 'No current event set (Settings)';
    $('#stReg').textContent = s.eventTotal; $('#stPaid').textContent = s.eventPaid; $('#stPend').textContent = s.eventPending;
    const b = $('#evBadge'); b.hidden = !s.event; b.textContent = s.event;
    $('#recent').innerHTML = s.recent.length ? s.recent.map(k => `<li><button data-open="${esc(k.code)}"><b class="ellip">${esc(k.name)}</b><span class="mono" style="font-size:12px;color:var(--muted)">${esc(k.code)} · ${esc(fmtTime(k.registeredAt))} · ${k.source === 'self' ? 'self' : 'staff'}</span></button>${payPill(k.payStatus)}</li>`).join('') : '<li class="empty" style="padding:14px 0;justify-content:center;border:0">No kits registered yet</li>';
  } catch(e) {}
}

/* LAB SCAN */
const history = [];
$('#autoReceive').checked = store.get('kt.autoReceive', true);
$('#autoReceive').addEventListener('change', e => store.set('kt.autoReceive', e.target.checked));
$('#scanForm').addEventListener('submit', async e => {
  e.preventDefault();
  const code = norm($('#scanInput').value); $('#scanInput').value = '';
  if (code) await openKit(code, true);
  $('#scanInput').focus();
});
document.addEventListener('keydown', e => {
  if ($('#tab-scan').hidden) return;
  const a = document.activeElement;
  if (a && ['INPUT','SELECT','TEXTAREA'].includes(a.tagName)) return;
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) $('#scanInput').focus();
});
async function openKit(code, fromScanner){
  currentCode = code;
  let kit = null;
  try { kit = (await api('GET','/api/kits/' + encodeURIComponent(code))).kit; }
  catch(e){ if (e.status !== 404) { toast(e.message); return; } }
  if (kit && fromScanner && $('#autoReceive').checked && kit.status !== 'received') {
    try { kit = (await api('PATCH','/api/kits/' + encodeURIComponent(code), { action:'receive' })).kit; } catch(e){ toast(e.message); }
  }
  if (fromScanner) { history.unshift({ code, name: kit ? kit.name : null, at: new Date() }); if (history.length > 40) history.pop(); renderHistory(); }
  renderKit(code, kit);
  const r = $('#scanResult'); r.classList.remove('flash-ok'); void r.offsetWidth; if (kit) r.classList.add('flash-ok');
  loadStats();
}
function renderEmpty(){
  $('#scanResult').innerHTML = `<div class="empty"><svg width="48" height="48" viewBox="0 0 20 20" fill="none" style="color:var(--line)"><path d="M2 4v12M5 4v12M7.5 4v12M11 4v12M13 4v12M16 4v12M18 4v12" stroke="currentColor" stroke-width="1.2"/></svg><div><b style="color:var(--ink)">Ready to scan</b></div><div style="font-size:14px">Pull the scanner trigger on the barcode on the back of a card.</div></div>`;
}
function renderKit(code, k){
  const box = $('#scanResult');
  if (!k) {
    box.innerHTML = `<div class="stack"><div class="notice bad"><span><strong>No registration found for <span class="mono">${esc(code)}</span>.</strong> The customer may not have finished registering, or typed their number wrongly. Search Records by their name, or register the kit now.</span></div>
      <div class="row"><button class="btn primary" data-register="${esc(code)}">Register ${esc(code)}</button><button class="btn" data-tabgo="records">Search records</button></div></div>`;
    return;
  }
  const p = k.payment || {}; const age = ageFrom(k.dob); const rec = k.status === 'received';
  const amount = p.amount != null ? new Intl.NumberFormat('da-DK',{style:'currency',currency:(p.currency||me.currency||'dkk').toUpperCase()}).format(p.amount) : '—';
  box.innerHTML = `<div class="record">
    <div class="record-head">
      <div><div class="row" style="gap:8px;margin-bottom:6px"><span class="code-tag">${esc(k.code)}</span>${labPill(k)}${k.source === 'self' ? '<span class="pill plain">Self-registered</span>' : ''}</div>
      <h2>${esc(k.name)}</h2></div>${payPill(p.status)}
    </div>
    ${p.status === 'pending' ? `<div class="notice warn"><span><strong>Payment not confirmed.</strong> Check before processing this sample.</span></div>` : ''}
    ${p.status === 'refunded' ? `<div class="notice bad"><span><strong>This payment was refunded.</strong> Don't process without checking.</span></div>` : ''}
    ${!k.consentAt ? `<div class="notice warn"><span><strong>No consent recorded</strong> for processing genetic data.</span></div>` : ''}
    <dl class="facts">
      <div><dt>Date of birth</dt><dd class="num">${esc(fmtDate(k.dob))}${age !== '' ? ` <span style="color:var(--muted);font-weight:500">(${age})</span>` : ''}</dd></div>
      <div><dt>Sample date</dt><dd class="num">${esc(fmtDate(k.sampleDate))}</dd></div>
      <div><dt>Event</dt><dd>${esc(k.event || '—')}</dd></div>
      <div><dt>Email</dt><dd>${esc(k.email || '—')}</dd></div>
      <div><dt>Phone</dt><dd class="num">${esc(k.phone || '—')}</dd></div>
      ${k.notes ? `<div><dt>Notes</dt><dd>${esc(k.notes)}</dd></div>` : ''}
    </dl>
    <div class="pay">
      <div class="row"><span class="eyebrow">Payment</span><span class="spacer"></span>
        ${p.stripeSession && p.status !== 'paid' ? `<button class="btn small" data-sync="${esc(k.code)}">Check Stripe again</button>` : ''}
        ${p.status === 'pending' && me.stripe ? `<button class="btn small" data-paylink="${esc(k.code)}">Take payment with Stripe</button>` : ''}
        ${p.status !== 'paid' ? `<button class="btn small" data-markpaid="${esc(k.code)}">Mark as paid</button>` : ''}</div>
      <dl class="facts">
        <div><dt>Method</dt><dd>${esc(p.method || '—')}</dd></div>
        <div><dt>Amount</dt><dd class="num">${esc(amount)}</dd></div>
        <div><dt>Reference</dt><dd class="mono" style="font-size:13px">${esc(p.ref || '—')}</dd></div>
        ${p.paidAt ? `<div><dt>Paid</dt><dd class="num">${esc(fmtTime(p.paidAt))}</dd></div>` : ''}
      </dl>
      <div class="row" style="font-size:14px">
        ${p.receiptUrl ? `<a href="${esc(p.receiptUrl)}" target="_blank" rel="noopener">Stripe receipt</a>` : ''}
        ${p.stripePaymentIntent ? `<a href="https://dashboard.stripe.com/${me.stripeTest ? 'test/' : ''}payments/${esc(p.stripePaymentIntent)}" target="_blank" rel="noopener">Open in Stripe</a>` : ''}
      </div>
      <div id="payLinkBox" hidden></div>
    </div>
    <ul class="timeline">
      <li><span class="dot done"></span>Registered${k.source === 'self' ? ' by customer' : ' by staff'}${k.event ? ' at ' + esc(k.event) : ''} · <span class="num">${esc(fmtTime(k.registeredAt))}</span></li>
      <li><span class="dot ${rec ? 'done' : ''}"></span>${rec ? 'Received at lab · <span class="num">' + esc(fmtTime(k.receivedAt)) + '</span>' : '<span style="color:var(--muted)">Not yet received at lab</span>'}</li>
    </ul>
    <div class="row">
      ${rec ? `<button class="btn" data-unreceive="${esc(k.code)}">Undo received</button>` : `<button class="btn primary" data-receive="${esc(k.code)}">Mark as received</button>`}
      <button class="btn" data-edit="${esc(k.code)}">Edit details</button>
      <span class="spacer"></span>
      ${me.role === 'admin' ? `<button class="btn danger" data-askdel="${esc(k.code)}">Delete</button>` : ''}
    </div>
    <div id="delConfirm" hidden></div>
    <details id="histBox" data-code="${esc(k.code)}"><summary>Activity log</summary><div class="hist" id="hist">Loading…</div></details>
  </div>`;
  $('#histBox').addEventListener('toggle', async e => {
    if (!e.target.open) return;
    try { const h = (await api('GET','/api/kits/' + encodeURIComponent(k.code) + '/history')).history;
      $('#hist').innerHTML = h.map(x => `<div><span class="num">${esc(fmtTime(x.at))}</span> · ${esc(x.name || 'Customer / system')} · ${esc(x.action.replace(/_/g,' '))}${x.detail ? ' · ' + esc(x.detail) : ''}</div>`).join('') || 'No activity';
    } catch(err){ $('#hist').textContent = err.message; }
  });
}
function renderHistory(){
  $('#scanHistory').innerHTML = history.length ? history.map(h => `<li><button data-open="${esc(h.code)}"><span class="mono" style="font-size:13px">${esc(h.code)}</span><span class="ellip" style="font-size:13px;color:${h.name ? 'var(--ink)' : 'var(--bad)'}">${h.name ? esc(h.name) : 'Not found'}</span></button><span class="num" style="font-size:12px;color:var(--muted)">${h.at.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</span></li>`).join('') : '<li class="empty" style="padding:14px 0;justify-content:center;border:0">Nothing scanned yet</li>';
}

/* clicks */
document.addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) return;
  const d = t.dataset; const enc = encodeURIComponent;
  try {
    if (d.open) { showTab('scan'); await openKit(d.open, false); }
    else if (d.tabgo) { showTab(d.tabgo); }
    else if (d.receive) { const k = (await api('PATCH','/api/kits/'+enc(d.receive),{action:'receive'})).kit; renderKit(k.code,k); toast(`${k.code} marked as received`); loadStats(); }
    else if (d.unreceive) { const k = (await api('PATCH','/api/kits/'+enc(d.unreceive),{action:'unreceive'})).kit; renderKit(k.code,k); loadStats(); }
    else if (d.markpaid) {
      const box = $('#payLinkBox'); box.hidden = false;
      box.innerHTML = `<form class="row" id="mpForm"><select id="mpMethod" style="flex:1 1 140px"><option>Card terminal</option><option>MobilePay</option><option>Cash</option><option>Invoice</option><option>Stripe</option></select><input id="mpRef" type="text" placeholder="Receipt reference (optional)" style="flex:2 1 180px"><button class="btn small primary">Confirm paid</button></form>`;
      $('#mpForm').addEventListener('submit', async ev => { ev.preventDefault(); try { const k = (await api('PATCH','/api/kits/'+enc(d.markpaid),{action:'mark_paid', method:$('#mpMethod').value, ref:$('#mpRef').value})).kit; renderKit(k.code,k); toast('Marked as paid'); loadStats(); } catch(err){ toast(err.message); } });
    }
    else if (d.paylink) {
      const { url } = await api('POST','/api/kits/'+enc(d.paylink)+'/checkout');
      const box = $('#payLinkBox'); box.hidden = false;
      box.innerHTML = `<div class="notice info" style="display:grid;gap:8px"><span>Open the payment page on this device and let the customer pay, or copy the link and send it to them. The record updates to Paid by itself.</span><div class="row"><a class="btn small primary" href="${esc(url)}" target="_blank" rel="noopener">Open payment page</a><button class="btn small" type="button" id="cpPay">Copy link</button></div></div>`;
      $('#cpPay').addEventListener('click', () => navigator.clipboard.writeText(url).then(()=>toast('Link copied'), ()=>toast('Copy failed')));
    }
    else if (d.sync) { const k = (await api('POST','/api/kits/'+enc(d.sync)+'/sync')).kit; renderKit(k.code,k); toast(k.payment.status === 'paid' ? 'Payment confirmed' : 'Still not paid in Stripe'); loadStats(); }
    else if (d.register || d.edit) { const code = d.register || d.edit; showTab('checkin'); resetForm(false); $('#ciCode').value = code; await checkCi(); $('#ciName').focus(); }
    else if (d.askdel) { const c = $('#delConfirm'); c.hidden = false; c.innerHTML = `<div class="confirm"><span>Delete ${esc(d.askdel)} and this person's details for good?</span><span class="spacer"></span><button class="btn small danger" data-dodel="${esc(d.askdel)}">Delete</button><button class="btn small" data-nodel="1">Keep</button></div>`; }
    else if (d.nodel) { $('#delConfirm').hidden = true; }
    else if (d.dodel) { await api('DELETE','/api/kits/'+enc(d.dodel)); toast(`${d.dodel} deleted`); currentCode = null; renderEmpty(); loadStats(); }
    else if (d.toggleuser) { await api('PATCH','/api/users/'+d.toggleuser,{ disabled: d.disabled !== '1' }); loadSettings(); }
  } catch(err){ toast(err.message); }
});

/* RECORDS */
let recT;
async function loadRecords(){
  const qs = new URLSearchParams({ q: $('#recSearch').value.trim(), event: $('#recEvent').value, filter: $('#recFilter').value });
  $('#exportCsv').href = '/api/kits.csv?' + qs;
  try {
    const j = await api('GET','/api/kits?' + qs);
    const sel = $('#recEvent'), cur = sel.value;
    sel.innerHTML = '<option value="">All events</option>' + j.events.map(e => `<option${e === cur ? ' selected' : ''}>${esc(e)}</option>`).join('');
    $('#recBody').innerHTML = j.kits.length ? j.kits.map(k => `<tr data-row="${esc(k.code)}"><td class="mono">${esc(k.code)}</td><td><b>${esc(k.name)}</b></td><td class="num">${esc(fmtDate(k.dob))}</td><td>${esc(k.event || '—')}</td><td>${k.source === 'self' ? 'Customer' : 'Staff'}</td><td>${payPill(k.payment.status)}</td><td>${labPill(k)}</td></tr>`).join('') : `<tr><td colspan="7" class="empty">${j.total ? 'No kits match these filters.' : 'No kits registered yet.'}</td></tr>`;
    $('#recFoot').textContent = `Showing ${j.kits.length} of ${j.total} kits${j.kits.length === 500 ? ' (first 500, narrow your search)' : ''}. Click a row to open it.`;
  } catch(e){ toast(e.message); }
}
$('#recBody').addEventListener('click', e => { const r = e.target.closest('tr[data-row]'); if (r) { showTab('scan'); openKit(r.dataset.row, false); } });
['#recSearch','#recEvent','#recFilter'].forEach(s => $(s).addEventListener('input', () => { clearTimeout(recT); recT = setTimeout(loadRecords, 250); }));

/* STAFF CHECK-IN */
let editing = null;
const ci = id => $('#ci' + id);
function resetForm(focus = true){
  $('#ciForm').reset(); ci('Date').value = today(); ci('Error').hidden = true; ci('Done').hidden = true;
  ci('PayMethod').value = 'Stripe'; ci('Amount').value = me && me.price ? me.price : '';
  ci('Submit').textContent = 'Register kit'; ci('Hint').textContent = 'Click here, then scan the barcode on the back of the card.'; editing = null;
  if (focus) ci('Code').focus();
}
async function checkCi(){
  const code = norm(ci('Code').value); ci('Code').value = code; if (!code) return;
  try {
    const { kit: k } = await api('GET','/api/kits/' + encodeURIComponent(code));
    editing = code;
    ci('Name').value = k.name || ''; ci('Dob').value = k.dob || ''; ci('Date').value = k.sampleDate || today(); ci('Email').value = k.email || ''; ci('Phone').value = k.phone || '';
    const p = k.payment || {}; ci('PayStatus').value = ['paid','pending','comp'].includes(p.status) ? p.status : 'pending'; ci('PayMethod').value = p.method || 'Stripe'; ci('Amount').value = p.amount ?? ''; ci('Ref').value = p.ref || ''; ci('Notes').value = k.notes || ''; ci('Consent').checked = !!k.consentAt;
    ci('Hint').innerHTML = `<span style="color:var(--warn)">${esc(code)} is already registered to ${esc(k.name)}. Save to update their details.</span>`;
    ci('Submit').textContent = 'Save changes';
  } catch(e) {
    if (e.status === 404) { if (editing) { const keep = code; resetForm(false); ci('Code').value = keep; } editing = null; ci('Hint').textContent = `New kit ${code}. Fill in the customer's details.`; ci('Submit').textContent = 'Register kit'; }
    else toast(e.message);
  }
}
ci('Code').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); checkCi(); ci('Name').focus(); } });
ci('Code').addEventListener('change', checkCi);
ci('Reset').addEventListener('click', () => resetForm());
$('#ciForm').addEventListener('submit', async e => {
  e.preventDefault();
  const code = norm(ci('Code').value);
  const body = { code, name: ci('Name').value, dob: ci('Dob').value, sampleDate: ci('Date').value, email: ci('Email').value, phone: ci('Phone').value, notes: ci('Notes').value, consent: ci('Consent').checked,
    payment: { status: ci('PayStatus').value, method: ci('PayMethod').value, amount: ci('Amount').value, ref: ci('Ref').value } };
  const miss = []; if (!code) miss.push('scan the kit barcode'); if (body.name.trim().length < 2) miss.push('enter the full name'); if (!body.dob) miss.push('enter the date of birth');
  if (!editing && !body.consent) miss.push("confirm the customer's consent");
  if (miss.length) { ci('Error').hidden = false; ci('Error').textContent = 'To save, ' + miss.join(', ') + '.'; return; }
  ci('Error').hidden = true; ci('Submit').disabled = true;
  try {
    let k;
    if (editing) k = (await api('PATCH','/api/kits/' + encodeURIComponent(code), { action:'edit', ...body })).kit;
    else k = (await api('POST','/api/kits', body)).kit;
    toast(editing ? `${code} updated` : `${code} registered to ${k.name}`);
    const needsPay = !editing && k.payment.status === 'pending' && me.stripe;
    resetForm(!needsPay); loadStats();
    if (needsPay) { showTab('scan'); await openKit(k.code, false); const b = document.querySelector('[data-paylink]'); if (b) b.click(); }
  } catch(err){ ci('Error').hidden = false; ci('Error').textContent = err.message; }
  finally { ci('Submit').disabled = false; }
});

/* SETTINGS */
async function loadSettings(){
  $('#evName').value = me.event || ''; $('#pubLink').textContent = location.origin + '/';
  const isAdmin = me.role === 'admin';
  $('#evName').disabled = !isAdmin; $('#evSave').disabled = !isAdmin; $('#evNote').textContent = isAdmin ? '' : 'Only admins can change the current event.';
  $('#usersPanel').hidden = !isAdmin;
  if (isAdmin) {
    try { const { users } = await api('GET','/api/users');
      $('#userBody').innerHTML = users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role === 'admin' ? 'Admin' : 'Staff'}${u.disabled ? ' <span class="pill bad">Disabled</span>' : ''}</td><td>${u.id !== me.id ? `<button class="btn small" data-toggleuser="${u.id}" data-disabled="${u.disabled ? 1 : 0}">${u.disabled ? 'Enable' : 'Disable'}</button>` : ''}</td></tr>`).join('');
    } catch(e){ toast(e.message); }
  }
}
$('#evForm').addEventListener('submit', async e => { e.preventDefault(); try { await api('PUT','/api/settings',{ event: $('#evName').value }); me.event = $('#evName').value.trim(); toast('Current event saved'); loadStats(); } catch(err){ toast(err.message); } });
$('#userForm').addEventListener('submit', async e => { e.preventDefault(); try { await api('POST','/api/users',{ name:$('#uName').value, email:$('#uEmail').value, password:$('#uPw').value, role:$('#uRole').value }); $('#userForm').reset(); $('#uMsg').textContent = 'Added. Send them the sign-in link and their temporary password.'; loadSettings(); } catch(err){ $('#uMsg').textContent = err.message; } });
$('#pwForm').addEventListener('submit', async e => { e.preventDefault(); try { await api('POST','/api/me/password',{ current:$('#pwCur').value, next:$('#pwNew').value }); $('#pwForm').reset(); $('#pwMsg').textContent = 'Password changed.'; } catch(err){ $('#pwMsg').textContent = err.message; } });
$('#copyLink').addEventListener('click', () => navigator.clipboard.writeText(location.origin + '/').then(()=>toast('Link copied'), ()=>toast('Copy failed')));

/* boot */
(async function(){
  me = await api('GET','/api/me');
  $('#whoName').textContent = me.name + (me.role === 'admin' ? ' (admin)' : '');
  renderEmpty(); renderHistory(); resetForm(false);
  showTab(store.get('kt.tab','scan'));
  loadStats(); setInterval(loadStats, 20000);
})();
})();
