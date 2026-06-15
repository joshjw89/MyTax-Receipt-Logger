// MyTax Receipt Logger — React frontend (prototype)
const { useState, useEffect, useRef } = React;

// LHDN MyTax tax relief categories (Year of Assessment limits, RM)
const CATEGORIES = [
  { name: 'Medical expenses (self, spouse, child)', limit: 10000 },
  { name: 'Lifestyle (books, internet, gadgets)', limit: 2500 },
  { name: 'Sports equipment & activities', limit: 1000 },
  { name: 'Education fees (self)', limit: 7000 },
  { name: 'SSPN net savings', limit: 8000 },
  { name: 'Childcare fees (TASKA / TADIKA)', limit: 3000 },
  { name: 'Life insurance & EPF', limit: 7000 },
  { name: 'Medical & education insurance', limit: 3000 },
  { name: 'EV charging facilities', limit: 2500 },
  { name: 'Other / Uncategorised', limit: null },
];

const RM = (n) => 'RM ' + Number(n || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- Browser storage layer (replaces the Express + SQLite backend) ----------
// In the full prototype these operations are HTTP calls to a Node.js server.
// In this UI-only build, the same "routes" are answered from the browser's
// localStorage so the app can run as a static site on GitHub Pages.
// NOTE: passwords here use simple encoding for demo purposes only — the full
// prototype uses proper bcrypt hashing on the server.
const dbGet = (key, fallback) => JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
const dbSet = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const nowStamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// Build version: YYYY.MMDD.HHMMSS — generated once at load time
const BUILD_VERSION = (() => {
  const d = new Date();
  const YYYY   = d.getFullYear();
  const MM     = String(d.getMonth() + 1).padStart(2, '0');
  const DD     = String(d.getDate()).padStart(2, '0');
  const HH     = String(d.getHours()).padStart(2, '0');
  const mm     = String(d.getMinutes()).padStart(2, '0');
  const SS     = String(d.getSeconds()).padStart(2, '0');
  return `${YYYY}.${MM}${DD}.${HH}${mm}${SS}`;
})();
const makeToken = (u) => btoa(unescape(encodeURIComponent(JSON.stringify(u))));
const readToken = (t) => JSON.parse(decodeURIComponent(escape(atob(t))));

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}

// Downscale images before saving so browser storage (~5 MB) holds plenty of receipts
function compressImage(file) {
  return new Promise((resolve) => {
    if (!file.type || !file.type.startsWith('image/')) { readFileAsDataUrl(file).then(resolve); return; }
    const img = new Image();
    img.onload = () => {
      const maxW = 1200;
      const scale = Math.min(1, maxW / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => readFileAsDataUrl(file).then(resolve);
    img.src = URL.createObjectURL(file);
  });
}

async function api(path, { method = 'GET', body, token, isForm } = {}) {
  const [route, qs] = path.split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  let users = dbGet('mytax-users', []);
  let receipts = dbGet('mytax-receipts', []);
  const me = token ? readToken(token) : null;
  const need = () => { if (!me) throw new Error('Please log in first'); };

  // --- Auth ---
  if (route === '/api/register' && method === 'POST') {
    const { name, email, password } = body || {};
    if (!name || !email || !password) throw new Error('Name, email and password are required');
    if (password.length < 6) throw new Error('Password must be at least 6 characters');
    if (users.some((u) => u.email === email.toLowerCase())) throw new Error('An account with this email already exists');
    const user = { id: users.length ? Math.max(...users.map((u) => u.id)) + 1 : 1, name: name.trim(), email: email.toLowerCase(), password_hash: btoa(password) };
    users.push(user); dbSet('mytax-users', users);
    const pub = { id: user.id, name: user.name, email: user.email };
    return { token: makeToken(pub), user: pub };
  }
  if (route === '/api/login' && method === 'POST') {
    const { email, password } = body || {};
    const user = users.find((u) => u.email === (email || '').toLowerCase() && u.password_hash === btoa(password || ''));
    if (!user) throw new Error('Incorrect email or password');
    const pub = { id: user.id, name: user.name, email: user.email };
    return { token: makeToken(pub), user: pub };
  }

  // --- Receipts ---
  if (route === '/api/receipts' && method === 'POST') {
    need();
    const file = body.get('file');
    if (!file || !file.name) throw new Error('A receipt file is required');
    const fields = Object.fromEntries(body.entries());
    if (!fields.merchant || !fields.receipt_date || !fields.amount || !fields.category) throw new Error('Merchant, date, amount and category are required');
    const dataUrl = await compressImage(file);
    const id = receipts.length ? Math.max(...receipts.map((r) => r.id)) + 1 : 1;
    receipts.push({ id, user_id: me.id, merchant: fields.merchant.trim(), receipt_date: fields.receipt_date,
      amount: parseFloat(fields.amount), category: fields.category, notes: (fields.notes || '').trim(),
      original_name: file.name, tier: 'hot', ocr_used: fields.ocr_used === 'true' ? 1 : 0,
      uploaded_at: nowStamp(), dataUrl });
    try { dbSet('mytax-receipts', receipts); }
    catch { throw new Error('Browser storage is full — delete some receipts and try again'); }
    return { id, message: 'Receipt saved to Hot tier' };
  }
  if (route === '/api/receipts' && method === 'GET') {
    need();
    let rows = receipts.filter((r) => r.user_id === me.id);
    if (q.search) rows = rows.filter((r) => (r.merchant + ' ' + (r.notes || '')).toLowerCase().includes(q.search.toLowerCase()));
    if (q.category) rows = rows.filter((r) => r.category === q.category);
    if (q.from) rows = rows.filter((r) => r.receipt_date >= q.from);
    if (q.to) rows = rows.filter((r) => r.receipt_date <= q.to);
    return rows
      .sort((a, b) => b.receipt_date.localeCompare(a.receipt_date) || b.id - a.id)
      .map(({ dataUrl, ...rest }) => rest);
  }
  const fileMatch = route.match(/^\/api\/receipts\/(\d+)\/file$/);
  if (fileMatch && method === 'GET') {
    need();
    const r = receipts.find((x) => x.id === Number(fileMatch[1]) && x.user_id === me.id);
    if (!r) throw new Error('Receipt not found');
    return { dataUrl: r.dataUrl, name: r.original_name };
  }
  const idMatch = route.match(/^\/api\/receipts\/(\d+)$/);
  if (idMatch && method === 'PUT') {
    need();
    const r = receipts.find((x) => x.id === Number(idMatch[1]) && x.user_id === me.id);
    if (!r) throw new Error('Receipt not found');
    ['merchant', 'receipt_date', 'category', 'notes'].forEach((k) => { if (body[k] != null) r[k] = body[k]; });
    if (body.amount != null) r.amount = parseFloat(body.amount);
    dbSet('mytax-receipts', receipts);
    return { message: 'Receipt updated' };
  }
  if (idMatch && method === 'DELETE') {
    need();
    receipts = receipts.filter((x) => !(x.id === Number(idMatch[1]) && x.user_id === me.id));
    dbSet('mytax-receipts', receipts);
    return { message: 'Receipt deleted' };
  }

  // --- Lifecycle policy (simulates Azure Blob Lifecycle Management) ---
  if (route === '/api/lifecycle/run' && method === 'POST') {
    need();
    const days = Math.max(0, parseInt((body && body.days != null ? body.days : 30), 10));
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
    let moved = 0;
    receipts.forEach((r) => { if (r.user_id === me.id && r.tier === 'hot' && r.uploaded_at <= cutoff) { r.tier = 'cold'; moved++; } });
    dbSet('mytax-receipts', receipts);
    return { moved, message: `Lifecycle policy complete — ${moved} receipt(s) moved from Hot to Cold tier` };
  }

  // --- Annual summary ---
  if (route === '/api/summary' && method === 'GET') {
    need();
    const year = q.year || new Date().getFullYear().toString();
    const mine = receipts.filter((r) => r.user_id === me.id);
    const catMap = {};
    mine.filter((r) => r.receipt_date.slice(0, 4) === year).forEach((r) => {
      catMap[r.category] = catMap[r.category] || { category: r.category, count: 0, total: 0 };
      catMap[r.category].count++; catMap[r.category].total += r.amount;
    });
    const tierMap = {};
    mine.forEach((r) => { tierMap[r.tier] = (tierMap[r.tier] || 0) + 1; });
    return { year, categories: Object.values(catMap).sort((a, b) => b.total - a.total),
             tiers: Object.entries(tierMap).map(([tier, count]) => ({ tier, count })) };
  }

  throw new Error('Unknown action: ' + method + ' ' + route);
}

// ---------- OCR text parsing heuristics ----------
function parseOcrText(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let merchant = '';
  for (const l of lines) {
    if (/[A-Za-z]{3,}/.test(l) && !/receipt|invoice|resit|tax/i.test(l)) { merchant = l; break; }
  }
  // Date: dd/mm/yyyy, dd-mm-yy, yyyy-mm-dd
  let date = '';
  const dm = text.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/) || text.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (dm) {
    if (dm[1].length === 4) date = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
    else date = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
  }
  // Amount: prefer lines containing TOTAL / JUMLAH, else largest decimal number
  let amount = '';
  const totalLine = lines.find((l) => /total|jumlah|amount due/i.test(l) && /\d/.test(l));
  const numFrom = (s) => { const m = s.match(/(\d{1,3}(?:[,\s]?\d{3})*\.\d{2})/g); return m ? m.map((x) => parseFloat(x.replace(/[,\s]/g, ''))) : []; };
  if (totalLine) { const nums = numFrom(totalLine); if (nums.length) amount = Math.max(...nums).toFixed(2); }
  if (!amount) { const all = numFrom(text); if (all.length) amount = Math.max(...all).toFixed(2); }
  return { merchant, date, amount };
}

// ---------- Shared small components ----------
function Field({ label, children }) {
  return (
    <label className="block mb-4">
      <span className="block text-sm font-medium text-slate-600 mb-1">{label}</span>
      {children}
    </label>
  );
}
const inputCls = 'w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#122B40] bg-white';

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={`fixed bottom-6 right-6 px-4 py-3 rounded-lg shadow-lg text-sm text-white z-50 ${toast.kind === 'error' ? 'bg-red-600' : 'bg-emerald-600'}`}>
      {toast.msg}
    </div>
  );
}

// ---------- Auth page ----------
function AuthPage({ onLogin, notify }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit() {
    setBusy(true);
    try {
      const data = await api(mode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body: form });
      onLogin(data);
    } catch (e) { notify(e.message, 'error'); }
    setBusy(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-ink text-white display text-2xl font-bold mb-3">M</div>
          <h1 className="text-3xl font-bold ink">MyTax Receipt Logger</h1>
          <p className="text-slate-500 mt-1 text-sm">Keep every tax relief receipt safe for 7 years — as LHDN requires.</p>
        </div>
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <div className="flex rounded-lg bg-slate-100 p-1 mb-6">
            {['login', 'register'].map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex-1 py-2 rounded-md text-sm font-medium capitalize ${mode === m ? 'bg-white shadow text-slate-900' : 'text-slate-500'}`}>
                {m === 'login' ? 'Log in' : 'Create account'}
              </button>
            ))}
          </div>
          {mode === 'register' && (
            <Field label="Full name"><input className={inputCls} value={form.name} onChange={set('name')} placeholder="e.g. Joshua Tan" /></Field>
          )}
          <Field label="Email"><input className={inputCls} type="email" value={form.email} onChange={set('email')} placeholder="you@email.com" /></Field>
          <Field label="Password"><input className={inputCls} type="password" value={form.password} onChange={set('password')} placeholder="At least 6 characters" onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>
          <button onClick={submit} disabled={busy}
            className="w-full bg-ink text-white rounded-lg py-2.5 font-medium hover:opacity-90 disabled:opacity-50 mt-2">
            {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </div>
        <p className="text-center text-xs text-slate-400 mt-6">UI prototype — your data is stored in this browser only.</p>
      </div>
    </div>
  );
}

// ---------- Dashboard ----------
function Dashboard({ token }) {
  const [summary, setSummary] = useState(null);
  const year = new Date().getFullYear().toString();
  useEffect(() => { api('/api/summary?year=' + year, { token }).then(setSummary).catch(() => {}); }, []);
  if (!summary) return <p className="text-slate-500">Loading…</p>;

  const byCat = Object.fromEntries(summary.categories.map((c) => [c.category, c]));
  const total = summary.categories.reduce((s, c) => s + c.total, 0);
  const count = summary.categories.reduce((s, c) => s + c.count, 0);
  const hot = (summary.tiers.find((t) => t.tier === 'hot') || {}).count || 0;
  const cold = (summary.tiers.find((t) => t.tier === 'cold') || {}).count || 0;

  return (
    <div>
      <h2 className="text-2xl font-bold ink mb-1">Dashboard</h2>
      <p className="text-slate-500 text-sm mb-6">Your claimable tax relief for Year of Assessment {year}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <div className="bg-ink text-white rounded-2xl p-6">
          <p className="text-sm opacity-70">Total claimable so far</p>
          <p className="display text-3xl font-bold mt-1" style={{ color: '#E8C766' }}>{RM(total)}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <p className="text-sm text-slate-500">Receipts logged ({year})</p>
          <p className="display text-3xl font-bold ink mt-1">{count}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <p className="text-sm text-slate-500">Storage tiers (all years)</p>
          <p className="display text-xl font-bold ink mt-2">
            <span className="text-orange-500">{hot} Hot</span>
            <span className="text-slate-300 mx-2">/</span>
            <span className="text-sky-600">{cold} Cold</span>
          </p>
        </div>
      </div>
      <h3 className="font-semibold ink mb-3">Relief category limits</h3>
      <div className="bg-white border border-slate-200 rounded-2xl divide-y divide-slate-100">
        {CATEGORIES.filter((c) => c.limit).map((c) => {
          const claimed = (byCat[c.name] || {}).total || 0;
          const pct = Math.min(100, (claimed / c.limit) * 100);
          return (
            <div key={c.name} className="px-5 py-4">
              <div className="flex justify-between text-sm mb-1.5">
                <span className="font-medium text-slate-700">{c.name}</span>
                <span className="text-slate-500">{RM(claimed)} <span className="text-slate-300">/</span> {RM(c.limit)}</span>
              </div>
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${pct >= 100 ? 'bg-emerald-500' : 'bg-[#122B40]'}`} style={{ width: pct + '%' }}></div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Upload page (Tesseract.js OCR) ----------
function UploadPage({ token, notify, goTo }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrDone, setOcrDone] = useState(false);
  const [form, setForm] = useState({ merchant: '', receipt_date: '', amount: '', category: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  function pickFile(f) {
    if (!f) return;
    setFile(f); setOcrDone(false);
    setPreview(f.type.startsWith('image/') ? URL.createObjectURL(f) : null);
  }

  async function runOcr() {
    if (!file || !file.type.startsWith('image/')) { notify('OCR works on JPEG/PNG images. For PDFs, fill the form manually.', 'error'); return; }
    setOcrBusy(true); setOcrProgress(0);
    try {
      const result = await Tesseract.recognize(file, 'eng', {
        logger: (m) => { if (m.status === 'recognizing text') setOcrProgress(Math.round(m.progress * 100)); }
      });
      const parsed = parseOcrText(result.data.text);
      setForm((f) => ({ ...f, merchant: parsed.merchant || f.merchant, receipt_date: parsed.date || f.receipt_date, amount: parsed.amount || f.amount }));
      setOcrDone(true);
      notify('OCR complete — please review the auto-filled fields');
    } catch (e) { notify('OCR failed: ' + e.message, 'error'); }
    setOcrBusy(false);
  }

  async function save() {
    if (!file) { notify('Please choose a receipt file first', 'error'); return; }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      fd.append('ocr_used', ocrDone ? 'true' : 'false');
      await api('/api/receipts', { method: 'POST', body: fd, token, isForm: true });
      notify('Receipt saved to Hot tier');
      goTo('receipts');
    } catch (e) { notify(e.message, 'error'); }
    setSaving(false);
  }

  return (
    <div>
      <h2 className="text-2xl font-bold ink mb-1">Upload a receipt</h2>
      <p className="text-slate-500 text-sm mb-6">Step 1: choose a file · Step 2: scan with OCR · Step 3: review and save</p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <input type="file" accept=".jpg,.jpeg,.png,.pdf" id="fileInput" className="hidden" onChange={(e) => pickFile(e.target.files[0])} />
          <label htmlFor="fileInput"
            className="block border-2 border-dashed border-slate-300 rounded-xl p-8 text-center cursor-pointer hover:border-[#122B40]">
            {preview ? <img src={preview} alt="Receipt preview" className="max-h-72 mx-auto rounded-lg" />
              : <div><p className="font-medium text-slate-600">{file ? file.name : 'Click to choose a receipt'}</p>
                  <p className="text-xs text-slate-400 mt-1">JPEG, PNG or PDF · up to 10 MB</p></div>}
          </label>
          <button onClick={runOcr} disabled={!file || ocrBusy}
            className="w-full mt-4 bg-ink text-white rounded-lg py-2.5 font-medium disabled:opacity-40">
            {ocrBusy ? `Scanning… ${ocrProgress}%` : 'Scan with OCR (Tesseract.js)'}
          </button>
          {ocrBusy && <div className="h-1.5 bg-slate-100 rounded-full mt-3 overflow-hidden">
            <div className="h-full bg-[#122B40] rounded-full transition-all" style={{ width: ocrProgress + '%' }}></div></div>}
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <Field label="Merchant"><input className={inputCls} value={form.merchant} onChange={set('merchant')} placeholder="e.g. Guardian Pharmacy" /></Field>
          <Field label="Receipt date"><input className={inputCls} type="date" value={form.receipt_date} onChange={set('receipt_date')} /></Field>
          <Field label="Amount (RM)"><input className={inputCls} type="number" step="0.01" min="0" value={form.amount} onChange={set('amount')} placeholder="0.00" /></Field>
          <Field label="LHDN relief category">
            <select className={inputCls} value={form.category} onChange={set('category')}>
              <option value="">Choose a category…</option>
              {CATEGORIES.map((c) => <option key={c.name} value={c.name}>{c.name}{c.limit ? ` (limit ${RM(c.limit)})` : ''}</option>)}
            </select>
          </Field>
          <Field label="Notes (optional)"><input className={inputCls} value={form.notes} onChange={set('notes')} placeholder="e.g. Annual medical check-up" /></Field>
          <button onClick={save} disabled={saving} className="w-full bg-emerald-600 text-white rounded-lg py-2.5 font-medium disabled:opacity-50">
            {saving ? 'Saving…' : 'Save receipt'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Receipts list ----------
function ReceiptsPage({ token, notify }) {
  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ search: '', category: '', from: '', to: '' });
  const [editing, setEditing] = useState(null);
  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });

  async function load() {
    const q = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
    setRows(await api('/api/receipts?' + q, { token }));
  }
  useEffect(() => { load().catch((e) => notify(e.message, 'error')); }, [filters]);

  async function del(id) {
    if (!confirm('Delete this receipt permanently?')) return;
    try { await api('/api/receipts/' + id, { method: 'DELETE', token }); notify('Receipt deleted'); load(); }
    catch (e) { notify(e.message, 'error'); }
  }
  async function view(id) {
    try {
      const { dataUrl, name } = await api(`/api/receipts/${id}/file`, { token });
      const w = window.open('', '_blank');
      const tag = dataUrl.startsWith('data:application/pdf')
        ? `<iframe src="${dataUrl}" style="width:100%;height:100vh;border:0"></iframe>`
        : `<img src="${dataUrl}" style="max-width:100%">`;
      w.document.write(`<title>${name}</title><body style="margin:0;background:#222;text-align:center">${tag}</body>`);
    } catch (e) { notify(e.message, 'error'); }
  }
  async function saveEdit() {
    try {
      await api('/api/receipts/' + editing.id, { method: 'PUT', token, body: editing });
      notify('Receipt updated'); setEditing(null); load();
    } catch (e) { notify(e.message, 'error'); }
  }

  return (
    <div>
      <h2 className="text-2xl font-bold ink mb-1">My receipts</h2>
      <p className="text-slate-500 text-sm mb-6">Search, filter, edit or open any stored receipt</p>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <input className={inputCls} placeholder="Search merchant or notes…" value={filters.search} onChange={set('search')} />
        <select className={inputCls} value={filters.category} onChange={set('category')}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        <input className={inputCls} type="date" value={filters.from} onChange={set('from')} title="From date" />
        <input className={inputCls} type="date" value={filters.to} onChange={set('to')} title="To date" />
      </div>
      <div className="bg-white border border-slate-200 rounded-2xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-slate-500 border-b border-slate-100">
            <th className="px-4 py-3 font-medium">Date</th><th className="px-4 py-3 font-medium">Merchant</th>
            <th className="px-4 py-3 font-medium">Category</th><th className="px-4 py-3 font-medium text-right">Amount</th>
            <th className="px-4 py-3 font-medium">Tier</th><th className="px-4 py-3 font-medium">OCR</th><th className="px-4 py-3"></th>
          </tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan="7" className="px-4 py-10 text-center text-slate-400">No receipts yet — upload your first one to get started.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50">
                <td className="px-4 py-3 whitespace-nowrap">{r.receipt_date}</td>
                <td className="px-4 py-3">{r.merchant}<div className="text-xs text-slate-400">{r.notes}</div></td>
                <td className="px-4 py-3 text-slate-600">{r.category}</td>
                <td className="px-4 py-3 text-right font-medium">{RM(r.amount)}</td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${r.tier === 'hot' ? 'bg-orange-100 text-orange-700' : 'bg-sky-100 text-sky-700'}`}>
                    {r.tier === 'hot' ? 'Hot' : 'Cold'}</span>
                </td>
                <td className="px-4 py-3 text-xs text-slate-400">{r.ocr_used ? 'Auto' : 'Manual'}</td>
                <td className="px-4 py-3 whitespace-nowrap text-right">
                  <button onClick={() => view(r.id)} className="text-slate-500 hover:text-slate-900 mr-3">Open</button>
                  <button onClick={() => setEditing({ ...r })} className="text-slate-500 hover:text-slate-900 mr-3">Edit</button>
                  <button onClick={() => del(r.id)} className="text-red-400 hover:text-red-600">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md">
            <h3 className="font-bold ink text-lg mb-4">Edit receipt</h3>
            <Field label="Merchant"><input className={inputCls} value={editing.merchant} onChange={(e) => setEditing({ ...editing, merchant: e.target.value })} /></Field>
            <Field label="Date"><input className={inputCls} type="date" value={editing.receipt_date} onChange={(e) => setEditing({ ...editing, receipt_date: e.target.value })} /></Field>
            <Field label="Amount (RM)"><input className={inputCls} type="number" step="0.01" value={editing.amount} onChange={(e) => setEditing({ ...editing, amount: e.target.value })} /></Field>
            <Field label="Category">
              <select className={inputCls} value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Notes"><input className={inputCls} value={editing.notes || ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Field>
            <div className="flex gap-3 mt-2">
              <button onClick={saveEdit} className="flex-1 bg-ink text-white rounded-lg py-2 font-medium">Save changes</button>
              <button onClick={() => setEditing(null)} className="flex-1 border border-slate-300 rounded-lg py-2 font-medium text-slate-600">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Annual summary with PDF export ----------
function SummaryPage({ token, user }) {
  const [year, setYear] = useState(new Date().getFullYear().toString());
  const [summary, setSummary] = useState(null);
  useEffect(() => { api('/api/summary?year=' + year, { token }).then(setSummary).catch(() => {}); }, [year]);
  const years = [];
  for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 7; y--) years.push(String(y));
  const total = summary ? summary.categories.reduce((s, c) => s + c.total, 0) : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold ink mb-1">Annual tax claim summary</h2>
          <p className="text-slate-500 text-sm">Use this report when completing your e-Filing</p>
        </div>
        <div className="flex gap-3">
          <select className={inputCls + ' w-32'} value={year} onChange={(e) => setYear(e.target.value)}>
            {years.map((y) => <option key={y}>{y}</option>)}
          </select>
          <button onClick={() => window.print()} className="bg-ink text-white rounded-lg px-4 py-2 text-sm font-medium whitespace-nowrap">Download PDF</button>
        </div>
      </div>
      <div id="print-area" className="bg-white border border-slate-200 rounded-2xl p-8">
        <div className="border-b border-slate-200 pb-4 mb-4">
          <h3 className="display text-xl font-bold ink">MyTax Receipt Logger — Annual Tax Claim Summary</h3>
          <p className="text-sm text-slate-500 mt-1">Taxpayer: {user.name} ({user.email}) · Year of Assessment {year} · Generated {new Date().toLocaleDateString('en-MY')}</p>
        </div>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="py-2 font-medium">LHDN relief category</th>
            <th className="py-2 font-medium text-right">Receipts</th>
            <th className="py-2 font-medium text-right">Claimable amount</th>
          </tr></thead>
          <tbody>
            {summary && summary.categories.length === 0 && <tr><td colSpan="3" className="py-8 text-center text-slate-400">No receipts recorded for {year}.</td></tr>}
            {summary && summary.categories.map((c) => (
              <tr key={c.category} className="border-b border-slate-100">
                <td className="py-2.5">{c.category}</td>
                <td className="py-2.5 text-right">{c.count}</td>
                <td className="py-2.5 text-right font-medium">{RM(c.total)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr>
            <td className="py-3 font-bold ink" colSpan="2">Total claimable</td>
            <td className="py-3 text-right display font-bold ink text-lg">{RM(total)}</td>
          </tr></tfoot>
        </table>
        <p className="text-xs text-slate-400 mt-6">All supporting receipts are retained in secure storage for 7 years in compliance with the Income Tax Act 1967. This summary is for personal reference during e-Filing and is not an official LHDN document.</p>
      </div>
    </div>
  );
}

// ---------- Lifecycle page ----------
function LifecyclePage({ token, notify }) {
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [summary, setSummary] = useState(null);
  const loadTiers = () => api('/api/summary', { token }).then(setSummary).catch(() => {});
  useEffect(() => { loadTiers(); }, []);

  async function run() {
    setBusy(true);
    try {
      const r = await api('/api/lifecycle/run', { method: 'POST', token, body: { days: Number(days) } });
      setResult(r); notify(r.message); loadTiers();
    } catch (e) { notify(e.message, 'error'); }
    setBusy(false);
  }
  const hot = summary ? (summary.tiers.find((t) => t.tier === 'hot') || {}).count || 0 : 0;
  const cold = summary ? (summary.tiers.find((t) => t.tier === 'cold') || {}).count || 0 : 0;

  return (
    <div>
      <h2 className="text-2xl font-bold ink mb-1">Storage lifecycle policy</h2>
      <p className="text-slate-500 text-sm mb-6">Simulates the Azure Blob Lifecycle Management rule from the project plan: receipts move from the Hot tier to the low-cost Cold tier after 30 days, then stay there for the rest of the 7-year retention period.</p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <Field label="Move receipts older than (days)">
            <input className={inputCls} type="number" min="0" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <p className="text-xs text-slate-400 mb-4">Tip for your demo: set this to 0 to move every Hot receipt to Cold immediately.</p>
          <button onClick={run} disabled={busy} className="w-full bg-ink text-white rounded-lg py-2.5 font-medium disabled:opacity-50">
            {busy ? 'Running…' : 'Run lifecycle policy now'}
          </button>
          {result && <p className="text-sm text-emerald-600 mt-3">{result.message}</p>}
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-6">
          <h3 className="font-semibold ink mb-4">Current tier distribution</h3>
          <div className="flex gap-4">
            <div className="flex-1 rounded-xl bg-orange-50 border border-orange-100 p-5 text-center">
              <p className="display text-3xl font-bold text-orange-600">{hot}</p>
              <p className="text-sm text-orange-700 mt-1">Hot tier</p>
              <p className="text-xs text-slate-400 mt-1">&lt; 30 days old</p>
            </div>
            <div className="flex-1 rounded-xl bg-sky-50 border border-sky-100 p-5 text-center">
              <p className="display text-3xl font-bold text-sky-600">{cold}</p>
              <p className="text-sm text-sky-700 mt-1">Cold tier</p>
              <p className="text-xs text-slate-400 mt-1">long-term, low cost</p>
            </div>
          </div>
          <p className="text-xs text-slate-400 mt-4">In production this runs automatically on Azure; here it is triggered manually so it can be demonstrated live.</p>
        </div>
      </div>
    </div>
  );
}

// ---------- App footer ----------
function AppFooter({ sidebar = false }) {
  return (
    <div className={sidebar
      ? 'px-5 py-3 border-t border-white/10 text-center'
      : 'mt-8 pt-4 border-t border-slate-200 text-center'}>
      <p className={`text-xs font-mono ${sidebar ? 'text-white/30' : 'text-slate-400'}`}>
        v{BUILD_VERSION}
      </p>
    </div>
  );
}

// ---------- App shell ----------
const NAV = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'upload', label: 'Upload receipt' },
  { id: 'receipts', label: 'My receipts' },
  { id: 'summary', label: 'Annual summary' },
  { id: 'lifecycle', label: 'Storage lifecycle' },
];

function App() {
  const [session, setSession] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('mytax-session')) || null; } catch { return null; }
  });
  const [page, setPage] = useState('dashboard');
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  function notify(msg, kind = 'ok') {
    setToast({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }
  function onLogin(data) {
    setSession(data);
    sessionStorage.setItem('mytax-session', JSON.stringify(data));
    notify('Welcome, ' + data.user.name);
  }
  function logout() {
    setSession(null);
    sessionStorage.removeItem('mytax-session');
  }

  if (!session) return <div><AuthPage onLogin={onLogin} notify={notify} /><Toast toast={toast} /></div>;
  const { token, user } = session;

  return (
    <div className="min-h-screen flex">
      <aside className="w-60 bg-ink text-white flex-col hidden md:flex">
        <div className="px-5 py-6 border-b border-white/10">
          <p className="display font-bold text-lg leading-tight">MyTax<br />Receipt Logger</p>
          <p className="text-xs opacity-50 mt-1">UI prototype · CI/CD build</p>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setPage(n.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg text-sm ${page === n.id ? 'bg-white/15 font-medium' : 'opacity-70 hover:opacity-100 hover:bg-white/5'}`}>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-white/10">
          <p className="text-sm font-medium">{user.name}</p>
          <button onClick={logout} className="text-xs opacity-60 hover:opacity-100 mt-1">Log out</button>
        </div>
        <AppFooter sidebar={true} />
      </aside>
      <main className="flex-1 px-6 py-8 max-w-5xl mx-auto w-full">
        <div className="md:hidden flex gap-2 mb-6 overflow-x-auto">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setPage(n.id)}
              className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap ${page === n.id ? 'bg-ink text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>
              {n.label}</button>
          ))}
        </div>
        {page === 'dashboard' && <Dashboard token={token} />}
        {page === 'upload' && <UploadPage token={token} notify={notify} goTo={setPage} />}
        {page === 'receipts' && <ReceiptsPage token={token} notify={notify} />}
        {page === 'summary' && <SummaryPage token={token} user={user} />}
        {page === 'lifecycle' && <LifecyclePage token={token} notify={notify} />}
        <AppFooter />
      </main>
      <Toast toast={toast} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
