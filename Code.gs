/**
 * =============================================================
 *  Simply Connect — Attendance Console — Apps Script Backend
 * =============================================================
 * Deploy: Extensions > Apps Script > Deploy > New deployment
 *         Type: Web app | Execute as: Me | Who has access: Anyone
 * Copy the resulting /exec URL into CONFIG.API_URL in app.js.
 *
 * Google Sheet tabs — these match Employees_Data.xlsx exactly.
 * Header rows (row 1) must read exactly as below (case-sensitive,
 * including spaces):
 *
 *  Employee   <-- singular tab name
 *    EMP ID | Name | Designation | Department | Team | D.O.J | Timings | Salary
 *    Schema-driven beyond ID/Name: add, rename, or reorder columns
 *    anytime and they show up automatically on the employee profile
 *    page — see normalizeEmployee() below.
 *
 *  Attendance   <-- populated by the ZKTeco bridge (pushAttendance)
 *    Date | EMP ID | Employee Name | Punch In | Punch Out | Working Hours | Status
 *    "Date" here is the SHIFT date, not the calendar date of every scan
 *    — see the shift-window notes below. Working Hours/Status are
 *    computed and written automatically by pushAttendance(); the app
 *    itself always recomputes them fresh on read, so they stay correct
 *    even if this sheet is edited by hand.
 *
 *  Payroll
 *    EMP ID | Employee Name | Month(YYYY-MM) | Basic Salary | Allowances |
 *    Overtime Hours | Overtime Rate | Overtime Amount | Gross Salary |
 *    Deductions | Net Salary | Status
 *    Gross Salary / Net Salary / Overtime Amount are read directly from
 *    the sheet if present; if left blank, the app computes them from
 *    the other columns (and falls back to the Employee sheet's Salary
 *    column for Basic Salary if that's blank too).
 *
 *  Users
 *    Username | PasswordHash | Role (Admin/Employee) | EMP ID
 *
 *  Requests
 *    ID | EMP ID | Employee Name | Leave From | Leave To | Leave Type |
 *    Reason | Status | Approved By
 *
 *  Devices
 *    Device Name | Location | IP Address | Last Sync | Online
 *
 * Script Properties (Project Settings > Script properties):
 *    TOKEN_SECRET   -> any long random string, used to sign session tokens
 *    BRIDGE_SECRET  -> shared secret the ZKTeco bridge script must send
 *
 * TWO PUNCH MACHINES
 *    The office has two separate ZKTeco terminals — one dedicated to
 *    punch IN, one dedicated to punch OUT, each with its own IP address
 *    (configured in zkteco_bridge.py as DEVICE_IN_IP / DEVICE_OUT_IP).
 *    The bridge tags every scan with which machine it came from, so
 *    pushAttendance() below trusts that directly instead of guessing
 *    in/out from the time of day — far more reliable. The shift still
 *    runs ~5:00 PM to ~7:30 AM overnight: an OUT scan in the early
 *    morning (before 7:30 AM) is filed under the PREVIOUS calendar day
 *    (the day the shift started), so one overnight shift stays on a
 *    single Attendance row. A repeat scan for a slot (in or out)
 *    that's already filled for that shift is treated as a duplicate
 *    and ignored. See shiftDateFor() and pushAttendance() below.
 * =============================================================
 */

const SHEET_NAMES = {
  USERS: 'Users', EMPLOYEES: 'Employee', ATTENDANCE: 'Attendance',
  PAYROLL: 'Payroll', REQUESTS: 'Requests', DEVICES: 'Devices'
};
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8 hour session

/* ---------------- shift window ---------------- */
const SHIFT_START_HOUR = 17;   // 5:00 PM — used for the "Late" arrival threshold
const SHIFT_END_HOUR = 7;      // 7:30 AM — used only to decide what "today" means on dashboards
const SHIFT_END_MINUTE = 30;

/** Which shift date (the day the shift STARTED) a punch belongs to.
 *  punchType comes straight from the bridge (it knows which physical
 *  machine sent the scan), so this only has to work out the DATE:
 *   - an IN scan belongs to the shift starting that calendar day.
 *   - an OUT scan before 7:30 AM belongs to the PREVIOUS day's shift
 *     (the overnight shift that's just ending); later than that, it
 *     stays on the same day (covers rare long/late shifts). */
function shiftDateFor(ts, punchType) {
  if (punchType === 'in') return fmtDate(ts);
  const hour = ts.getHours(), minute = ts.getMinutes();
  const stillEarlyMorning = hour < SHIFT_END_HOUR || (hour === SHIFT_END_HOUR && minute <= SHIFT_END_MINUTE);
  if (stillEarlyMorning) {
    const prevDay = new Date(ts);
    prevDay.setDate(prevDay.getDate() - 1);
    return fmtDate(prevDay);
  }
  return fmtDate(ts);
}

/** What "today" means for dashboards right now — if it's currently the
 *  early-morning tail of an overnight shift (before 7:30 AM), "today"
 *  should still mean the shift that started yesterday evening. */
function currentShiftDate() {
  const now = new Date();
  const hour = now.getHours(), minute = now.getMinutes();
  const stillEarlyMorning = hour < SHIFT_END_HOUR || (hour === SHIFT_END_HOUR && minute <= SHIFT_END_MINUTE);
  if (stillEarlyMorning) {
    const prevDay = new Date(now);
    prevDay.setDate(prevDay.getDate() - 1);
    return fmtDate(prevDay);
  }
  return fmtDate(now);
}

/* ---------------- Employee: schema-driven column handling ----------------
 * The Employee sheet's columns can grow or be renamed over time, so only
 * the identifying "ID" column is located by name (a few common spellings
 * are tried). Every other column — Designation, Department, Team, D.O.J,
 * Timings, Salary, or anything added later — is passed through to the UI
 * generically, so new columns show up automatically without code changes. */
function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}
const EMP_ID_ALIASES = ['empid', 'employeeid', 'id'];

function findEmployeeIdKey(row) {
  const keys = Object.keys(row);
  for (const alias of EMP_ID_ALIASES) {
    const match = keys.find(k => normalizeHeader(k) === alias);
    if (match) return match;
  }
  return keys[0]; // fall back to the first column if nothing matches
}

function employeeIdOf(row) { return String(row[findEmployeeIdKey(row)]); }

/** Turns a raw Employee sheet row into a normalized shape:
 *  { employeeId, name, department, attributes: [{label, value}, ...] }
 *  attributes holds every column besides ID/Name (Department stays in
 *  there too, for a complete generic listing) so the profile page and
 *  employee cards can display whatever columns the sheet currently has. */
function normalizeEmployee(row) {
  const idKey = findEmployeeIdKey(row);
  const nameKey = Object.keys(row).find(k => normalizeHeader(k) === 'name') || null;
  const deptKey = Object.keys(row).find(k => ['department', 'dept'].includes(normalizeHeader(k))) || null;
  const attributes = [];
  Object.keys(row).forEach(key => {
    if (key === idKey || key === nameKey) return;
    let val = row[key];
    if (val instanceof Date) val = fmtDate(val);
    attributes.push({ label: key, value: (val === '' || val === null || val === undefined) ? null : val });
  });
  return {
    employeeId: String(row[idKey]),
    name: nameKey ? row[nameKey] : '',
    department: deptKey ? row[deptKey] : '',
    attributes
  };
}

/** Looks up a value on a normalized employee by one or more possible
 *  column labels (case/spacing-insensitive), e.g. attrValue(e, 'Salary'). */
function attrValue(employee, ...labelAliases) {
  const wanted = labelAliases.map(normalizeHeader);
  const found = employee.attributes.find(a => wanted.includes(normalizeHeader(a.label)));
  return found ? found.value : undefined;
}

/* ---------------- HTTP entry points ---------------- */

function doGet(e) {
  try {
    const action = e.parameter.action;
    const session = requireSession(e.parameter.token);
    const result = routeGet(action, e.parameter, session);
    return jsonOut({ success: true, ...result });
  } catch (err) {
    return jsonOut({ success: false, error: err.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action;

    // Login and the ZKTeco bridge endpoint don't require an existing session.
    if (action === 'login') return jsonOut({ success: true, ...login(body.username, body.password) });
    if (action === 'pushAttendance') return jsonOut({ success: true, ...pushAttendance(body) });

    const session = requireSession(body.token);
    const result = routePost(action, body, session);
    return jsonOut({ success: true, ...result });
  } catch (err) {
    return jsonOut({ success: false, error: err.message });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function routeGet(action, params, session) {
  switch (action) {
    case 'getDashboardKpis': return getDashboardKpis(params, session);
    case 'getMyTodayAttendance': return getMyTodayAttendance(session);
    case 'getMyAttendance': return getMyAttendance(params, session);
    case 'getAttendance': requireAdmin(session); return getAttendance(params);
    case 'getWhoIsOff': requireAdmin(session); return getWhoIsOff(params);
    case 'getEmployees': requireAdmin(session); return getEmployees();
    case 'getEmployeeProfile': requireAdmin(session); return getEmployeeProfile(params.employeeId);
    case 'getPayrollSummary': requireAdmin(session); return getPayrollSummary(params);
    case 'getPayslip': return getPayslip(params, session);
    case 'getMyPayslip': return getPayslip({ employeeId: session.employeeId, month: params.month }, session);
    case 'getPayslipPdf': return getPayslipPdf(params, session);
    case 'getRequests': return getRequests(session);
    case 'getDevices': requireAdmin(session); return getDevices();
    default: throw new Error('Unknown action: ' + action);
  }
}

function routePost(action, body, session) {
  switch (action) {
    case 'createRequest': return createRequest(body, session);
    case 'decideRequest': requireAdmin(session); return decideRequest(body, session);
    default: throw new Error('Unknown action: ' + action);
  }
}

/* ---------------- auth ---------------- */

function login(username, password) {
  if (!username || !password) throw new Error('Username and password are required.');
  const users = readSheet(SHEET_NAMES.USERS);
  const user = users.find(u => String(u.Username).toLowerCase() === String(username).toLowerCase());
  if (!user) throw new Error('Invalid username or password.');
  if (hashPassword(password) !== user.PasswordHash) throw new Error('Invalid username or password.');

  const role = String(user.Role).toLowerCase() === 'admin' ? 'admin' : 'employee';
  const userEmpId = employeeIdOf(user); // reads "EMP ID" (or EmployeeID/ID) generically
  let employee = null;
  if (userEmpId) {
    const emps = readSheet(SHEET_NAMES.EMPLOYEES);
    const rec = emps.find(x => employeeIdOf(x) === userEmpId);
    if (rec) { const n = normalizeEmployee(rec); employee = { id: n.employeeId, name: n.name, department: n.department }; }
  }
  if (!employee) employee = { id: userEmpId || '', name: user.Username, department: '' };

  const token = makeToken({ username: user.Username, role, employeeId: employee.id, exp: Date.now() + TOKEN_TTL_MS });
  return { token, role, employee: { id: employee.id, username: user.Username, name: employee.name, department: employee.department } };
}

function hashPassword(password) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password, Utilities.Charset.UTF_8);
  return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function makeToken(payload) {
  const secret = getSecret('TOKEN_SECRET');
  const json = JSON.stringify(payload);
  const b64 = Utilities.base64EncodeWebSafe(json);
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(b64, secret));
  return b64 + '.' + sig;
}

function requireSession(token) {
  if (!token) throw new Error('Not signed in.');
  const [b64, sig] = String(token).split('.');
  if (!b64 || !sig) throw new Error('Invalid session.');
  const secret = getSecret('TOKEN_SECRET');
  const expected = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(b64, secret));
  if (expected !== sig) throw new Error('Invalid session.');
  const payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(b64)).getDataAsString());
  if (Date.now() > payload.exp) throw new Error('Session expired. Please sign in again.');
  return payload; // { username, role, employeeId, exp }
}

function requireAdmin(session) {
  if (session.role !== 'admin') throw new Error('Admin access required.');
}

function getSecret(name) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (!v) throw new Error('Missing script property: ' + name);
  return v;
}

/* ---------------- sheet helpers ---------------- */

function readSheet(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== null))
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
}

function appendRow(name, rowObj) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Sheet not found: ' + name);
  const headers = sheet.getDataRange().getValues()[0];
  sheet.appendRow(headers.map(h => rowObj[h] !== undefined ? rowObj[h] : ''));
}

function updateRowWhere(name, matchFn, updates) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  for (let r = 1; r < data.length; r++) {
    const rowObj = {}; headers.forEach((h, i) => rowObj[h] = data[r][i]);
    if (matchFn(rowObj)) {
      Object.keys(updates).forEach(key => {
        const col = headers.indexOf(key);
        if (col > -1) sheet.getRange(r + 1, col + 1).setValue(updates[key]);
      });
      return true;
    }
  }
  return false;
}

function fmtDate(d) {
  if (d instanceof Date) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(d);
}
function fmtTime(d) {
  if (!d) return '';
  if (d instanceof Date) return Utilities.formatDate(d, Session.getScriptTimeZone(), 'hh:mm a');
  return String(d);
}
function monthOf(dateStr) { return String(dateStr).slice(0, 7); }

/* ---------------- attendance ---------------- */

function computeHoursAndStatus(punchIn, punchOut) {
  if (!punchIn) return { hours: 0, overtime: 0, status: 'Absent' };
  if (!punchOut) return { hours: 0, overtime: 0, status: 'Present' };
  const inD = new Date(punchIn), outD = new Date(punchOut);
  const hours = Math.max(0, (outD - inD) / 3600000);
  const overtime = Math.max(0, +(hours - 8).toFixed(2));
  // Grace period: arriving after 5:15 PM counts as Late (shift starts 5:00 PM).
  const scheduledStart = new Date(inD); scheduledStart.setHours(SHIFT_START_HOUR, 15, 0, 0);
  const status = hours < 4 ? 'Half-Day' : (inD > scheduledStart ? 'Late' : 'Present');
  return { hours: +hours.toFixed(2), overtime, status };
}

function attendanceRowsFor(filterFn) {
  const emps = readSheet(SHEET_NAMES.EMPLOYEES).map(normalizeEmployee);
  const empById = {}; emps.forEach(e => empById[e.employeeId] = e);
  return readSheet(SHEET_NAMES.ATTENDANCE)
    .filter(filterFn)
    .map(r => {
      const empId = r['EMP ID'];
      const emp = empById[String(empId)] || {};
      const { hours, overtime, status } = computeHoursAndStatus(r['Punch In'], r['Punch Out']);
      return {
        date: fmtDate(r.Date), employeeId: empId, name: r['Employee Name'] || emp.name || '',
        department: emp.department || '', punchIn: fmtTime(r['Punch In']), punchOut: fmtTime(r['Punch Out']),
        hours, overtime, status
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function getMyTodayAttendance(session) {
  const today = currentShiftDate();
  const rows = attendanceRowsFor(r => String(r['EMP ID']) === String(session.employeeId) && fmtDate(r.Date) === today);
  const row = rows[0];
  return row ? { punchIn: row.punchIn, punchOut: row.punchOut, hours: row.hours } : { punchIn: null, punchOut: null, hours: 0 };
}

function getMyAttendance(params, session) {
  const from = params.from, to = params.to;
  const date = params.date || ((!from && !to) ? currentShiftDate() : null);
  const rows = attendanceRowsFor(r => {
    if (String(r['EMP ID']) !== String(session.employeeId)) return false;
    const d = fmtDate(r.Date);
    if (date) return d === date;
    if (from && to) return d >= from && d <= to;
    return true;
  });
  return { rows };
}

function getAttendance(params) {
  const date = params.date || ((!params.from && !params.to) ? currentShiftDate() : null);
  const rows = attendanceRowsFor(r => {
    const d = fmtDate(r.Date);
    if (date && d !== date) return false;
    if (params.from && d < params.from) return false;
    if (params.to && d > params.to) return false;
    if (params.employeeId && String(r['EMP ID']) !== String(params.employeeId)) return false;
    if (params.employee) {
      const q = params.employee.toLowerCase();
      if (!(String(r['EMP ID']).toLowerCase().includes(q) || String(r['Employee Name']).toLowerCase().includes(q))) return false;
    }
    return true;
  });
  const filtered = params.department
    ? rows.filter(r => (r.department || '').toLowerCase() === params.department.toLowerCase())
    : rows;
  const statusFiltered = params.status ? filtered.filter(r => r.status === params.status) : filtered;
  return { rows: statusFiltered };
}

function getWhoIsOff(params) {
  const date = params.date || currentShiftDate();
  const rows = getAttendance({ date }).rows;
  const employees = rows.filter(r => r.status === 'Leave').map(r => ({ name: r.name, department: r.department }));
  return { employees };
}

function getDashboardKpis(params, session) {
  const today = params.date || currentShiftDate();
  if (session.role === 'admin') {
    const emps = readSheet(SHEET_NAMES.EMPLOYEES);
    const rows = getAttendance({ date: today }).rows;
    const count = s => rows.filter(r => r.status === s).length;
    return {
      kpis: {
        totalEmployees: emps.length, present: count('Present') + count('Late'),
        absent: count('Absent'), late: count('Late'), earlyLeave: 0, onLeave: count('Leave')
      }
    };
  }
  const ym = today.slice(0, 7);
  const monthRows = attendanceRowsFor(r => String(r['EMP ID']) === String(session.employeeId) && monthOf(fmtDate(r.Date)) === ym);
  const present = monthRows.filter(r => r.status === 'Present').length;
  const absent = monthRows.filter(r => r.status === 'Absent').length;
  const late = monthRows.filter(r => r.status === 'Late').length;
  const otHours = monthRows.reduce((s, r) => s + (r.overtime || 0), 0);
  const rate = monthRows.length ? Math.round(((present + late) / monthRows.length) * 100) + '%' : '—';
  return { kpis: { presentMonth: present, absentMonth: absent, lateMonth: late, otHoursMonth: +otHours.toFixed(1), attendanceRate: rate } };
}

/* ---------------- employees ---------------- */

function getEmployees() {
  return { employees: readSheet(SHEET_NAMES.EMPLOYEES).map(normalizeEmployee) };
}

function getEmployeeProfile(employeeId) {
  const emps = readSheet(SHEET_NAMES.EMPLOYEES);
  const raw = emps.find(x => employeeIdOf(x) === String(employeeId));
  if (!raw) throw new Error('Employee not found.');
  const e = normalizeEmployee(raw);
  const ym = fmtDate(new Date()).slice(0, 7);
  const monthRows = attendanceRowsFor(r => String(r['EMP ID']) === String(employeeId) && monthOf(fmtDate(r.Date)) === ym);
  const present = monthRows.filter(r => r.status === 'Present').length;
  const absent = monthRows.filter(r => r.status === 'Absent').length;
  const late = monthRows.filter(r => r.status === 'Late').length;
  const otHours = monthRows.reduce((s, r) => s + (r.overtime || 0), 0);
  const rate = monthRows.length ? Math.round(((present + late) / monthRows.length) * 100) + '%' : '—';
  return {
    employee: {
      ...e,
      presentMonth: present, absentMonth: absent, lateMonth: late, otHoursMonth: +otHours.toFixed(1), attendanceRate: rate
    }
  };
}

/* ---------------- payroll ---------------- */

function payslipFor(employeeId, month) {
  const emps = readSheet(SHEET_NAMES.EMPLOYEES);
  const raw = emps.find(x => employeeIdOf(x) === String(employeeId));
  if (!raw) throw new Error('Employee not found.');
  const e = normalizeEmployee(raw);
  const payroll = readSheet(SHEET_NAMES.PAYROLL);
  const p = payroll.find(x => String(x['EMP ID']) === String(employeeId) && monthOf(x.Month) === month);
  if (!p) throw new Error('No payroll record for ' + month + '.');

  const monthRows = attendanceRowsFor(r => String(r['EMP ID']) === String(employeeId) && monthOf(fmtDate(r.Date)) === month);
  const present = monthRows.filter(r => r.status === 'Present' || r.status === 'Late').length;
  const absent = monthRows.filter(r => r.status === 'Absent').length;

  // Basic falls back to the Employee sheet's Salary column when the
  // Payroll sheet doesn't set its own Basic Salary for this month.
  const fallbackBasic = Number(attrValue(e, 'Salary', 'Basic Salary')) || 0;
  const basic = Number(p['Basic Salary']) || fallbackBasic;
  const allowances = Number(p.Allowances) || 0;
  const otHours = Number(p['Overtime Hours']) || 0;
  const otRate = Number(p['Overtime Rate']) || 0;
  // Overtime Amount / Gross Salary / Net Salary are read straight from the
  // sheet when present; otherwise computed from the other columns.
  const overtimePay = Number(p['Overtime Amount']) || +(otHours * otRate).toFixed(2);
  const deductions = Number(p.Deductions) || 0;
  const gross = Number(p['Gross Salary']) || +(basic + allowances + overtimePay).toFixed(2);
  const netPay = Number(p['Net Salary']) || +(gross - deductions).toFixed(2);

  return {
    employeeId: e.employeeId, name: p['Employee Name'] || e.name, department: e.department,
    designation: attrValue(e, 'Designation') || '',
    present, absent, basic, allowances, overtimeHours: otHours, overtimePay, deductions, gross, netPay,
    status: p.Status || 'Draft'
  };
}

function getPayslip(params, session) {
  if (session.role !== 'admin' && String(session.employeeId) !== String(params.employeeId)) {
    throw new Error('You can only view your own payslip.');
  }
  return { payslip: payslipFor(params.employeeId, params.month) };
}

function getPayrollSummary(params) {
  const month = params.month;
  const emps = readSheet(SHEET_NAMES.EMPLOYEES);
  const payroll = readSheet(SHEET_NAMES.PAYROLL).filter(p => monthOf(p.Month) === month);
  let rows = payroll.map(p => {
    try { return payslipFor(p['EMP ID'], month); } catch (e) { return null; }
  }).filter(Boolean);

  if (params.department) rows = rows.filter(r => (r.department || '').toLowerCase() === params.department.toLowerCase());
  if (params.search) {
    const q = params.search.toLowerCase();
    rows = rows.filter(r => r.name.toLowerCase().includes(q) || String(r.employeeId).toLowerCase().includes(q));
  }

  const kpis = {
    totalEmployees: emps.length,
    present: rows.reduce((s, r) => s + r.present, 0),
    absent: rows.reduce((s, r) => s + r.absent, 0),
    late: 0, earlyLeave: 0, onLeave: 0
  };
  return { rows, kpis };
}

function getPayslipPdf(params, session) {
  if (session.role !== 'admin' && String(session.employeeId) !== String(params.employeeId)) {
    throw new Error('You can only download your own payslip.');
  }
  const p = payslipFor(params.employeeId, params.month);
  const html = payslipHtml(p, params.month);
  const pdfBlob = Utilities.newBlob(html, 'text/html', 'payslip.html').getAs('application/pdf');
  const base64 = Utilities.base64Encode(pdfBlob.getBytes());
  return { pdfBase64: base64 };
}

// Base64-embedded logo so it renders inside the generated PDF (no external file access from Apps Script)
const PAYSLIP_LOGO_B64 = "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";

function payslipHtml(p, month) {
  const money = n => 'Rs ' + Number(n || 0).toLocaleString();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:Arial,sans-serif;color:#1F2328;padding:24px;}
    h1{font-size:18px;margin:0 0 2px;} .sub{color:#7A8195;font-size:12px;margin-bottom:20px;}
    table{width:100%;border-collapse:collapse;margin-top:10px;} td,th{padding:6px 8px;border-bottom:1px solid #E7E9F0;text-align:left;font-size:12px;}
    .net{font-size:16px;font-weight:bold;margin-top:16px;} .hdr{background:#1E2A38;color:#fff;padding:14px 18px;border-radius:6px 6px 0 0;}
    </style></head><body>
    <div class="hdr"><img src="data:image/png;base64,${PAYSLIP_LOGO_B64}" style="height:26px;margin-bottom:8px;"><div class="sub" style="color:#C7CDD6;">Payslip · ${month}</div></div>
    <p><strong>${p.name}</strong> (${p.employeeId})<br>${p.department || ''} · ${p.designation || ''}</p>
    <table>
      <tr><th>Earnings</th><th>Amount</th></tr>
      <tr><td>Basic salary</td><td>${money(p.basic)}</td></tr>
      <tr><td>Allowances</td><td>${money(p.allowances)}</td></tr>
      <tr><td>Overtime (${p.overtimeHours} hrs)</td><td>${money(p.overtimePay)}</td></tr>
      <tr><td><strong>Gross</strong></td><td><strong>${money(p.gross)}</strong></td></tr>
    </table>
    <table>
      <tr><th>Deductions</th><th>Amount</th></tr>
      <tr><td>Absences / late</td><td>${money(p.deductions)}</td></tr>
    </table>
    <p>Present days: ${p.present} · Absent days: ${p.absent}</p>
    <div class="net">Net pay: ${money(p.netPay)}</div>
  </body></html>`;
}

/* ---------------- requests ---------------- */

function getRequests(session) {
  const all = readSheet(SHEET_NAMES.REQUESTS);
  const scoped = session.role === 'admin' ? all : all.filter(r => String(r['EMP ID']) === String(session.employeeId));
  return {
    requests: scoped.map(r => ({
      id: r.ID, employeeId: r['EMP ID'], employeeName: r['Employee Name'],
      leaveFrom: fmtDate(r['Leave From']), leaveTo: fmtDate(r['Leave To']),
      type: r['Leave Type'], reason: r.Reason, status: r.Status, approvedBy: r['Approved By'] || ''
    })).sort((a, b) => b.leaveFrom.localeCompare(a.leaveFrom))
  };
}

function createRequest(body, session) {
  const emps = readSheet(SHEET_NAMES.EMPLOYEES);
  const raw = emps.find(x => employeeIdOf(x) === String(session.employeeId));
  const name = raw ? normalizeEmployee(raw).name : session.username;
  appendRow(SHEET_NAMES.REQUESTS, {
    'ID': Utilities.getUuid(), 'EMP ID': session.employeeId, 'Employee Name': name,
    'Leave From': body.leaveFrom, 'Leave To': body.leaveTo || body.leaveFrom,
    'Leave Type': body.type, 'Reason': body.reason || '', 'Status': 'Pending', 'Approved By': ''
  });
  return { ok: true };
}

function decideRequest(body, session) {
  const ok = updateRowWhere(SHEET_NAMES.REQUESTS, r => String(r.ID) === String(body.id), {
    'Status': body.decision, 'Approved By': session.username || ''
  });
  if (!ok) throw new Error('Request not found.');
  return { ok: true };
}

/* ---------------- devices ---------------- */

function getDevices() {
  const devices = readSheet(SHEET_NAMES.DEVICES).map(d => ({
    name: d['Device Name'], location: d.Location, ipAddress: d['IP Address'],
    lastSync: d['Last Sync'] ? (fmtTime(d['Last Sync']) + ' ' + fmtDate(d['Last Sync'])) : '',
    online: String(d.Online).toLowerCase() === 'true' || d.Online === true
  }));
  return { devices };
}

/* ---------------- ZKTeco bridge ingestion ---------------- */
/**
 * Called by the on-premise ZKTeco bridge (see zkteco_bridge.py) whenever a
 * raw scan is read off one of the two biometric machines. Authenticated
 * with a shared BRIDGE_SECRET, not a user session token, since the bridge
 * runs unattended and has no user to log in as.
 *
 * The bridge knows which physical machine each scan came from (Punch In
 * terminal vs Punch Out terminal — two different IPs) and sends that
 * directly as punchType, so this function trusts it rather than guessing
 * from the time of day. It works out:
 *   1. Which shift date (the day the shift started) the scan belongs to
 *      — shiftDateFor() files an early-morning OUT scan under the
 *      previous day, so one overnight shift stays on one row.
 *   2. Whether that slot is already filled for this employee's shift —
 *      if so, it's a duplicate scan (e.g. a double tap) and is ignored
 *      rather than overwriting the original.
 * It also writes the computed Working Hours / Status back into the
 * Attendance sheet so anyone opening the raw sheet sees them too.
 *
 * Expected body:
 *   { action:'pushAttendance', secret, employeeId, employeeName,
 *     punchType: 'in'|'out', timestamp: ISO string }
 */
function pushAttendance(body) {
  if (body.secret !== getSecret('BRIDGE_SECRET')) throw new Error('Invalid bridge secret.');
  if (!body.employeeId || !body.timestamp || !body.punchType) throw new Error('Missing punch fields.');

  const type = body.punchType === 'out' ? 'out' : 'in';
  const ts = new Date(body.timestamp);
  const shiftDate = shiftDateFor(ts, type);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES.ATTENDANCE);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const colDate = headers.indexOf('Date'), colEmp = headers.indexOf('EMP ID');
  const colIn = headers.indexOf('Punch In'), colOut = headers.indexOf('Punch Out');
  const colHours = headers.indexOf('Working Hours'), colStatus = headers.indexOf('Status');
  const targetCol = type === 'out' ? colOut : colIn;

  for (let r = 1; r < data.length; r++) {
    if (fmtDate(data[r][colDate]) === shiftDate && String(data[r][colEmp]) === String(body.employeeId)) {
      if (data[r][targetCol]) {
        // This slot is already filled for this shift — repeat scan, ignore it.
        return { ok: true, ignored: true, reason: 'Duplicate ' + type + ' punch ignored.' };
      }
      sheet.getRange(r + 1, targetCol + 1).setValue(ts);
      const punchIn = type === 'in' ? ts : data[r][colIn];
      const punchOut = type === 'out' ? ts : data[r][colOut];
      writeComputedAttendance(sheet, r + 1, colHours, colStatus, punchIn, punchOut);
      return { ok: true, updated: true, type: type, shiftDate: shiftDate };
    }
  }
  // No row yet for this employee's shift — create one.
  const row = headers.map(h => {
    if (h === 'Date') return shiftDate;
    if (h === 'EMP ID') return body.employeeId;
    if (h === 'Employee Name') return body.employeeName || '';
    if (h === 'Punch In') return type === 'in' ? ts : '';
    if (h === 'Punch Out') return type === 'out' ? ts : '';
    if (h === 'Working Hours') return '';
    if (h === 'Status') return type === 'in' ? 'Present' : '';
    return '';
  });
  sheet.appendRow(row);
  const newRowIndex = sheet.getLastRow();
  const punchIn = type === 'in' ? ts : '';
  const punchOut = type === 'out' ? ts : '';
  writeComputedAttendance(sheet, newRowIndex, colHours, colStatus, punchIn, punchOut);
  return { ok: true, created: true, type: type, shiftDate: shiftDate };
}

function writeComputedAttendance(sheet, rowIndex, colHours, colStatus, punchIn, punchOut) {
  const { hours, status } = computeHoursAndStatus(punchIn, punchOut);
  if (colHours > -1) sheet.getRange(rowIndex, colHours + 1).setValue(hours);
  if (colStatus > -1) sheet.getRange(rowIndex, colStatus + 1).setValue(status);
}
