# Simply Connect — Attendance Console — Setup Guide

## Files
| File | Purpose |
|---|---|
| `index.html` | Page structure only. No data, no logic. |
| `styles.css` | All styling (same visual design as the original, plus role-visibility rules). |
| `app.js` | Frontend logic: login, role-based nav, API calls, rendering, PDF download. |
| `Code.gs` | Google Apps Script backend — deploy this inside your Google Sheet. |
| `zkteco_bridge.py` | Runs on a PC near the biometric machine; pushes punches into Sheets. |

Put `index.html`, `styles.css`, `app.js` in the same folder on any static host
(GitHub Pages, Netlify, your own server, etc.). Add a `logo.png` next to them.

## 1. Google Sheet tabs
These match your `Employees_Data.xlsx` exactly — same tab names, same
headers (case-sensitive, including spaces). Import that workbook straight
into your Google Sheet (or copy each tab in) and the backend will read it
as-is.

**Employee** *(singular tab name)*
`EMP ID | Name | Designation | Department | Team | D.O.J | Timings | Salary`
- Only **EMP ID** (or `EmployeeID`/`ID`) and **Name** are relied on by name —
  everything else is read generically and shown as-is on the employee
  profile page. Add, rename, or reorder columns anytime and they appear
  automatically with no code changes.
- `Salary` is used as the payslip's Basic Salary automatically whenever a
  given month's row in **Payroll** doesn't set its own `Basic Salary`.

**Attendance** *(written automatically by the ZKTeco bridge)*
`Date | EMP ID | Employee Name | Punch In | Punch Out | Working Hours | Status`
- `Date` is the **shift date** (see shift window below), not necessarily
  the calendar date of every scan.
- `Working Hours` and `Status` are computed and written by the backend
  whenever a punch comes in — but the app always recomputes them fresh on
  read too, so they stay correct even if you edit this sheet by hand.

**Payroll**
`EMP ID | Employee Name | Month(YYYY-MM) | Basic Salary | Allowances | Overtime Hours | Overtime Rate | Overtime Amount | Gross Salary | Deductions | Net Salary | Status`
- One row per employee per month.
- `Overtime Amount`, `Gross Salary`, and `Net Salary` are read straight
  from the sheet when filled in; leave any of them blank and the app
  computes it from the other columns instead.

**Users**
`Username | PasswordHash | Role | EMP ID`
- `Role` is `Admin` or `Employee`.
- `PasswordHash` is a SHA-256 hex digest of the plaintext password —
  generate one by temporarily running `hashPassword("thePassword")` in
  the Apps Script editor's console, or use any SHA-256 tool.

**Requests**
`ID | EMP ID | Employee Name | Leave From | Leave To | Leave Type | Reason | Status | Approved By`

**Devices**
`Device Name | Location | IP Address | Last Sync | Online`

## 2. Deploy the Apps Script backend
1. In the Sheet: **Extensions > Apps Script**.
2. Delete the default `Code.gs` content and paste in this project's `Code.gs`.
3. **Project Settings > Script properties**, add:
   - `TOKEN_SECRET` — any long random string (signs login sessions).
   - `BRIDGE_SECRET` — a separate random string (authenticates the ZKTeco bridge).
4. **Deploy > New deployment > Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the `/exec` URL it gives you.

## 3. Wire up the frontend
In `app.js`, set:
```js
API_URL: 'https://script.google.com/macros/s/.../exec'
```

## 4. Connect the two ZKTeco machines
Your office has **two separate terminals** — one dedicated to Punch In,
one dedicated to Punch Out — each with its own IP address. Neither can
talk to Google Sheets on its own; `zkteco_bridge.py` bridges that gap:
it polls both machines, tags every scan with `punchType: 'in'` or
`'out'` based on **which machine it came from** (not the time of day —
the machine itself tells us what the scan means, which is more
reliable), and posts each one to the Apps Script URL (with
`BRIDGE_SECRET`), which writes it into the **Attendance** sheet. The
website then reads that sheet, so attendance shows up live without
anyone typing it in.

1. `pip install pyzk requests`
2. In `zkteco_bridge.py`, fill in:
   - `DEVICE_IN_IP` — the Punch In terminal's IP
   - `DEVICE_OUT_IP` — the Punch Out terminal's IP
   - `APPS_SCRIPT_URL`, `BRIDGE_SECRET`
   - `DEVICE_USER_MAP` — device numeric user ID → EMP ID/Name. Enroll
     each employee with the **same numeric user ID on both machines**
     so one mapping covers both.
3. Run it as a scheduled task / service on a PC that can reach both
   terminals, e.g. every 1–2 minutes. Each poll checks both machines.
4. In the **Devices** sheet, add one row per terminal, e.g.:
   `Punch In Terminal | Main Gate | 192.168.1.201 | ... | TRUE`
   `Punch Out Terminal | Main Gate | 192.168.1.202 | ... | TRUE`

## Shift window (5:00 PM – 7:30 AM) and duplicate scans
The office shift is overnight, so a single shift's punch-in and punch-out
land on different calendar dates. `Code.gs`'s `shiftDateFor()` handles
this — since punch type now comes straight from the bridge (which
machine sent it), this only has to work out the **date**:
- An **IN** scan is filed under that calendar day.
- An **OUT** scan before 7:30 AM is filed under the *previous* day (the
  day the shift started) — so one overnight shift stays on one
  Attendance row instead of splitting across two dates. An OUT scan
  later than 7:30 AM (a rare long/late shift) stays on the same day.
- **Duplicate scans** — if a slot (in or out) is already filled for that
  employee's shift, a repeat scan for the same slot (e.g. a double tap)
  is ignored rather than overwriting the original.
- "Today" on the dashboards (`currentShiftDate()`) accounts for this too:
  if it's currently 2 AM, "today" still means the shift that started
  yesterday evening, not a fresh empty day.
- `SHIFT_START_HOUR` (5 PM) is also used for the "Late" arrival
  threshold in `computeHoursAndStatus()`. If your actual shift times
  ever change, update `SHIFT_START_HOUR`, `SHIFT_END_HOUR`, and
  `SHIFT_END_MINUTE` at the top of `Code.gs`.

## How roles work
- `Users.Role` determines what a person can do — not anything in the
  frontend, since the frontend only hides buttons for UX. The backend
  (`Code.gs`) independently enforces admin-only actions via
  `requireAdmin(session)`, and scopes employee data access to their own
  `EMP ID` (e.g. `getPayslip` refuses to return anyone else's payslip to
  a non-admin). Treat the sheet as the source of truth for permissions.
- Employees see: Home, their own Attendance, their own Payroll (with PDF
  download), Requests (submit/view their own), Settings.
- Admins see everything, plus Employees, Reports, and Devices.

## Adding a new Employee column later
Just add the column to the **Employee** sheet. `getEmployees` /
`getEmployeeProfile` in `Code.gs` and the profile page in `app.js` don't
hardcode a field list — they read whatever headers exist, so a new column
appears on the employee profile page immediately. The only fields the
system looks for by name are the ID column and `Name` (for linking to
Attendance/Payroll/Requests) and, optionally, `Salary` (payslip Basic
fallback), `Designation`, `Department`, `Status`/`Employment Status`, and
`D.O.J`/`Joining Date` (used for the profile page's tags — safe to omit,
they just won't render).

## Notes / things to harden before production
- Password hashing here is plain SHA-256 for simplicity — fine to start,
  but consider adding a per-user salt if this will hold real payroll data.
- Session tokens are signed but not revocable server-side; for a stricter
  setup, store active tokens in a sheet/PropertiesService and check
  against it.
- Reports page is a stub — wire it to real sheets/queries as your needs grow.
