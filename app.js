/* ============================================================
   Simply Connect — Attendance Console
   Frontend application logic (vanilla JS, no frameworks)
   All employee / attendance / payroll data comes from Google
   Sheets via the Apps Script Web App — nothing is hardcoded here.
   ============================================================ */

const CONFIG = {
  // Replace with your deployed Apps Script Web App URL
  // (Deploy > New deployment > Web app > Execute as: Me > Who has access: Anyone)
  API_URL: 'https://script.google.com/macros/s/REPLACE_WITH_YOUR_DEPLOYMENT_ID/exec',
  // How often to poll for live attendance while a relevant page is open (ms)
  LIVE_POLL_MS: 30000
};

/* ---------- session ---------- */
const Session = {
  KEY: 'sc_session',
  get() {
    try { return JSON.parse(sessionStorage.getItem(this.KEY) || 'null'); }
    catch (e) { return null; }
  },
  set(session) { sessionStorage.setItem(this.KEY, JSON.stringify(session)); },
  clear() { sessionStorage.removeItem(this.KEY); }
};

/* ---------- API layer ----------
   Apps Script web apps don't support custom CORS preflight handling,
   so POST bodies are sent as text/plain (no preflight) and parsed
   with JSON.parse(e.postData.contents) on the server. */
async function apiPost(action, payload) {
  const body = JSON.stringify({ action, token: Session.get()?.token || null, ...payload });
  const res = await fetch(CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body
  });
  if (!res.ok) throw new Error('Network error (' + res.status + ')');
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Request failed');
  return data;
}

async function apiGet(action, params = {}) {
  const url = new URL(CONFIG.API_URL);
  url.searchParams.set('action', action);
  url.searchParams.set('token', Session.get()?.token || '');
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error('Network error (' + res.status + ')');
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Request failed');
  return data;
}

function showToast(message, type = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

/* ---------- login ---------- */
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const loginBtn = document.getElementById('loginBtn');

document.getElementById('passwordToggle').addEventListener('click', () => {
  const input = document.getElementById('loginPassword');
  const btn = document.getElementById('passwordToggle');
  const willReveal = input.type === 'password';
  input.type = willReveal ? 'text' : 'password';
  btn.querySelector('.ic-eye').classList.toggle('hidden', willReveal);
  btn.querySelector('.ic-eye-off').classList.toggle('hidden', !willReveal);
  btn.setAttribute('aria-label', willReveal ? 'Hide password' : 'Show password');
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!username || !password) return;

  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span class="spinner"></span>Signing in…';
  try {
    const data = await apiPost('login', { username, password });
    // data: { success, token, role: 'admin'|'employee', employee: {id, name, department, ...} }
    Session.set({ token: data.token, role: data.role, employee: data.employee });
    enterApp();
  } catch (err) {
    loginError.textContent = err.message || 'Invalid username or password.';
    loginError.classList.remove('hidden');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign in';
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  Session.clear();
  stopLivePolling();
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  loginForm.reset();
  startLoginCarousel();
});

/* ---------- login screen illustration carousel ---------- */
const LOGIN_SLIDES = [
  { img: 'img/slide-attendance.png', caption: 'Live attendance, confirmed instantly' },
  { img: 'img/slide-data.png', caption: 'Payroll & reports, all in one place' },
  { img: 'img/slide-onboarding.png', caption: 'Effortless onboarding for your team' }
];
const CAROUSEL_INTERVAL_MS = 4200;
let carouselIndex = 0, carouselTimer = null;

function renderLoginCarousel() {
  const carousel = document.getElementById('loginCarousel');
  const dots = document.getElementById('loginDots');
  carousel.innerHTML = LOGIN_SLIDES.map((s, i) => `
    <div class="login-slide${i === 0 ? ' active' : ''}" data-i="${i}">
      <img src="${s.img}" alt="${escapeHtml(s.caption)}">
      <div class="slide-caption">${escapeHtml(s.caption)}</div>
    </div>`).join('');
  dots.innerHTML = LOGIN_SLIDES.map((_, i) => `<button data-i="${i}" class="${i === 0 ? 'active' : ''}" aria-label="Slide ${i + 1}"></button>`).join('');
  dots.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => goToCarouselSlide(Number(btn.dataset.i), true));
  });
}

function goToCarouselSlide(i, userInitiated) {
  const prev = carouselIndex;
  carouselIndex = (i + LOGIN_SLIDES.length) % LOGIN_SLIDES.length;
  document.querySelectorAll('#loginCarousel .login-slide').forEach(el => {
    const idx = Number(el.dataset.i);
    el.classList.toggle('active', idx === carouselIndex);
    el.classList.toggle('exit-left', idx === prev && idx !== carouselIndex);
  });
  document.querySelectorAll('#loginDots button').forEach(el => el.classList.toggle('active', Number(el.dataset.i) === carouselIndex));
  if (userInitiated) restartLoginCarousel();
}

function startLoginCarousel() {
  renderLoginCarousel();
  restartLoginCarousel();
}
function restartLoginCarousel() {
  stopLoginCarousel();
  carouselTimer = setInterval(() => goToCarouselSlide(carouselIndex + 1, false), CAROUSEL_INTERVAL_MS);
}
function stopLoginCarousel() { if (carouselTimer) clearInterval(carouselTimer); carouselTimer = null; }

document.getElementById('carouselPrev').addEventListener('click', () => goToCarouselSlide(carouselIndex - 1, true));
document.getElementById('carouselNext').addEventListener('click', () => goToCarouselSlide(carouselIndex + 1, true));

/* ---------- app entry / role setup ---------- */
function enterApp() {
  const session = Session.get();
  if (!session) return;

  stopLoginCarousel();
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');

  document.body.classList.remove('role-admin', 'role-employee');
  document.body.classList.add(session.role === 'admin' ? 'role-admin' : 'role-employee');

  // Filter sidebar nav by role
  document.querySelectorAll('.nav-item[data-role]').forEach(btn => {
    const allowed = btn.dataset.role === 'all' || btn.dataset.role === session.role;
    btn.classList.toggle('hidden', !allowed);
  });

  const name = session.employee?.name || session.employee?.username || 'User';
  document.getElementById('topbarAvatar').textContent = initials(name);
  document.getElementById('welcomeName').textContent = 'Welcome, ' + name.split(' ')[0];
  document.getElementById('welcomeDate').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  document.getElementById('settingsAccountInfo').textContent =
    name + ' · ' + (session.employee?.department || '') + ' · Role: ' + (session.role === 'admin' ? 'Administrator' : 'Employee');

  if (session.role === 'employee') {
    document.getElementById('payrollEmployeeView').classList.remove('hidden');
    document.getElementById('payrollAdminView').classList.add('hidden');
    const monthInput = document.getElementById('empPayMonth');
    monthInput.value = new Date().toISOString().slice(0, 7);
  } else {
    document.getElementById('payrollAdminView').classList.remove('hidden');
    document.getElementById('payrollEmployeeView').classList.add('hidden');
    const monthInput = document.getElementById('payMonth');
    monthInput.value = new Date().toISOString().slice(0, 7);
  }

  renderCalendar();
  showPage('dashboard');
  loadDashboard();
  startLivePolling();
}

function initials(name) {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '--';
}

/* Employees sheet columns can grow/change — employee records come back as
   { employeeId, name, department, attributes:[{label,value}] }. This looks
   up a value by one or more possible column labels, case/spacing-insensitive. */
function employeeAttr(e, ...labels) {
  if (!e || !e.attributes) return undefined;
  const norm = s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = labels.map(norm);
  const found = e.attributes.find(a => wanted.includes(norm(a.label)));
  return found && found.value !== null ? found.value : undefined;
}

/* ---------- page routing ---------- */
const PAGE_IDS = ['pageDashboard', 'pageAttendance', 'pagePayroll', 'pageRequests', 'pageEmployees', 'pageEmployeeProfile', 'pageReports', 'pageDevices', 'pageSettings'];
const PAGE_MAP = {
  dashboard: 'pageDashboard', attendance: 'pageAttendance', payroll: 'pagePayroll',
  requests: 'pageRequests', employees: 'pageEmployees', reports: 'pageReports',
  devices: 'pageDevices', settings: 'pageSettings'
};
const PAGE_LOADERS = {
  attendance: loadAttendancePage,
  payroll: loadPayrollPage,
  requests: loadRequestsPage,
  employees: loadEmployeesPage,
  devices: loadDevicesPage
};

function showPage(key) {
  const id = PAGE_MAP[key] || 'pageDashboard';
  PAGE_IDS.forEach(p => document.getElementById(p).classList.toggle('hidden', p !== id));
  if (PAGE_LOADERS[key]) PAGE_LOADERS[key]();
}

document.querySelectorAll('.nav-item[data-page]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    showPage(btn.dataset.page);
  });
});

/* ---------- dashboard ---------- */
async function loadDashboard() {
  const session = Session.get();
  const isAdmin = session.role === 'admin';

  // No explicit date — backend resolves "today" to the current shift via currentShiftDate().
  try {
    const kpi = await apiGet('getDashboardKpis');
    renderKpiRow(document.getElementById('kpiRow'), kpi.kpis, isAdmin);
  } catch (err) { showToast(err.message, 'error'); }

  try {
    const clock = await apiGet('getMyTodayAttendance');
    document.getElementById('clockInVal').textContent = 'Clock In — ' + (clock.punchIn || '—');
    document.getElementById('clockOutVal').textContent = 'Clock Out — ' + (clock.punchOut || '—');
    document.getElementById('todayHours').innerHTML = (clock.hours ?? '—') + ' <span style="font-size:13px;font-weight:500;color:var(--muted);">hrs today</span>';
  } catch (err) { /* non-fatal */ }

  document.getElementById('dashTableTitle').textContent = isAdmin ? 'Attendance — Today' : 'My Attendance — Today';
  await loadDashboardAttendance();

  if (isAdmin) {
    try {
      const off = await apiGet('getWhoIsOff');
      const box = document.getElementById('whoIsOffBox');
      document.getElementById('whoIsOffSub').textContent = 'Approved leave today · ' + off.employees.length + ' employees';
      box.innerHTML = off.employees.length
        ? off.employees.map(e => `<div style="text-align:left;padding:6px 0;">${escapeHtml(e.name)} — ${escapeHtml(e.department || '')}</div>`).join('')
        : '<div class="ic">&#128100;</div>Everyone is in today';
    } catch (err) { /* non-fatal */ }
  }
}

async function loadDashboardAttendance() {
  const session = Session.get();
  const isAdmin = session.role === 'admin';
  const body = document.getElementById('dashAttendanceBody');
  body.innerHTML = '<tr><td colspan="9" class="table-loading">Loading attendance…</td></tr>';
  try {
    // No date param — the backend resolves "today" to the current shift
    // (accounting for the overnight 5pm–7:30am window) via currentShiftDate().
    const params = {};
    if (isAdmin) {
      params.department = document.getElementById('dashDept').value;
      params.status = document.getElementById('dashStatus').value;
    }
    const data = await apiGet(isAdmin ? 'getAttendance' : 'getMyAttendance', params);
    renderAttendanceRows(body, data.rows);
  } catch (err) {
    body.innerHTML = '<tr><td colspan="9" class="table-loading">' + escapeHtml(err.message) + '</td></tr>';
  }
}
document.getElementById('dashApplyFilters')?.addEventListener('click', loadDashboardAttendance);

/* ---------- attendance page ---------- */
async function loadAttendancePage() {
  const session = Session.get();
  const isAdmin = session.role === 'admin';
  document.getElementById('attTableTitle').textContent = isAdmin ? 'Attendance' : 'My Attendance';

  const head = document.getElementById('attTableHead');
  head.innerHTML = isAdmin
    ? '<tr><th>Date</th><th>Employee ID</th><th>Name</th><th>Department</th><th>Time In</th><th>Time Out</th><th>Hours</th><th>OT</th><th>Status</th></tr>'
    : '<tr><th>Date</th><th>Time In</th><th>Time Out</th><th>Hours</th><th>OT</th><th>Status</th></tr>';

  const from = document.getElementById('attFrom');
  const to = document.getElementById('attTo');
  if (!from.value) { const d = new Date(); d.setDate(d.getDate() - 7); from.value = d.toISOString().slice(0, 10); }
  if (!to.value) to.value = new Date().toISOString().slice(0, 10);

  await fetchAttendanceRange();
}

async function fetchAttendanceRange() {
  const session = Session.get();
  const isAdmin = session.role === 'admin';
  const body = document.getElementById('attTableBody');
  body.innerHTML = '<tr><td colspan="9" class="table-loading">Loading attendance…</td></tr>';
  try {
    const params = {
      from: document.getElementById('attFrom').value,
      to: document.getElementById('attTo').value
    };
    if (isAdmin) {
      params.department = document.getElementById('attDept').value;
      params.employee = document.getElementById('attEmp').value;
    }
    const data = await apiGet(isAdmin ? 'getAttendance' : 'getMyAttendance', params);
    renderAttendanceRows(body, data.rows, !isAdmin);
  } catch (err) {
    body.innerHTML = '<tr><td colspan="9" class="table-loading">' + escapeHtml(err.message) + '</td></tr>';
  }
}
document.getElementById('attApplyFilters')?.addEventListener('click', fetchAttendanceRange);

function renderAttendanceRows(tbody, rows, compact = false) {
  if (!rows || !rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="table-loading">No attendance records found.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => compact ? `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.punchIn || '—')}</td>
      <td>${escapeHtml(r.punchOut || '—')}</td>
      <td>${escapeHtml(String(r.hours ?? 0))}</td>
      <td>${escapeHtml(String(r.overtime ?? 0))}</td>
      <td><span class="badge ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
    </tr>` : `
    <tr>
      <td>${escapeHtml(r.date)}</td>
      <td>${escapeHtml(r.employeeId)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.department || '')}</td>
      <td>${escapeHtml(r.punchIn || '—')}</td>
      <td>${escapeHtml(r.punchOut || '—')}</td>
      <td>${escapeHtml(String(r.hours ?? 0))}</td>
      <td>${escapeHtml(String(r.overtime ?? 0))}</td>
      <td><span class="badge ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
    </tr>`).join('');
}

function renderKpiRow(container, kpis, isAdmin) {
  const defs = isAdmin
    ? [['totalEmployees','&#128101;','Total employees',''], ['present','&#10003;','Present today','Present'], ['absent','&#10005;','Absent','Absent'], ['late','&#8987;','Late','Late'], ['earlyLeave','&#8618;','Early leave','Late'], ['onLeave','&#128197;','On leave','']]
    : [['presentMonth','&#10003;','Present (month)','Present'], ['absentMonth','&#10005;','Absent (month)','Absent'], ['lateMonth','&#8987;','Late (month)','Late'], ['otHoursMonth','&#8987;','OT hours (month)',''], ['attendanceRate','&#128202;','Attendance rate','']];
  container.innerHTML = defs.map(([key, icon, label, statusClass], i) => `
    <div class="kpi-card ${statusClass ? 'status-' + statusClass : ''}" style="animation-delay:${(i * 0.04).toFixed(2)}s">
      <div class="kpi-icon">${icon}</div>
      <div class="kpi-number">${escapeHtml(String(kpis[key] ?? '—'))}</div>
      <div class="kpi-label">${escapeHtml(label)}</div>
    </div>`).join('');
}

/* ---------- payroll page ---------- */
async function loadPayrollPage() {
  const session = Session.get();
  if (session.role === 'admin') {
    await loadAdminPayroll();
  } else {
    await loadEmployeePayslip();
  }
}

async function loadAdminPayroll() {
  const body = document.getElementById('payrollTableBody');
  body.innerHTML = '<tr><td colspan="11" class="table-loading">Loading payroll…</td></tr>';
  const month = document.getElementById('payMonth').value || new Date().toISOString().slice(0, 7);
  try {
    const data = await apiGet('getPayrollSummary', {
      month, department: document.getElementById('payDept').value, search: document.getElementById('paySearch').value
    });
    document.getElementById('payTableTitle').textContent = 'Payroll — ' + monthLabel(month);
    renderKpiRow(document.getElementById('payrollKpiRow'), data.kpis || {}, true);
    if (!data.rows.length) {
      body.innerHTML = '<tr><td colspan="11" class="table-loading">No payroll records for this month.</td></tr>';
      return;
    }
    body.innerHTML = data.rows.map(r => `
      <tr>
        <td>${escapeHtml(r.employeeId)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.department || '')}</td>
        <td>${money(r.basic)}</td><td>${money(r.allowances)}</td>
        <td>${escapeHtml(String(r.present ?? 0))} / ${escapeHtml(String(r.absent ?? 0))}</td>
        <td>${money(r.overtimePay)}</td><td>${money(r.deductions)}</td>
        <td><strong>${money(r.netPay)}</strong></td>
        <td><span class="badge ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
        <td><button class="btn-secondary" onclick="viewPayslip('${escapeHtml(r.employeeId)}','${month}')">View payslip</button></td>
      </tr>`).join('');
  } catch (err) {
    body.innerHTML = '<tr><td colspan="11" class="table-loading">' + escapeHtml(err.message) + '</td></tr>';
  }
}
document.getElementById('payApplyFilters')?.addEventListener('click', loadAdminPayroll);

async function loadEmployeePayslip() {
  const card = document.getElementById('empPayslipCard');
  card.innerHTML = '<div class="table-loading">Loading your payslip…</div>';
  const month = document.getElementById('empPayMonth').value || new Date().toISOString().slice(0, 7);
  try {
    const data = await apiGet('getMyPayslip', { month });
    card.innerHTML = payslipMarkup(data.payslip, month);
  } catch (err) {
    card.innerHTML = '<div class="table-loading">' + escapeHtml(err.message) + '</div>';
  }
}
document.getElementById('empPayMonth')?.addEventListener('change', loadEmployeePayslip);

async function viewPayslip(employeeId, month) {
  const detail = document.getElementById('payslipDetail');
  detail.classList.remove('hidden');
  detail.innerHTML = '<div class="table-loading">Loading payslip…</div>';
  detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const data = await apiGet('getPayslip', { employeeId, month });
    detail.innerHTML = payslipMarkup(data.payslip, month, true);
  } catch (err) {
    detail.innerHTML = '<div class="table-loading">' + escapeHtml(err.message) + '</div>';
  }
}

function payslipMarkup(p, month, withDownload = false) {
  return `
    <div class="payslip-head">
      <div>
        <div class="ps-period">Payslip · ${monthLabel(month)}</div>
        <h3>${escapeHtml(p.name)} — ${escapeHtml(p.employeeId)}</h3>
      </div>
      <div class="ps-net"><div class="lbl">Net pay</div><div class="amt">${money(p.netPay)}</div></div>
    </div>
    <div class="payslip-body">
      <div class="ps-emp-meta">
        <div><span class="lbl">Department</span><span class="val">${escapeHtml(p.department || '')}</span></div>
        <div><span class="lbl">Designation</span><span class="val">${escapeHtml(p.designation || '')}</span></div>
        <div><span class="lbl">Present / Absent</span><span class="val">${escapeHtml(String(p.present ?? 0))} / ${escapeHtml(String(p.absent ?? 0))} days</span></div>
        <div><span class="lbl">Overtime</span><span class="val">${escapeHtml(String(p.overtimeHours ?? 0))} hrs</span></div>
      </div>
      <div class="ps-col">
        <h4>Earnings</h4>
        <div class="ps-line"><span>Basic salary</span><span>${money(p.basic)}</span></div>
        <div class="ps-line"><span>Allowances</span><span>${money(p.allowances)}</span></div>
        <div class="ps-line"><span>Overtime pay</span><span class="pos">+ ${money(p.overtimePay)}</span></div>
        <div class="ps-line total"><span>Gross earnings</span><span>${money(p.gross)}</span></div>
      </div>
      <div class="ps-col">
        <h4>Deductions</h4>
        <div class="ps-line"><span>Absences / late</span><span class="neg">− ${money(p.deductions)}</span></div>
        <div class="ps-line total"><span>Total deductions</span><span>${money(p.deductions)}</span></div>
      </div>
    </div>
    ${withDownload ? `<div style="padding:0 28px 24px;"><button class="btn-secondary" onclick="downloadPayslipPdf('${escapeHtml(p.employeeId)}','${month}')">&#11015; Download PDF</button></div>` : ''}
  `;
}

document.getElementById('downloadPayslipBtn').addEventListener('click', () => {
  const session = Session.get();
  const month = document.getElementById('empPayMonth').value || new Date().toISOString().slice(0, 7);
  downloadPayslipPdf(session.employee.id, month);
});

async function downloadPayslipPdf(employeeId, month) {
  showToast('Preparing your payslip PDF…');
  try {
    const data = await apiGet('getPayslipPdf', { employeeId, month });
    // data.pdfBase64 is a base64-encoded PDF generated server-side by Apps Script
    const byteChars = atob(data.pdfBase64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNumbers)], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Payslip_${employeeId}_${month}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
function money(n) {
  if (n === undefined || n === null || n === '') return '—';
  return 'Rs ' + Number(n).toLocaleString();
}

/* ---------- requests page ---------- */
async function loadRequestsPage() {
  const session = Session.get();
  const isAdmin = session.role === 'admin';
  const body = document.getElementById('requestsTableBody');
  body.innerHTML = '<tr><td colspan="7" class="table-loading">Loading requests…</td></tr>';
  document.getElementById('requestsTitle').textContent = isAdmin ? 'Leave & Regularization Requests — All employees' : 'My Requests';
  try {
    const data = await apiGet('getRequests');
    if (!data.requests.length) {
      body.innerHTML = '<tr><td colspan="7" class="table-loading">No requests found.</td></tr>';
      return;
    }
    body.innerHTML = data.requests.map(r => {
      const dates = r.leaveTo && r.leaveTo !== r.leaveFrom ? `${r.leaveFrom} – ${r.leaveTo}` : r.leaveFrom;
      return `
      <tr>
        <td>${escapeHtml(dates)}</td>
        <td class="admin-only-col">${escapeHtml(r.employeeName || '')}</td>
        <td>${escapeHtml(r.type)}</td>
        <td>${escapeHtml(r.reason || '')}</td>
        <td><span class="badge ${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
        <td class="admin-only-col">${escapeHtml(r.approvedBy || '—')}</td>
        <td class="admin-only-col">${isAdmin && r.status === 'Pending' ? `<button class="btn-secondary" onclick="actOnRequest('${r.id}','Approved')">Approve</button> <button class="btn-secondary" onclick="actOnRequest('${r.id}','Rejected')">Reject</button>` : ''}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    body.innerHTML = '<tr><td colspan="7" class="table-loading">' + escapeHtml(err.message) + '</td></tr>';
  }
}

async function actOnRequest(id, decision) {
  try {
    await apiPost('decideRequest', { id, decision });
    showToast('Request ' + decision.toLowerCase(), 'success');
    loadRequestsPage();
  } catch (err) { showToast(err.message, 'error'); }
}

document.getElementById('newRequestBtn')?.addEventListener('click', async () => {
  const type = prompt('Request type (Leave / Regularization):', 'Leave');
  if (!type) return;
  const leaveFrom = prompt('Leave from (YYYY-MM-DD):', new Date().toISOString().slice(0, 10));
  if (!leaveFrom) return;
  const leaveTo = prompt('Leave to (YYYY-MM-DD):', leaveFrom);
  if (!leaveTo) return;
  const reason = prompt('Reason:', '');
  try {
    await apiPost('createRequest', { type, reason, leaveFrom, leaveTo });
    showToast('Request submitted', 'success');
    loadRequestsPage();
  } catch (err) { showToast(err.message, 'error'); }
});

/* ---------- employees page (admin) ---------- */
let allEmployeesCache = [];
async function loadEmployeesPage() {
  const grid = document.getElementById('empGrid');
  grid.innerHTML = '<div class="table-loading">Loading employees…</div>';
  try {
    const data = await apiGet('getEmployees');
    allEmployeesCache = data.employees;
    populateDeptFilter(data.employees);
    document.getElementById('empStatusFilter').style.display =
      data.employees.some(e => employeeAttr(e, 'Status', 'Employment Status')) ? '' : 'none';
    renderEmployeeGrid(data.employees);
  } catch (err) {
    grid.innerHTML = '<div class="table-loading">' + escapeHtml(err.message) + '</div>';
  }
}

function populateDeptFilter(employees) {
  const sel = document.getElementById('empDeptFilter');
  const depts = [...new Set(employees.map(e => e.department).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">All departments</option>' + depts.map(d => `<option>${escapeHtml(d)}</option>`).join('');
}

function renderEmployeeGrid(employees) {
  const grid = document.getElementById('empGrid');
  const hasStatusData = employees.some(e => employeeAttr(e, 'Status', 'Employment Status'));
  document.getElementById('empCount').textContent = hasStatusData
    ? `${employees.length} employees · ${employees.filter(e => employeeAttr(e, 'Status', 'Employment Status') === 'Active').length} active`
    : `${employees.length} employees`;
  if (!employees.length) { grid.innerHTML = '<div class="table-loading">No employees found.</div>'; return; }
  grid.innerHTML = employees.map((e, i) => {
    const designation = employeeAttr(e, 'Designation') || '';
    const status = employeeAttr(e, 'Status', 'Employment Status');
    return `
    <div class="emp-card" style="animation-delay:${(i * 0.03).toFixed(2)}s" onclick="openEmployeeProfile('${escapeHtml(e.employeeId)}')">
      <div class="emp-avatar" style="background:${avatarColor(e.name)};">${initials(e.name)}<span class="presence" style="background:${status === 'Active' ? 'var(--success)' : 'var(--muted)'};"></span></div>
      <div class="emp-name">${escapeHtml(e.name)}</div><div class="emp-role">${escapeHtml(designation)}</div>
      <div class="emp-dept-badge">${escapeHtml(e.department || '')}</div>
      <div class="emp-mini-contact"><div class="mc-icon">&#9993;</div><div class="mc-icon">&#128222;</div><div class="mc-icon">&#128337;</div></div>
    </div>`;
  }).join('');
}

function avatarColor(name) {
  const palette = ['#F4B400,#F2994A', '#6A63E0,#8E88EF', '#2E7D32,#66BB6A', '#C0392B,#E17055', '#2E5FA3,#5B8DEF', '#B7791F,#F2C14E'];
  let h = 0; for (const c of (name || '')) h = (h + c.charCodeAt(0)) % palette.length;
  return `linear-gradient(135deg,${palette[h]})`;
}

document.getElementById('empSearchInput')?.addEventListener('input', filterEmployees);
document.getElementById('empDeptFilter')?.addEventListener('change', filterEmployees);
document.getElementById('empStatusFilter')?.addEventListener('change', filterEmployees);
function filterEmployees() {
  const q = document.getElementById('empSearchInput').value.toLowerCase();
  const dept = document.getElementById('empDeptFilter').value;
  const status = document.getElementById('empStatusFilter').value;
  const filtered = allEmployeesCache.filter(e =>
    (!q || e.name.toLowerCase().includes(q) || e.employeeId.toLowerCase().includes(q) || (e.department || '').toLowerCase().includes(q)) &&
    (!dept || e.department === dept) && (!status || employeeAttr(e, 'Status', 'Employment Status') === status));
  renderEmployeeGrid(filtered);
}

/* ---------- employee profile (admin drill-down) ---------- */
async function openEmployeeProfile(employeeId) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  PAGE_IDS.forEach(p => document.getElementById(p).classList.toggle('hidden', p !== 'pageEmployeeProfile'));
  document.getElementById('ptabOverview').classList.remove('hidden');
  document.getElementById('ptabAttendance').classList.add('hidden');
  document.getElementById('ptabPayroll').classList.add('hidden');
  document.querySelectorAll('.profile-tabs button').forEach(b => b.classList.toggle('active', b.dataset.ptab === 'overview'));
  window.scrollTo({ top: 0, behavior: 'smooth' });

  try {
    const data = await apiGet('getEmployeeProfile', { employeeId });
    const e = data.employee;
    const designation = employeeAttr(e, 'Designation') || '';
    const status = employeeAttr(e, 'Status', 'Employment Status');
    const joinDate = employeeAttr(e, 'D.O.J', 'DOJ', 'Joining Date', 'JoiningDate');

    document.getElementById('profAvatar').textContent = initials(e.name);
    document.getElementById('profName').textContent = e.name;
    document.getElementById('profRoleLine').textContent = `${designation} · ${e.department || ''} · ${e.employeeId}`;
    document.getElementById('profTags').innerHTML = [
      status ? `<span class="profile-tag ${status === 'Active' ? 'active-tag' : ''}">${escapeHtml(status)}</span>` : '',
      joinDate ? `<span class="profile-tag">Joined ${escapeHtml(String(joinDate))}</span>` : ''
    ].join('');
    document.getElementById('profMiniStats').innerHTML = [
      [e.presentMonth ?? '—', 'Present (month)'], [e.absentMonth ?? '—', 'Absent (month)'],
      [e.lateMonth ?? '—', 'Late (month)'], [e.otHoursMonth ?? '—', 'OT hours (month)'], [e.attendanceRate ?? '—', 'Attendance rate']
    ].map(([n, l]) => `<div class="mini-stat"><div class="n">${escapeHtml(String(n))}</div><div class="l">${escapeHtml(l)}</div></div>`).join('');

    // Every column from the Employees sheet is shown here automatically —
    // add a new column in the sheet and it appears on this page with no code change.
    const infoItems = [{ label: 'Employee ID', value: e.employeeId }, ...e.attributes];
    document.getElementById('profInfoGrid').innerHTML = infoItems
      .map(a => `<div class="info-item"><div class="lbl">${escapeHtml(a.label)}</div><div class="val">${a.value !== null && a.value !== undefined && a.value !== '' ? escapeHtml(String(a.value)) : '—'}</div></div>`)
      .join('');

    document.getElementById('backToEmployeesBtn').onclick = () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === 'employees'));
      showPage('employees');
    };

    document.querySelectorAll('.profile-tabs button').forEach(btn => {
      btn.onclick = async () => {
        document.querySelectorAll('.profile-tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        ['overview', 'attendance', 'payroll'].forEach(t => document.getElementById('ptab' + t[0].toUpperCase() + t.slice(1)).classList.toggle('hidden', t !== btn.dataset.ptab));
        if (btn.dataset.ptab === 'attendance') loadProfileAttendance(e.employeeId);
        if (btn.dataset.ptab === 'payroll') loadProfilePayslip(e.employeeId);
      };
    });
  } catch (err) { showToast(err.message, 'error'); }
}

async function loadProfileAttendance(employeeId) {
  const body = document.getElementById('profAttendanceBody');
  body.innerHTML = '<tr><td colspan="6" class="table-loading">Loading…</td></tr>';
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const data = await apiGet('getAttendance', { employeeId, from, to });
    renderAttendanceRows(body, data.rows.map(r => ({ ...r })), true);
  } catch (err) { body.innerHTML = '<tr><td colspan="6" class="table-loading">' + escapeHtml(err.message) + '</td></tr>'; }
}

async function loadProfilePayslip(employeeId) {
  const card = document.getElementById('profPayslipCard');
  card.innerHTML = '<div class="table-loading">Loading…</div>';
  const month = new Date().toISOString().slice(0, 7);
  try {
    const data = await apiGet('getPayslip', { employeeId, month });
    card.innerHTML = payslipMarkup(data.payslip, month, true);
  } catch (err) { card.innerHTML = '<div class="table-loading">' + escapeHtml(err.message) + '</div>'; }
}

/* ---------- devices page (admin) ---------- */
async function loadDevicesPage() {
  const body = document.getElementById('devicesTableBody');
  body.innerHTML = '<tr><td colspan="5" class="table-loading">Loading…</td></tr>';
  try {
    const data = await apiGet('getDevices');
    if (!data.devices.length) { body.innerHTML = '<tr><td colspan="5" class="table-loading">No devices registered.</td></tr>'; return; }
    body.innerHTML = data.devices.map(d => `
      <tr><td>${escapeHtml(d.name)}</td><td>${escapeHtml(d.location || '')}</td><td>${escapeHtml(d.ipAddress || '')}</td><td>${escapeHtml(d.lastSync || '—')}</td>
      <td><span class="badge ${d.online ? 'Present' : 'Absent'}">${d.online ? 'Online' : 'Offline'}</span></td></tr>`).join('');
  } catch (err) { body.innerHTML = '<tr><td colspan="5" class="table-loading">' + escapeHtml(err.message) + '</td></tr>'; }
}

/* ---------- calendar (static month view) ---------- */
function renderCalendar() {
  const grid = document.getElementById('calGrid');
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const cells = ['S','M','T','W','T','F','S'].map(d => `<div class="dow">${d}</div>`);
  for (let i = 0; i < startDow; i++) cells.push(`<div class="day muted"></div>`);
  for (let d = 1; d <= daysInMonth; d++) cells.push(`<div class="day ${d === now.getDate() ? 'today' : ''}">${d}</div>`);
  grid.innerHTML = cells.join('');
}

/* ---------- live attendance polling ---------- */
let liveTimer = null;
function startLivePolling() {
  stopLivePolling();
  liveTimer = setInterval(() => {
    if (!document.getElementById('pageDashboard').classList.contains('hidden')) loadDashboardAttendance();
    if (!document.getElementById('pageAttendance').classList.contains('hidden')) fetchAttendanceRange();
  }, CONFIG.LIVE_POLL_MS);
}
function stopLivePolling() { if (liveTimer) clearInterval(liveTimer); liveTimer = null; }

/* ---------- utils ---------- */
function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- boot ---------- */
(function boot() {
  const session = Session.get();
  if (session && session.token) {
    enterApp();
  } else {
    startLoginCarousel();
  }
})();
