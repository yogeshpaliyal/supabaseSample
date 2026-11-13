// Vanshavali — village family tree (Supabase edition)
const api = window.__mockApi || (await import('./api.js')).api;

// ============ State ============
const RANK = { viewer: 0, contributor: 1, editor: 2, owner: 3 };
const S = {
  user: null, treeId: null, treeName: '', role: null, trees: [],
  tab: 'people',
  DB: { people: [], marriages: [], parents: [] },
};
let P = {}, MBY = {}, PRC = {}, PRP = {}, ADJ = null;
let view = { mode: 'desc', root: '__all', sel: '' }, hist = [];
const savedMode = () => (['desc', 'explore'].includes(store.get('treeMode')) ? store.get('treeMode') : 'desc');
let profHist = [], F = null, delArmed = false, PK = null;
let expandState = {};                       // id -> true/false (user toggled)
const pan = { x: 0, y: 0, s: 0.85 };

const $ = id => document.getElementById(id);
const can = r => S.role && RANK[S.role] >= RANK[r];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
S.ancBoth = store.get('ancBoth') === '1';

function toast(msg, ms = 2200) {
  const el = $('toast'); el.textContent = msg; el.style.display = msg ? 'block' : 'none';
  clearTimeout(toast.t); if (msg && ms) toast.t = setTimeout(() => (el.style.display = 'none'), ms);
}
function fail(e) { console.error(e); toast('⚠️ ' + (e && e.message ? e.message : e), 5000); }
async function busy(msg, fn) { toast(msg, 0); try { const r = await fn(); toast(''); return r; } catch (e) { fail(e); throw e; } }
function show(id) { ['boot', 'scrSignin', 'scrTrees', 'scrApp'].forEach(s => ($(s).hidden = s !== id)); }
function ago(t) {
  const s = (Date.now() - new Date(t)) / 1000;
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'; return new Date(t).toLocaleDateString();
}
const initials = n => String(n || '?').replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
const who = p => (p && (p.display_name || p.email)) || 'Someone';

// ============ Data model (normalised to the shape the UI code uses) ============
function setData(raw) {
  S.DB = {
    people: raw.people.map(p => ({ ID: p.id, Name: p.name, Gender: p.gender || '', BirthYear: p.birth_year ?? '', DeathYear: p.death_year ?? '', BirthDate: p.birth_date || '', DeathDate: p.death_date || '', Deceased: !!p.deceased || p.death_year != null, Family: p.family || '', Village: p.village || '', Notes: p.notes || '', Phone: p.phone || '' })),
    marriages: raw.marriages.map(m => ({ ID: m.id, HusbandID: m.husband_id, WifeID: m.wife_id, Status: m.status, Year: m.year ?? '', Notes: m.notes || '' })),
    parents: raw.parents.map(r => ({ ID: r.id, ChildID: r.child_id, FatherID: r.father_id || '', MotherID: r.mother_id || '', Type: r.type })),
  };
  index(); renderList(); renderTree();
}
function index() {
  P = {}; MBY = {}; PRC = {}; PRP = {}; ADJ = null;
  S.DB.people.forEach(p => (P[p.ID] = p));
  S.DB.marriages.forEach(m => {
    if (!P[m.HusbandID] || !P[m.WifeID]) return;
    (MBY[m.HusbandID] = MBY[m.HusbandID] || []).push(m);
    (MBY[m.WifeID] = MBY[m.WifeID] || []).push(m);
  });
  Object.values(MBY).forEach(a => a.sort((x, y) => (parseInt(x.Year) || 9999) - (parseInt(y.Year) || 9999)));
  S.DB.parents.forEach(r => {
    if (!P[r.ChildID]) return;
    (PRC[r.ChildID] = PRC[r.ChildID] || []).push(r);
    [r.FatherID, r.MotherID].forEach(x => { if (P[x]) (PRP[x] = PRP[x] || []).push(r); });
  });
}
const marriagesOf = id => MBY[id] || [];
const spouseOf = (m, id) => P[m.HusbandID === id ? m.WifeID : m.HusbandID];
const parentRows = id => PRC[id] || [];
const ended = m => m.Status && m.Status !== 'Current';
function socialParents(id) { const rows = parentRows(id); return rows.find(r => r.Type === 'Adopted') || rows[0] || null; }
const isDead = p => !!(p.Deceased || p.DeathYear || p.DeathDate);
const fmtDate = iso => { const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); };
// age now, or age at death; approx when only a year is known on either side
function ageOf(p) {
  const dead = isDead(p);
  if (!p.BirthYear && !p.BirthDate) return null;
  let end, endYear;
  if (dead) { if (p.DeathDate) end = new Date(p.DeathDate + 'T00:00:00'); endYear = p.DeathYear ? +p.DeathYear : end ? end.getFullYear() : null; if (!endYear) return null; }
  else { end = new Date(); endYear = end.getFullYear(); }
  if (p.BirthDate && end) {
    const b = new Date(p.BirthDate + 'T00:00:00');
    let n = end.getFullYear() - b.getFullYear();
    if (end.getMonth() < b.getMonth() || (end.getMonth() === b.getMonth() && end.getDate() < b.getDate())) n--;
    return n >= 0 && n < 130 ? { n, approx: false } : null;
  }
  const n = endYear - (+p.BirthYear || new Date(p.BirthDate).getFullYear());
  return n >= 0 && n < 130 ? { n, approx: true } : null;
}
function ageTxt(p, short) {
  const a = ageOf(p); if (!a) return '';
  const n = (a.approx ? '~' : '') + a.n;
  return isDead(p) ? (short ? 'aged ' + n : 'died at ' + n) : (short ? n + 'y' : 'age ' + n);
}
function years(p, short) {
  const b = p.BirthYear, d = p.DeathYear, dead = isDead(p);
  const span = dead ? ((b || d) ? (b || '?') + '–' + (d || '?') : '') : (b ? String(b) : '');
  return [span, ageTxt(p, short)].filter(Boolean).join(' · ');
}
const deadMark = p => isDead(p) ? '<span class="dg" title="Passed away">†</span>' : '';
function birthOrder(p) { const m = /(?:Birth order|Listed)\s*(\d+)/i.exec(p.Notes || '') || /(\d+)(?:st|nd|rd|th)\s+(?:son|daughter)/i.exec(p.Notes || ''); return m ? +m[1] : 99; }
function byBirth(a, b) { return (parseInt(a.BirthYear) || 9999) - (parseInt(b.BirthYear) || 9999) || (a.BirthDate && b.BirthDate ? a.BirthDate.localeCompare(b.BirthDate) : 0) || birthOrder(a) - birthOrder(b) || a.Name.localeCompare(b.Name); }
const byName = (a, b) => a.Name.localeCompare(b.Name);
function relOf(p) {
  const r = socialParents(p.ID), f = r && (P[r.FatherID] || P[r.MotherID]);
  if (f) return (p.Gender === 'F' ? 'd/o ' : p.Gender === 'M' ? 's/o ' : 'c/o ') + f.Name;
  const m = marriagesOf(p.ID)[0];
  if (m) return (p.Gender === 'F' ? 'w/o ' : p.Gender === 'M' ? 'h/o ' : 'spouse of ') + spouseOf(m, p.ID).Name;
  return '';
}
const digits = s => String(s || '').replace(/\D/g, '');
function waNumber(ph) { // WhatsApp needs country code; assume India for 10-digit numbers
  const d = digits(ph);
  if (String(ph).trim().startsWith('+')) return d;
  if (d.length === 10) return '91' + d;
  if (d.length === 11 && d[0] === '0') return '91' + d.slice(1);
  return d;
}
const label = p => p.Name + (p.BirthYear ? ' (' + p.BirthYear + ')' : '') + (relOf(p) ? ' ' + relOf(p) : '');
const avatar = p => '<span class="av ' + esc(p.Gender) + '">' + esc(initials(p.Name)) + '</span>';
const nameLink = p => p ? '<a class="lnk" onclick="App.openProfile(\'' + esc(p.ID) + '\')">' + esc(p.Name) + '</a>' : '';
const chip = (p, extra) => '<span class="chip ' + esc(p.Gender) + '" onclick="App.openProfile(\'' + esc(p.ID) + '\')">' + esc(p.Name) + (extra ? '<span class="tagline">' + esc(extra) + '</span>' : '') + '</span>';

// ============ Boot / auth / trees ============
function treeFromUrl() { try { return new URL(location.href).searchParams.get('tree'); } catch { return null; } }
function setUrlTree(id) {
  try { const u = new URL(location.href); if (id) u.searchParams.set('tree', id); else u.searchParams.delete('tree'); history.replaceState(null, '', u); } catch {}
}

async function boot() {
  const session = await api.session().catch(() => null);
  api.onAuth(s => { if (!!s?.user !== !!S.user) { S.user = s?.user || null; route(); } });
  S.user = session?.user || null;
  await route();
}

async function route() {
  if (!S.user) {
    const t = treeFromUrl();
    $('joinHint').hidden = !t;
    $('joinHint').textContent = t ? 'You were invited to view a family tree. Sign in to continue.' : '';
    show('scrSignin'); return;
  }
  try { S.trees = await api.myTrees(); } catch (e) { fail(e); S.trees = []; }
  const want = treeFromUrl() || store.get('lastTree');
  const mine = S.trees.find(t => t.id === want);
  if (mine) return openTree(mine);
  if (treeFromUrl()) return showJoin(treeFromUrl());
  if (S.trees.length === 1) return openTree(S.trees[0]);
  showTrees();
}

function showTrees(joinHtml = '') {
  $('joinBox').innerHTML = joinHtml;
  $('treeList').innerHTML = S.trees.length ? S.trees.map(t =>
    '<div class="list"><div class="item" onclick="App.openTreeId(\'' + esc(t.id) + '\')">' +
    '<span class="av">🌳</span><div class="grow"><div class="nm">' + esc(t.name) + '</div>' +
    '<div class="sub">' + t.people_count + ' people · ' + esc(t.role) +
    (t.pending_edits ? ' · ' + t.pending_edits + ' edit requests' : '') + (t.pending_access ? ' · ' + t.pending_access + ' join requests' : '') +
    '</div></div><span class="muted">›</span></div></div>').join('')
    : '<div class="empty">You are not part of any tree yet. Open an invite link from your family, or start a new tree.</div>';
  show('scrTrees');
}

async function showJoin(id) {
  let info = null;
  try { info = await api.treeInfo(id); } catch (e) { fail(e); }
  if (!info) { setUrlTree(null); return showTrees('<div class="hint">That invite link is not valid any more.</div>'); }
  if (info.my_role) { S.trees = await api.myTrees(); return openTree(S.trees.find(t => t.id === id)); }
  const pending = info.my_request === 'pending', rejected = info.my_request === 'rejected';
  showTrees('<div class="card"><h2>Join “' + esc(info.name) + '”</h2>' +
    (pending ? '<p>Your request has been sent. An owner of this tree will approve it — check back soon.</p>'
      : (rejected ? '<p class="muted">Your earlier request was declined. You can ask again with a note.</p>' : '<p class="muted">Tell the tree owner who you are so they can let you in.</p>') +
        '<textarea id="joinMsg" rows="2" placeholder="e.g. I am Ramesh, son of Mohan Ram (Paliyal)"></textarea>' +
        '<div class="actions"><button class="btn" onclick="App.requestAccess(\'' + esc(id) + '\')">Request access</button></div>') +
    '</div>');
}

async function openTree(t) {
  if (!t) return showTrees();
  S.treeId = t.id; S.treeName = t.name; S.role = t.role;
  store.set('lastTree', t.id); setUrlTree(t.id);
  view = { mode: savedMode(), root: '__all', sel: '' }; hist = []; expandState = {};
  $('treeTitle').textContent = t.name;
  $('roleBadge').textContent = t.role;
  $('tabMembers').hidden = !can('owner');
  $('tabInbox').hidden = !can('contributor');
  $('addBtn').textContent = can('editor') ? '+ Add' : can('contributor') ? '+ Suggest' : '';
  $('addBtn').hidden = !can('contributor');
  $('selBtn').hidden = !can('contributor'); if (S.selectMode) toggleSelect();
  updateCounts(t);
  show('scrApp');
  tab((S.tab === 'members' && !can('owner')) || (S.tab === 'inbox' && !can('contributor')) ? 'people' : S.tab);
  await reload();
}

function updateCounts(t) {
  const ic = $('inboxCount'), mc = $('membersCount');
  ic.hidden = !(t && t.pending_edits); ic.textContent = t ? t.pending_edits : '';
  mc.hidden = !(t && t.pending_access); mc.textContent = t ? t.pending_access : '';
}

async function reload() {
  if (!S.treeId) return;
  try {
    const raw = await api.loadTree(S.treeId);
    setData(raw);
    api.myTrees().then(ts => { S.trees = ts; const t = ts.find(x => x.id === S.treeId); if (t) { S.role = t.role; updateCounts(t); } }).catch(() => {});
    if (S.tab === 'inbox') renderInbox();
    if (S.tab === 'members') renderMembers();
  } catch (e) { fail(e); }
}

function tab(t) {
  S.tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  ['people', 'tree', 'inbox', 'members'].forEach(x => ($('p' + x[0].toUpperCase() + x.slice(1)).hidden = x !== t));
  if (t === 'tree') { renderTree(true); }
  updateSelBar();
  if (t === 'inbox') renderInbox();
  if (t === 'members') renderMembers();
}

// ============ People list ============
function renderList() {
  const q = $('q').value.trim().toLowerCase();
  const rank = p => { const n = p.Name.toLowerCase(); return !q ? 0 : n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2; };
  const rows = S.DB.people.filter(p => !q || ([p.Name, p.Family, p.Village, p.Notes, relOf(p)].join(' ').toLowerCase().includes(q) || (digits(q).length >= 3 && digits(p.Phone).includes(digits(q))))).sort((a, b) => rank(a) - rank(b) || byName(a, b));
  $('count').textContent = rows.length + ' of ' + S.DB.people.length + ' people';
  $('list').innerHTML = rows.length ? rows.slice(0, 300).map(p =>
    '<div class="item" onclick="App.openProfile(\'' + esc(p.ID) + '\', true)">' + avatar(p) +
    '<div class="grow"><div class="nm">' + esc(p.Name) + deadMark(p) + '</div><div class="sub">' + esc([years(p), relOf(p), p.Family, p.Village].filter(Boolean).join(' · ')) + '</div></div></div>'
  ).join('') + (rows.length > 300 ? '<div class="muted small">Showing first 300 — refine your search.</div>' : '')
    : '<div class="empty">' + (S.DB.people.length ? 'No match.' : 'No people yet.' + (can('contributor') ? ' Tap “+ Add” to start.' : '')) + '</div>';
}

// ============ Person picker ============
function pick(title, filter, cb, allowNone) {
  PK = { filter: filter || (() => true), cb, allowNone };
  $('pickTitle').textContent = title; $('pickQ').value = '';
  $('pickOv').classList.add('show'); renderPick();
  setTimeout(() => $('pickQ').focus(), 60);
}
function renderPick() {
  const q = $('pickQ').value.trim().toLowerCase();
  const rank = p => { const n = p.Name.toLowerCase(); return !q ? 0 : n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2; };
  const rows = S.DB.people.filter(PK.filter).filter(p => !q || label(p).toLowerCase().includes(q) || (p.Family || '').toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || byName(a, b)).slice(0, 80);
  $('pickList').innerHTML = (PK.allowNone ? '<div class="item" onclick="App.pickDone(\'\')"><span class="av">–</span><div class="nm">None</div></div>' : '') +
    rows.map(p => '<div class="item" onclick="App.pickDone(\'' + esc(p.ID) + '\')">' + avatar(p) + '<div class="grow"><div class="nm">' + esc(p.Name) + '</div><div class="sub">' + esc([years(p), relOf(p), p.Family].filter(Boolean).join(' · ')) + '</div></div></div>').join('') +
    (rows.length ? '' : '<div class="empty">No match</div>');
}
function pickDone(id) { const cb = PK.cb; closePick(); cb(id); }
function closePick() { $('pickOv').classList.remove('show'); }

// ============ Profile ============
function openProfile(id, fresh) {
  const p = P[id]; if (!p) return;
  if (fresh) profHist = [];
  if (profHist[profHist.length - 1] !== id) profHist.push(id);
  view.sel = id;
  $('profBox').innerHTML = profileHtml(p);
  $('profOv').classList.add('show');
  $('profBox').scrollTop = 0;
}
function profBack() { profHist.pop(); const id = profHist.pop(); if (id) openProfile(id); else closeProfile(); }
function closeProfile() { $('profOv').classList.remove('show'); profHist = []; }

function siblingsOf(id) {
  const out = {};
  parentRows(id).forEach(r => [r.FatherID, r.MotherID].forEach(par => {
    if (!P[par]) return;
    (PRP[par] || []).forEach(o => {
      if (o.ChildID === id) return;
      // half-siblings only when a recorded parent differs; an unrecorded parent is not evidence of a different one
      const differ = (a, b) => a && b && a !== b;
      const full = !differ(o.FatherID, r.FatherID) && !differ(o.MotherID, r.MotherID);
      const cur = out[o.ChildID];
      out[o.ChildID] = { p: P[o.ChildID], kind: (cur && cur.kind === 'full') || full ? 'full' : 'half' };
    });
  }));
  return Object.values(out).sort((a, b) => byBirth(a.p, b.p));
}

function lifeLine(p) {
  const born = p.BirthDate ? fmtDate(p.BirthDate) : p.BirthYear ? String(p.BirthYear) : '';
  if (!isDead(p)) return born ? '🎂 Born ' + born + (ageTxt(p) ? ' · ' + ageTxt(p).replace(/^a/, 'A') : '') : '';
  const died = p.DeathDate ? fmtDate(p.DeathDate) : p.DeathYear ? String(p.DeathYear) : '';
  return '🕯️ ' + [born && 'Born ' + born, 'Passed away' + (died ? ' ' + died : ''), ageTxt(p).replace('died at', 'aged')].filter(Boolean).join(' · ');
}
function profileHtml(p) {
  const id = p.ID, e = esc(id);
  const editLbl = can('editor') ? '✏️ Edit' : '✏️ Suggest edit';
  let h = '<div class="row2" style="align-items:center"><div>' + (profHist.length > 1 ? '<button class="btn sm ghost" onclick="App.profBack()">← Back</button>' : '') +
    '</div><div style="text-align:right"><button class="icon-btn" onclick="App.closeProfile()">✕</button></div></div>';
  h += '<div class="prof-head">' + avatar(p) + '<div><h2 style="margin:0">' + esc(p.Name) + deadMark(p) + '</h2><div class="sub">' +
    esc([p.Gender === 'M' ? 'Male' : p.Gender === 'F' ? 'Female' : '', p.Family, relOf(p)].filter(Boolean).join(' · ')) + '</div>' +
    (lifeLine(p) ? '<div class="sub">' + esc(lifeLine(p)) + '</div>' : '') +
    (p.Village ? '<div class="sub">📍 ' + esc(p.Village) + '</div>' : '') + '</div></div>';
  if (p.Phone) h += '<div class="contact"><span class="num">📞 ' + esc(p.Phone) + '</span><span class="spacer"></span>' +
    '<a class="btn sm" href="tel:' + esc(p.Phone.replace(/[^+0-9]/g, '')) + '">Call</a>' +
    '<a class="btn sm wa" href="https://wa.me/' + esc(waNumber(p.Phone)) + '" target="_blank" rel="noopener">WhatsApp</a></div>';
  if (p.Notes) h += '<p style="margin:10px 0 0">' + esc(p.Notes) + '</p>';
  h += '<div class="actions"><button class="btn sm" onclick="App.showInTree(\'' + e + '\')">🌳 Show in tree</button>' +
    '<button class="btn sm ghost" onclick="App.closeProfile(); App.navigate({mode: App.treeMode(), root:\'' + e + '\', sel:\'' + e + '\'}); App.tab(\'tree\')">Tree from here</button>' +
    '<button class="btn sm ghost" onclick="App.closeProfile(); App.navigate({mode:\'anc\', root:\'' + e + '\', sel:\'' + e + '\'}); App.tab(\'tree\')">Ancestors</button>' +
    (can('contributor') ? '<button class="btn sm ghost" onclick="App.openEdit(\'' + e + '\')">' + editLbl + '</button>' : '') + '</div>';

  const rows = parentRows(id), br = bioRow(id), missing = !br || !P[br.FatherID] || !P[br.MotherID];
  h += '<h3>Parents</h3>' + (rows.length ? rows.map(r => '<div>' + (r.Type === 'Adopted' ? '<b>Adoptive:</b> ' : '') +
    [P[r.FatherID] ? 'Father ' + nameLink(P[r.FatherID]) : '', P[r.MotherID] ? 'Mother ' + nameLink(P[r.MotherID]) : ''].filter(Boolean).join(' · ') + '</div>').join('')
    : '<div class="sub">Not recorded</div>') +
    ((missing && can('contributor')) || (rows.length && marriagesOf(id).length) ? '<div class="actions" style="margin-top:6px">' +
      (missing && can('contributor') ? '<button class="btn sm ghost" onclick="App.openParents(\'' + e + '\')">+ ' + (!br ? 'Add parents' : !P[br.FatherID] ? 'Add father' : 'Add mother') + '</button>' : '') +
      (rows.length && marriagesOf(id).length ? '<button class="btn sm ghost" onclick="App.openFamily(null,\'' + e + '\')">🌳 ' + (p.Gender === 'F' ? 'Her' : p.Gender === 'M' ? 'His' : 'Their') + ' birth family</button>' : '') + '</div>' : '');

  const ms = marriagesOf(id);
  h += '<h3>Marriages</h3>' + (ms.length ? ms.map((m, i) => '<div>' + (ms.length > 1 ? (i + 1) + '. ' : '') + nameLink(spouseOf(m, id)) +
    '<span class="tagline">' + esc([m.Year, ended(m) ? m.Status : ''].filter(Boolean).join(' · ')) + '</span></div>').join('') : '<div class="sub">None recorded</div>');

  const groups = {}, order = [];
  (PRP[id] || []).slice().sort((a, b) => byBirth(P[a.ChildID], P[b.ChildID])).forEach(r => {
    const k = (r.FatherID === id ? r.MotherID : r.FatherID) || '_';
    if (!groups[k]) { groups[k] = []; order.push(k); }
    if (!groups[k].some(x => x.r.ChildID === r.ChildID)) groups[k].push({ r, c: P[r.ChildID] });
  });
  ms.forEach(m => { const s = spouseOf(m, id).ID; if (!groups[s]) { groups[s] = []; order.push(s); } });
  h += '<h3>Children</h3>' + (order.length ? '' : '<div class="sub">None recorded</div>');
  order.forEach(k => {
    const other = P[k];
    h += '<div class="sub" style="margin:8px 0 4px">' + (other ? 'with ' + esc(other.Name) : 'other parent not recorded') +
      (other && can('contributor') ? ' <button class="btn sm ghost" onclick="App.addChild(\'' + e + '\',\'' + esc(k) + '\')">+ child</button>' : '') + '</div>';
    h += '<div class="chips">' + (groups[k].map(x => chip(x.c, [x.c.BirthYear, x.r.Type === 'Adopted' ? 'adopted' : ''].filter(Boolean).join(' · '))).join('') || '<span class="sub">—</span>') + '</div>';
  });
  if (can('contributor')) h += '<div class="actions"><button class="btn sm ghost" onclick="App.addChild(\'' + e + '\',\'\')">+ Add child</button><button class="btn sm ghost" onclick="App.addSpouse(\'' + e + '\')">+ Add ' + (p.Gender === 'F' ? 'husband' : p.Gender === 'M' ? 'wife' : 'spouse') + '</button></div>';

  const sibs = siblingsOf(id);
  h += '<h3>Siblings</h3>' + (sibs.length ? '<div class="chips">' + sibs.map(s => chip(s.p, s.kind === 'half' ? 'half' : '')).join('') + '</div>' : '<div class="sub">None recorded</div>');
  h += '<h3>How are they related?</h3><button class="btn sm ghost" onclick="App.relateFrom(\'' + e + '\')">Compare with someone…</button><div id="relOut" style="margin-top:8px"></div>';
  return h;
}

// ============ Relationship finder ============
const TERMS = {
  'father>father': 'Dada', 'father>mother': 'Dadi', 'mother>father': 'Nana', 'mother>mother': 'Nani',
  'father>brother': 'Chacha / Tau', 'father>sister': 'Bua', 'mother>brother': 'Mama', 'mother>sister': 'Mausi',
  'father>brother>wife': 'Chachi / Tai', 'father>sister>husband': 'Fufa', 'mother>brother>wife': 'Mami', 'mother>sister>husband': 'Mausa',
  'brother>wife': 'Bhabhi', 'sister>husband': 'Jija', 'brother>son': 'Bhatija', 'brother>daughter': 'Bhatiji',
  'sister>son': 'Bhanja', 'sister>daughter': 'Bhanji', 'son>wife': 'Bahu', 'daughter>husband': 'Damad',
  'son>son': 'Pota', 'son>daughter': 'Poti', 'daughter>son': 'Nati / Navasa', 'daughter>daughter': 'Natin / Navasi',
  'wife>father': 'Sasur', 'wife>mother': 'Saas', 'husband>father': 'Sasur', 'husband>mother': 'Saas',
  'wife>brother': 'Saala', 'wife>sister': 'Saali', 'husband>brother': 'Devar / Jeth', 'husband>sister': 'Nanad',
  'father>brother>son': 'Cousin (Chachera bhai)', 'father>brother>daughter': 'Cousin (Chacheri behen)',
  'mother>brother>son': 'Cousin (Mamera bhai)', 'mother>brother>daughter': 'Cousin (Mameri behen)',
  'father>sister>son': 'Cousin (Fufera bhai)', 'mother>sister>son': 'Cousin (Mausera bhai)',
  'father>father>father': 'Pardada', 'mother>father>father': 'Parnana', 'wife>sister>husband': 'Saadu',
  'son>son>son': 'Parpota', 'father>father>brother': 'Dada (chhote/bade)',
};
const g = (p, m, f, u) => p && p.Gender === 'M' ? m : p && p.Gender === 'F' ? f : u;
function buildAdj() {
  if (ADJ) return ADJ;
  ADJ = {};
  const add = (a, b, w) => { if (!P[a] || !P[b] || a === b) return; (ADJ[a] = ADJ[a] || []).push({ to: b, w }); };
  S.DB.parents.forEach(r => {
    const c = r.ChildID, ad = r.Type === 'Adopted' ? 'adoptive ' : '', adc = r.Type === 'Adopted' ? 'adopted ' : '';
    [r.FatherID, r.MotherID].forEach(par => { if (!P[par] || !P[c]) return; add(c, par, ad + g(P[par], 'father', 'mother', 'parent')); add(par, c, adc + g(P[c], 'son', 'daughter', 'child')); });
  });
  S.DB.marriages.forEach(m => { add(m.HusbandID, m.WifeID, 'wife'); add(m.WifeID, m.HusbandID, 'husband'); });
  Object.keys(PRP).forEach(par => {
    const kids = [...new Set(PRP[par].filter(r => r.Type !== 'Adopted').map(r => r.ChildID))];
    for (let i = 0; i < kids.length; i++) for (let j = 0; j < kids.length; j++) if (i !== j) add(kids[i], kids[j], g(P[kids[j]], 'brother', 'sister', 'sibling'));
  });
  Object.keys(ADJ).forEach(k => { const s = {}; ADJ[k] = ADJ[k].filter(e => !s[e.to + e.w] && (s[e.to + e.w] = 1)); });
  return ADJ;
}
function relPath(a, b) {
  const adj = buildAdj(), prev = { [a]: null }, q = [a];
  while (q.length) { const x = q.shift(); if (x === b) break; (adj[x] || []).forEach(e => { if (!(e.to in prev)) { prev[e.to] = { from: x, w: e.w }; q.push(e.to); } }); }
  if (!(b in prev)) return null;
  const steps = []; let cur = b;
  while (prev[cur]) { steps.unshift({ id: cur, w: prev[cur].w }); cur = prev[cur].from; }
  return steps;
}
function relateFrom(a) {
  pick('Compare ' + P[a].Name + ' with…', p => p.ID !== a, b => {
    if (!b) return;
    const steps = relPath(a, b), out = $('relOut'); if (!out) return;
    if (!steps) { out.innerHTML = '<div class="sub">No connection recorded between them.</div>'; return; }
    const term = TERMS[steps.map(s => s.w).join('>')];
    out.innerHTML = '<div class="path">' + nameLink(P[a]) + steps.map(s => '<span class="arrow">→ ' + esc(s.w) + ' →</span>' + nameLink(P[s.id])).join('') + '</div>' +
      '<div class="sub">' + esc(P[b].Name) + ' is ' + esc(P[a].Name) + '’s ' + esc(steps.map(s => s.w).join('’s ')) + ' (' + steps.length + ' steps)</div>' +
      (term ? '<div class="term">≈ ' + esc(term) + '</div>' : '');
  });
}

// ============ Edit form ============
function openEdit(id, preset) {
  if (!can('contributor')) return;
  if (!preset) S.addFromTree = false;
  const p = P[id];
  F = {
    person: Object.assign({ ID: '', Name: '', Gender: '', BirthYear: '', DeathYear: '', BirthDate: '', DeathDate: '', Deceased: false, Family: '', Village: '', Notes: '', Phone: '' }, p || (preset && preset.person) || {}),
    parents: p ? parentRows(id).map(r => ({ FatherID: r.FatherID, MotherID: r.MotherID, Type: r.Type || 'Biological' })) : ((preset && preset.parents) || []),
    marriages: p ? marriagesOf(id).map(m => ({ SpouseID: spouseOf(m, id).ID, Status: m.Status || 'Current', Year: m.Year, Notes: m.Notes })) : ((preset && preset.marriages) || []),
  };
  if (!F.parents.some(r => r.Type !== 'Adopted')) F.parents.unshift({ FatherID: '', MotherID: '', Type: 'Biological' });
  FORM_KEYS.forEach(k => ($('f_' + k).value = F.person[k] ?? ''));
  $('f_Deceased').checked = isDead(F.person); dateSync();
  const direct = can('editor');
  $('formTitle').textContent = (p ? (direct ? 'Edit ' : 'Suggest changes to ') + p.Name : (direct ? 'Add person' : 'Suggest a new person'));
  $('formNote').hidden = direct;
  $('formNote').textContent = 'Your changes will be sent to the tree editors for approval.';
  $('saveBtn').textContent = direct ? 'Save' : 'Send for approval';
  $('delBtn').hidden = !p;
  $('delBtn').textContent = direct ? 'Delete' : 'Suggest delete';
  delArmed = false;
  renderRelRows();
  $('editOv').classList.add('show');
  if (!p) setTimeout(() => $('f_Name').focus(), 60);
}
function closeEdit() { $('editOv').classList.remove('show'); S.addFromTree = false; }
function pbtn(val, ph, onclick) { const p = P[val]; return '<button class="pickbtn' + (p ? '' : ' emptyv') + '" onclick="' + onclick + '">' + esc(p ? label(p) : ph) + '</button>'; }
const FORM_KEYS = ['Name', 'Gender', 'BirthYear', 'BirthDate', 'DeathYear', 'DeathDate', 'Family', 'Village', 'Notes', 'Phone'];
function readForm() {
  FORM_KEYS.forEach(k => (F.person[k] = $('f_' + k).value.trim()));
  F.person.Deceased = $('f_Deceased').checked;
  if (!F.person.Deceased) { F.person.DeathYear = ''; F.person.DeathDate = ''; }
}
// keep year and full date in step, show/hide the death fields and a live age hint
function dateSync(which, from) {
  if (which) {
    const y = $('f_' + which + 'Year'), d = $('f_' + which + 'Date');
    if (from === 'date' && d.value) y.value = d.value.slice(0, 4);
    if (from === 'year' && d.value && d.value.slice(0, 4) !== y.value.trim()) d.value = '';
  }
  const dead = $('f_Deceased').checked;
  $('deathRow').hidden = !dead;
  const tmp = { BirthYear: $('f_BirthYear').value.trim(), BirthDate: $('f_BirthDate').value, Deceased: dead,
    DeathYear: dead ? $('f_DeathYear').value.trim() : '', DeathDate: dead ? $('f_DeathDate').value : '' };
  const t = ageTxt(tmp);
  $('ageHint').textContent = t ? t.charAt(0).toUpperCase() + t.slice(1) + (ageOf(tmp).approx ? ' (approx — add the date for exact age)' : '') : '';
}
function dateErr(p) {
  const yr = new Date().getFullYear(), today = new Date().toISOString().slice(0, 10);
  for (const [k, l] of [['BirthYear', 'Birth year'], ['DeathYear', 'Death year']])
    if (p[k] && !(/^\d{3,4}$/.test(p[k]) && +p[k] <= yr)) return l + ' should be a year like 1985';
  if ((p.BirthDate && p.BirthDate > today) || (p.DeathDate && p.DeathDate > today)) return 'Date can’t be in the future';
  if (p.BirthYear && p.DeathYear && +p.DeathYear < +p.BirthYear) return 'Death year is before birth year';
  if (p.BirthDate && p.DeathDate && p.DeathDate < p.BirthDate) return 'Date of death is before date of birth';
  return '';
}
function renderRelRows() {
  $('f_parents').innerHTML = F.parents.map((r, i) =>
    '<div class="relrow"><div class="row2"><div class="sub">' + (r.Type === 'Adopted' ? 'Adoptive parents' : 'Birth parents') + '</div>' +
    (r.Type === 'Adopted' || i > 0 ? '<button class="x" onclick="App.rmParent(' + i + ')">✕</button>' : '') + '</div>' +
    '<div class="row2">' + pbtn(r.FatherID, 'Father…', 'App.pickParent(' + i + ',\'FatherID\')') + '</div>' +
    '<div class="row2">' + pbtn(r.MotherID, 'Mother…', 'App.pickParent(' + i + ',\'MotherID\')') + '</div></div>').join('');
  $('f_marriages').innerHTML = F.marriages.length ? F.marriages.map((m, i) =>
    '<div class="relrow"><div class="row2">' + pbtn(m.SpouseID, 'Spouse…', 'App.pickSpouse(' + i + ')') + '<button class="x" onclick="App.rmMarriage(' + i + ')">✕</button></div>' +
    '<div class="row2"><select onchange="App.setM(' + i + ',\'Status\',this.value)">' +
    ['Current', 'Ended (death)', 'Ended (separation)'].map(s => '<option' + (m.Status === s ? ' selected' : '') + '>' + s + '</option>').join('') +
    '</select><input placeholder="Year" inputmode="numeric" value="' + esc(m.Year || '') + '" oninput="App.setM(' + i + ',\'Year\',this.value)"></div>' + kidsChecklist(m, i) + '</div>').join('')
    : '<div class="sub" style="margin-bottom:8px">No marriages</div>';
}
function kidsChecklist(m, i) {
  const sp = P[m.SpouseID]; if (!sp) return '';
  const kids = spouseKids(m.SpouseID); if (!kids.length) return '';
  const wife = selfIsWife(m.SpouseID), sel = new Set(m.LinkKids || []);
  return '<div class="kids"><div class="sub">' + esc(sp.Name) + '’s children — tick the ones who are also ' + (wife ? 'her' : 'his') + ' children</div>' +
    kids.map(k => k.state === 'other'
      ? '<label class="kid off"><input type="checkbox" disabled> ' + esc(k.p.Name) + ' <span class="tagline">' + (wife ? 'mother' : 'father') + ': ' + esc(k.otherName) + '</span></label>'
      : '<label class="kid"><input type="checkbox"' + (k.state === 'already' ? ' checked disabled' : (sel.has(k.id) ? ' checked' : '')) +
        ' onchange="App.toggleKid(' + i + ',\'' + esc(k.id) + '\',this.checked)"> ' + esc(k.p.Name) + (k.p.BirthYear ? ' <span class="tagline">' + esc(k.p.BirthYear) + '</span>' : '') +
        (k.state === 'already' ? ' <span class="tagline">already linked</span>' : '') + '</label>').join('') +
    (kids.some(k => k.state === 'free') ? '<div class="actions" style="margin-top:4px"><button class="btn sm ghost" onclick="App.allKids(' + i + ',true)">Select all</button><button class="btn sm ghost" onclick="App.allKids(' + i + ',false)">None</button></div>' : '') +
    '</div>';
}
function pickParent(i, key) {
  readForm();
  const self = F.person.ID;
  pick(key === 'FatherID' ? 'Choose father' : 'Choose mother', p => p.ID !== self && (key === 'FatherID' ? p.Gender !== 'F' : p.Gender !== 'M'),
    id => { F.parents[i][key] = id; renderRelRows(); }, true);
}
function selfIsWife(spouseId) {
  const g = $('f_Gender').value, sp = P[spouseId];
  return g === 'F' || (g !== 'M' && sp && sp.Gender === 'M');
}
// children of the spouse that have no other parent yet (or already have this person)
function spouseKids(spouseId) {
  const wife = selfIsWife(spouseId), self = F.person.ID, out = [];
  (PRP[spouseId] || []).forEach(r => {
    const mine = wife ? r.FatherID === spouseId : r.MotherID === spouseId;
    if (!mine) return;
    const other = wife ? r.MotherID : r.FatherID;
    if (out.some(x => x.id === r.ChildID)) return;
    out.push({ id: r.ChildID, p: P[r.ChildID], state: !other ? 'free' : other === self && self ? 'already' : 'other', otherName: other && P[other] ? P[other].Name : '' });
  });
  return out.sort((a, b) => byBirth(a.p, b.p));
}
const freeKids = spouseId => spouseKids(spouseId).filter(k => k.state === 'free').map(k => k.id);
function pickSpouse(i) { readForm(); const self = F.person.ID; pick('Choose spouse', p => p.ID !== self, id => { F.marriages[i].SpouseID = id; F.marriages[i].LinkKids = id ? freeKids(id) : []; renderRelRows(); }, true); }

function payloadFromForm() {
  const p = F.person;
  return {
    person: { id: p.ID || null, name: p.Name, gender: p.Gender || null, birth_year: p.BirthYear || null, death_year: p.DeathYear || null, family: p.Family || null, village: p.Village || null, notes: p.Notes || null, phone: p.Phone || null,
      birth_date: p.BirthDate || null, death_date: p.DeathDate || null, deceased: !!p.Deceased },
    parents: F.parents.filter(r => r.FatherID || r.MotherID).map(r => ({ father_id: r.FatherID || null, mother_id: r.MotherID || null, type: r.Type })),
    marriages: F.marriages.filter(m => m.SpouseID).map(m => ({ spouse_id: m.SpouseID, status: m.Status, year: m.Year || null, notes: m.Notes || null })),
    ...(F.marriages.some(m => m.SpouseID && (m.LinkKids || []).length)
      ? { link_children: F.marriages.filter(m => m.SpouseID && (m.LinkKids || []).length).map(m => ({ spouse_id: m.SpouseID, child_ids: m.LinkKids })) } : {}),
  };
}
function summarize(pl) {
  const n = pl.person.name, par = pl.parents[0], f = par && (P[par.father_id] || P[par.mother_id]);
  if (pl.person.id) return 'Edit ' + (P[pl.person.id] ? P[pl.person.id].Name : n);
  if (f) return 'Add ' + n + ' (child of ' + f.Name + ')';
  const sp = pl.marriages[0] && P[pl.marriages[0].spouse_id];
  const rel = pl.person.gender === 'F' ? 'wife' : pl.person.gender === 'M' ? 'husband' : 'spouse';
  return 'Add ' + n + (sp ? ' (' + rel + ' of ' + sp.Name + ')' : '');
}
async function save() {
  readForm();
  if (!F.person.Name) return toast('Name is required');
  if (dateErr(F.person)) return toast(dateErr(F.person), 3500);
  if (F.person.Phone && !/^\+?[0-9][0-9 ()-]{5,19}$/.test(F.person.Phone)) return toast('Mobile number should contain only digits (and an optional + country code)', 3500);
  const pl = payloadFromForm();
  try {
    if (can('editor')) {
      const id = await busy('Saving…', () => api.savePerson(S.treeId, pl));
      const fromTree = S.addFromTree; closeEdit();
      if (fromTree && S.tab === 'tree') { view.sel = id; await reload(); renderTree(false); requestAnimationFrame(() => centerOn(id, true)); toast('Added ' + pl.person.name); }
      else { await reload(); toast('Saved'); openProfile(id, !$('profOv').classList.contains('show')); }
    } else {
      await busy('Sending…', () => api.submitRequest(S.treeId, 'save_person', pl, summarize(pl)));
      closeEdit(); toast('Sent for approval ✓', 3000);
    }
  } catch {}
}
async function del() {
  if (!delArmed) { delArmed = true; $('delBtn').textContent = 'Tap again to confirm'; return; }
  const id = F.person.ID, name = P[id] && P[id].Name;
  try {
    if (can('editor')) {
      await busy('Deleting…', () => api.deletePerson(S.treeId, id));
      if (view.root === id) view.root = '__all';
      closeEdit(); closeProfile(); await reload(); toast('Deleted');
    } else {
      await busy('Sending…', () => api.submitRequest(S.treeId, 'delete_person', { id }, 'Delete ' + name));
      closeEdit(); toast('Deletion sent for approval ✓', 3000);
    }
  } catch {}
}
function addChild(id, otherId) {
  const p = P[id], o = P[otherId];
  const row = { FatherID: '', MotherID: '', Type: 'Biological' };
  if (p.Gender === 'F') { row.MotherID = id; row.FatherID = o ? o.ID : ''; } else { row.FatherID = id; row.MotherID = o ? o.ID : ''; }
  if (!otherId) { const ms = marriagesOf(id); if (ms.length === 1) { const s = spouseOf(ms[0], id); if (p.Gender === 'F') row.FatherID = s.ID; else row.MotherID = s.ID; } }
  const fam = (p.Gender === 'F' && o) ? o.Family : p.Family;
  openEdit('', { person: { Family: fam, Village: (p.Gender === 'F' && o) ? o.Village : p.Village }, parents: [row] });
}
function addChildFromTree(e, id) {
  e.stopPropagation(); if (moved) return;
  expandState[id] = true; S.addFromTree = true;
  addChild(id, '');
}
function addSpouse(id) {
  const p = P[id], g = p.Gender === 'M' ? 'F' : p.Gender === 'F' ? 'M' : '';
  openEdit('', { person: { Gender: g }, marriages: [{ SpouseID: id, Status: 'Current', Year: '' }] });
  F.marriages[0].LinkKids = freeKids(id); renderRelRows();      // default: all of their children without a mother/father yet
}
function addSpouseFromTree(e, id) { e.stopPropagation(); if (moved) return; S.addFromTree = true; addSpouse(id); }

// ============ Add parents (e.g. a wife's father & mother) ============
let PA = null;
const personFields = p => ({ id: p.ID, name: p.Name, gender: p.Gender || null, birth_year: p.BirthYear || null, death_year: p.DeathYear || null, family: p.Family || null, village: p.Village || null, notes: p.Notes || null, phone: p.Phone || null });
function bioRow(id) { return parentRows(id).find(r => r.Type !== 'Adopted'); }
function openParents(id, fromTree) {
  if (!can('contributor')) return;
  const p = P[id], r = bioRow(id);
  PA = { id, fromTree: !!fromTree, hasF: r && P[r.FatherID] ? r.FatherID : '', hasM: r && P[r.MotherID] ? r.MotherID : '', f: { id: '', name: '' }, m: { id: '', name: '' } };
  $('parTitle').textContent = (can('editor') ? 'Add parents of ' : 'Suggest parents of ') + p.Name;
  $('parNote').hidden = can('editor'); $('parNote').textContent = 'Your suggestion will be sent to the tree editors for approval.';
  $('parSave').textContent = can('editor') ? 'Save' : 'Send for approval';
  $('parFamily').value = p.Family || ''; $('parVillage').value = p.Village || '';
  renderParents();
  $('parOv').classList.add('show');
}
function slotHtml(key, label) {
  const has = key === 'f' ? PA.hasF : PA.hasM, v = PA[key];
  if (has) return '<div class="pslot"><div class="chosen">' + esc(P[has].Name) + ' <span class="tagline">already recorded</span></div></div>';
  if (v.id) return '<div class="pslot"><div class="chosen">' + esc(label(P[v.id])) + '</div><button class="x" onclick="App.parClear(\'' + key + '\')">✕</button></div>';
  return '<div class="pslot"><input id="par_' + key + '" placeholder="' + (key === 'f' ? 'Father’s name' : 'Mother’s name') + '" value="' + esc(v.name) + '" oninput="App.parName(\'' + key + '\', this.value)"></div>' +
    '<button class="btn sm ghost" style="margin-top:6px" onclick="App.parPick(\'' + key + '\')">or choose someone already in the tree</button>';
}
function renderParents() {
  $('parF').innerHTML = slotHtml('f', label);
  $('parM').innerHTML = slotHtml('m', label);
  $('parFamWrap').hidden = !!(PA.hasF || PA.f.id);
}
function parPick(key) {
  pick(key === 'f' ? 'Choose father' : 'Choose mother', p => p.ID !== PA.id && (key === 'f' ? p.Gender !== 'F' : p.Gender !== 'M'), id => { if (id) { PA[key] = { id, name: '' }; renderParents(); } });
}
function closeParents() { $('parOv').classList.remove('show'); }
async function saveParents() {
  const np = {};
  if (!PA.hasF) { if (PA.f.id) np.father_id = PA.f.id; else if (PA.f.name.trim()) np.father = { name: PA.f.name.trim(), family: $('parFamily').value.trim() || null, village: $('parVillage').value.trim() || null }; }
  if (!PA.hasM) { if (PA.m.id) np.mother_id = PA.m.id; else if (PA.m.name.trim()) np.mother = { name: PA.m.name.trim(), village: $('parVillage').value.trim() || null }; }
  if (!Object.keys(np).length) return toast('Enter the father or the mother');
  const child = P[PA.id], pl = { person: personFields(child), new_parents: np };
  try {
    if (can('editor')) {
      await busy('Saving…', () => api.savePerson(S.treeId, pl));
      closeParents(); view.sel = PA.id; await reload();
      if (PA.fromTree && S.tab === 'tree') { renderTree(false); requestAnimationFrame(() => centerOn(PA.id, true)); }
      else if ($('profOv').classList.contains('show')) openProfile(PA.id);
      toast('Parents added for ' + child.Name);
    } else {
      await busy('Sending…', () => api.submitRequest(S.treeId, 'save_person', pl, 'Add parents of ' + child.Name));
      closeParents(); toast('Sent for approval ✓', 3000);
    }
  } catch {}
}
// jump to a person's own (birth) family tree, e.g. a wife's parents' family
function openFamily(e, id) {
  if (e) { e.stopPropagation(); if (moved) return; }
  closeProfile(); tab('tree');
  navigate({ mode: view.mode === 'anc' ? savedMode() : view.mode, root: topAncestor(id), sel: id });
}
function goUp(e, id) {
  e.stopPropagation(); if (moved) return;
  const r = socialParents(id), up = r && (P[r.FatherID] ? r.FatherID : r.MotherID);
  if (up) { expandState[up] = true; navigate({ root: up, sel: id }); }
}
function toggleChain(e, id) { e.stopPropagation(); if (moved) return; expandState['chain:' + id] = true; renderTree(false); }

// ============ Tree ============
function navigate(v) { hist.push(Object.assign({}, view)); if (hist.length > 50) hist.shift(); view = Object.assign({}, view, v); renderTree(true); }
function back() { const v = hist.pop(); if (!v) return toast('Nothing to go back to'); view = v; renderTree(true); }
function setMode(m) {
  if (m === 'anc') {
    const target = view.sel || (view.root !== '__all' ? view.root : '');
    if (!P[target]) return toast('Pick a person first — tap a card or use Find');
    navigate({ mode: 'anc', root: target, sel: target });
  } else {
    store.set('treeMode', m);
    if (m === 'explore' && view.mode !== 'explore') { expandState = {}; S.expandAll = false; }
    navigate({ mode: m, root: view.mode === 'anc' ? topAncestor(view.root) : view.root });
  }
}
function topAncestor(id) {
  const seen = new Set(); let cur = id;
  while (cur && !seen.has(cur)) { seen.add(cur); const r = socialParents(cur), up = r && (P[r.FatherID] ? r.FatherID : P[r.MotherID] ? r.MotherID : ''); if (!up) break; cur = up; }
  return cur;
}
function founders() { return S.DB.people.filter(p => !parentRows(p.ID).length && !(p.Gender === 'F' && marriagesOf(p.ID).length)); }
// family list label: the gotra (if recorded), else the founder's name; repeated gotras also show the founder
function famLabel(f, fs) {
  const g = (f.p.Family || '').trim();
  if (!g) return f.p.Name + ' family';
  const dup = fs.filter(x => x.n > 1 && (x.p.Family || '').trim().toLowerCase() === g.toLowerCase()).length > 1;
  return g + (dup ? ' · ' + f.p.Name : '') + (f.p.Village ? ' · ' + f.p.Village : '');
}
function inLaw(rootId, fs) {   // linked to a bigger family only through marriage
  const big = fs[0] && fs[0].p.ID !== rootId ? lineage(fs[0].p.ID) : null;
  return !!big && [...lineage(rootId)].some(x => marriagesOf(x).some(m => big.has(spouseOf(m, x).ID)));
}
function lineage(id) {   // a person and all their descendants (not spouses)
  const out = new Set(), st = [id];
  while (st.length) { const x = st.pop(); if (out.has(x)) continue; out.add(x); (PRP[x] || []).forEach(r => st.push(r.ChildID)); }
  return out;
}
function descCount(id) {
  const seen = new Set(), st = [id];
  while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); (PRP[x] || []).forEach(r => st.push(r.ChildID)); marriagesOf(x).forEach(m => (PRP[spouseOf(m, x).ID] || []).forEach(r => st.push(r.ChildID))); }
  return seen.size;
}
// ancestors (and spouses' ancestors) of the selected person must stay open so it is visible
function pathSet(id) {
  const out = new Set(), st = [id];
  marriagesOf(id).forEach(m => st.push(spouseOf(m, id).ID));
  while (st.length) { const x = st.pop(); if (!x || out.has(x)) continue; out.add(x); parentRows(x).forEach(r => { st.push(r.FatherID); st.push(r.MotherID); }); }
  return out;
}
const DEFAULT_BRANCH_DEPTH = 3;
function isOpen(id, bdepth, ctx) {
  if (id in expandState) return expandState[id];
  if (ctx.expandAll) return true;
  if (ctx.explore) return ctx.path.has(id) && id !== view.sel;
  return bdepth < DEFAULT_BRANCH_DEPTH || ctx.path.has(id);
}

function box(p, o = {}) {
  const cls = ['node', p.Gender, isDead(p) ? 'dead' : '', o.main ? 'main' : '', o.spouse ? 'sp' : '', o.ended ? 'ended' : '', o.adopted ? 'adopt' : '', view.sel === p.ID ? 'sel' : ''].filter(Boolean).join(' ');
  return '<div class="' + cls + '" data-id="' + esc(p.ID) + '" onclick="App.tapNode(event,\'' + esc(p.ID) + '\')">' +
    (o.badge ? '<span class="badge2">' + o.badge + '</span>' : '') + '<span class="nm">' + esc(p.Name) + deadMark(p) + '</span>' +
    ((years(p, true) || o.note) ? '<small>' + esc([years(p, true), o.note].filter(Boolean).join(' · ')) + '</small>' : '') + '</div>';
}
const refLi = (p, note) => '<li><div class="node ref" onclick="App.focusNode(event,\'' + esc(p.ID) + '\')">↪ ' + esc(p.Name) + '<small>' + esc(note) + '</small></div></li>';

function descHtml(p, ctx, tag = {}, bdepth = 0) {
  if (ctx.seen.has(p.ID)) return refLi(p, 'shown elsewhere');
  ctx.seen.add(p.ID);
  const ms = marriagesOf(p.ID), multi = ms.length > 1;
  // couple card: the family member on top, spouse(s) inside the same card underneath
  let head = box(p, { main: true, badge: tag.badge, adopted: tag.adopted, note: tag.adopted ? 'adopted' : '' });
  ms.forEach((m, i) => {
    const sp = spouseOf(m, p.ID);
    head += '<div class="sp-row' + (ended(m) ? ' ended' : '') + '" title="' + esc(ended(m) ? m.Status : 'Spouse') + '"><span class="heart' + (ended(m) ? ' ended' : '') + '">♥' + (multi ? i + 1 : '') + '</span>' +
      box(sp, { spouse: true, ended: ended(m), note: [sp.Family && sp.Family !== p.Family ? sp.Family : '', sp.Village && sp.Village !== p.Village ? sp.Village : '', ended(m) ? (m.Status === 'Ended (death)' ? 'late' : 'separated') : ''].filter(Boolean).join(' · ') }) +
      (parentRows(sp.ID).length ? '<button class="sp-act" title="Open ' + esc(sp.Name) + '’s birth family" onclick="App.openFamily(event,\'' + esc(sp.ID) + '\')">↗ family</button>'
        : (ctx.explore && can('contributor') ? '<button class="sp-act" onclick="App.openParents(\'' + esc(sp.ID) + '\', true, event)">+ parents</button>' : '')) + '</div>';
  });
  const idx = {}; ms.forEach((m, i) => (idx[spouseOf(m, p.ID).ID] = { m, i }));
  const deferred = new Set();
  if (ctx.all && p.Gender === 'F') ms.forEach(m => { if (m.HusbandID !== p.ID && !ctx.seen.has(m.HusbandID) && ctx.willDraw && ctx.willDraw.has(m.HusbandID)) deferred.add(m.ID); });
  const already = new Set(ms.filter(m => ctx.doneM.has(m.ID) || deferred.has(m.ID)).map(m => m.ID));
  ms.forEach(m => { if (!deferred.has(m.ID)) ctx.doneM.add(m.ID); });
  const kids = [], refs = new Set(), dedupe = new Set();
  (PRP[p.ID] || []).slice().sort((a, b) => byBirth(P[a.ChildID], P[b.ChildID])).forEach(r => {
    if (dedupe.has(r.ChildID)) return;
    const other = r.FatherID === p.ID ? r.MotherID : r.FatherID, mi = idx[other];
    if (mi && already.has(mi.m.ID)) { refs.add(other); return; }
    dedupe.add(r.ChildID);
    const adoptRow = r.Type !== 'Adopted' && parentRows(r.ChildID).find(x => x.Type === 'Adopted' && (P[x.FatherID] || P[x.MotherID]));
    if (adoptRow) { kids.push({ ref: P[r.ChildID], note: 'adopted by ' + (P[adoptRow.FatherID] || P[adoptRow.MotherID]).Name }); return; }
    kids.push({ c: P[r.ChildID], tag: { badge: multi && mi ? mi.i + 1 : 0, adopted: r.Type === 'Adopted' } });
  });
  const branching = kids.length + refs.size > 1;
  const childDepth = bdepth + (branching ? 1 : 0);
  let inner = '', toggle = '';
  const n = kids.length + refs.size;
  if (n) {
    const open = isOpen(p.ID, bdepth, ctx);
    if (open) {
      const chain = kids.length === 1 && !refs.size && kids[0].c ? foldChain(p.ID, kids[0].c, ctx) : null;
      inner = chain ? chain : kids.map(k => k.ref ? refLi(k.ref, k.note) : descHtml(k.c, ctx, k.tag, childDepth)).join('') + [...refs].map(s => refLi(P[s], 'children shown under ' + P[s].Name)).join('');
    }
    else kids.forEach(k => k.c && markSeen(k.c.ID, ctx));
    toggle = '<button class="toggle" title="' + (open ? 'Hide this branch' : 'Show this branch') + '" onclick="App.toggle(event,\'' + esc(p.ID) + '\',' + (open ? 'false' : 'true') + ')">' +
      (open ? '▾' : '▸ ' + (descCount(p.ID) - 1) + (ctx.explore ? '' : ' more')) + '</button>';
  }
  if (ctx.explore && can('contributor'))
    toggle += '<button class="addkid" title="' + (can('editor') ? 'Add a child' : 'Suggest a child') + '" onclick="App.addChildFromTree(event,\'' + esc(p.ID) + '\')">+ child</button>' +
      '<button class="addkid alt" onclick="App.addSpouseFromTree(event,\'' + esc(p.ID) + '\')">+ ' + (p.Gender === 'F' ? 'husband' : p.Gender === 'M' ? 'wife' : 'spouse') + '</button>' +
      (!parentRows(p.ID).length ? '<button class="addkid alt" onclick="App.openParents(\'' + esc(p.ID) + '\', true, event)">+ parents</button>' : '');
  if (toggle) toggle = '<div class="node-actions">' + toggle + '</div>';
  let up = '';
  if (ctx.rootId === p.ID && socialParents(p.ID)) {
    const r = socialParents(p.ID), par = P[r.FatherID] || P[r.MotherID];
    if (par) up = '<button class="upbtn" onclick="App.goUp(event,\'' + esc(p.ID) + '\')">▲ ' + esc(par.Name) + (parentRows(par.ID).length ? ' & above' : '') + '</button>';
  }
  return '<li' + (tag.adopted ? ' class="adopted"' : '') + '>' + up + '<div class="couple' + (ms.length ? ' has-spouse' : '') + '">' + head + '</div>' + toggle + (inner ? '<ul>' + inner + '</ul>' : '') + '</li>';
}
// A run of single-child, unmarried generations (e.g. 12 forefathers in a line) folds into one card.
function foldChain(fromId, first, ctx) {
  if (expandState['chain:' + fromId]) return null;
  const run = []; let cur = first;
  const onlyChild = x => { const ks = [...new Set((PRP[x.ID] || []).map(r => r.ChildID))]; return ks.length === 1 && !marriagesOf(x.ID).length && !(PRP[x.ID][0].Type === 'Adopted') ? P[ks[0]] : null; };
  while (cur && !ctx.seen.has(cur.ID) && view.sel !== cur.ID && onlyChild(cur)) { run.push(cur); cur = onlyChild(cur); }
  if (S.expandAll) return null;
  if (run.length < 3 || !cur) return null;
  run.forEach(x => ctx.seen.add(x.ID));
  const names = run.length > 4 ? run[0].Name + ' … ' + run[run.length - 1].Name : run.map(x => x.Name).join(' → ');
  return '<li><div class="node chain" title="Tap to show every generation" onclick="App.toggleChain(event,\'' + esc(fromId) + '\')">⋮ ' + run.length + ' generations<small>' + esc(names) + '</small></div>' +
    '<ul>' + descHtml(cur, ctx, {}, 0) + '</ul></li>';
}
// collapsed branches: mark their people as placed so whole-village view does not redraw them as roots
function markSeen(id, ctx) { if (ctx.seen.has(id)) return; ctx.seen.add(id); marriagesOf(id).forEach(m => ctx.doneM.add(m.ID)); (PRP[id] || []).forEach(r => markSeen(r.ChildID, ctx)); }

function ancHtml(p, seen, depth, note, partner) {
  if (seen.has(p.ID)) return refLi(p, 'appears again');
  seen.add(p.ID);
  let inner = '';
  if (depth < 40) {
    if (S.ancBoth) parentRows(p.ID).forEach(r => { const tag = r.Type === 'Adopted' ? 'adoptive' : ''; [r.FatherID, r.MotherID].forEach(x => { if (P[x]) inner += ancHtml(P[x], seen, depth + 1, tag); }); });
    else {   // father's line: each generation is the father, with the mother shown inside his card
      const r = socialParents(p.ID);
      if (r && P[r.FatherID]) inner = ancHtml(P[r.FatherID], seen, depth + 1, r.Type === 'Adopted' ? 'adoptive' : '', P[r.MotherID]);
      else if (r && P[r.MotherID]) inner = ancHtml(P[r.MotherID], seen, depth + 1, r.Type === 'Adopted' ? 'adoptive' : '');
    }
  }
  const sp = partner ? '<div class="sp-row"><span class="heart">♥</span>' + box(partner, { spouse: true, note: partner.Family && partner.Family !== p.Family ? partner.Family : '' }) +
    (parentRows(partner.ID).length ? '<button class="sp-act" onclick="App.openFamily(event,\'' + esc(partner.ID) + '\')">↗ family</button>' : '') + '</div>' : '';
  return '<li' + (note ? ' class="adopted"' : '') + '><div class="couple' + (sp ? ' has-spouse' : '') + '">' + box(p, { main: true, adopted: !!note, note }) + sp + '</div>' + (inner ? '<ul>' + inner + '</ul>' : '') + '</li>';
}

function renderTree(recenter) {
  const fs = founders().map(p => ({ p, n: descCount(p.ID) })).sort((a, b) => b.n - a.n);
  let opts = '<option value="__all">🌐 Everyone (' + S.DB.people.length + ')</option>' +
    fs.filter(f => f.n > 1).map(f => '<option value="' + esc(f.p.ID) + '">' + esc(famLabel(f, fs) + ' (' + f.n + ')' + (inLaw(f.p.ID, fs) ? ' · in-laws' : '')) + '</option>').join('');
  if (view.root !== '__all' && !P[view.root]) view.root = '__all';
  if (view.mode === 'anc' && !P[view.root]) view.mode = 'desc';
  if (view.root !== '__all' && !fs.some(f => f.p.ID === view.root && f.n > 1))
    opts += '<option value="' + esc(view.root) + '">' + esc((view.mode === 'anc' ? 'Ancestors of ' : 'From ') + P[view.root].Name) + '</option>';
  $('rootSel').innerHTML = opts; $('rootSel').value = view.root;
  $('ancSides').hidden = view.mode !== 'anc';
  $('ancMale').classList.toggle('on', !S.ancBoth); $('ancBoth').classList.toggle('on', !!S.ancBoth);
  $('mDesc').classList.toggle('on', view.mode === 'desc'); $('mExp').classList.toggle('on', view.mode === 'explore'); $('mAnc').classList.toggle('on', view.mode === 'anc');
  $('legend').textContent = view.mode === 'explore' ? 'Tap ▸ to open the next generation · + child to add someone right there · drag to move, pinch to zoom'
    : 'Drag to move · pinch or +/− to zoom · tap ▸ to open a branch · ♥1 ♥2 marriages · dashed = adopted · ↪ shown elsewhere';
  if ($('pTree').hidden) return;

  let html = '';
  if (!S.DB.people.length) html = '<div class="empty">No people yet.</div>';
  else if (view.mode === 'anc') html = '<ul>' + ancHtml(P[view.root], new Set(), 0, '') + '</ul>';
  else {
    const all = view.root === '__all';
    const ctx = { seen: new Set(), doneM: new Set(), all, path: view.sel ? pathSet(view.sel) : new Set(), expandAll: S.expandAll, explore: view.mode === 'explore', rootId: all ? null : view.root };
    const roots = all ? fs.map(f => f.p) : [P[view.root]];
    // Decide first which families get drawn: a smaller family linked to one already drawn only by
    // marriage is in-laws (e.g. a wife's parents) and opens from ↗ family instead.
    const placed = new Set(), hidden = new Set(), draw = [];
    // hide an in-law family: its blood members and the people married into it
    const hide = L => L.forEach(x => { if (placed.has(x)) return; hidden.add(x); marriagesOf(x).forEach(m => { const sp = spouseOf(m, x).ID; if (!placed.has(sp)) hidden.add(sp); }); });
    roots.forEach(r => {
      if (!all) { draw.push(r); return; }
      const L = lineage(r.ID);
      if ([...L].some(x => placed.has(x))) { hide(L); return; }   // shares descendants with a drawn family = in-laws
      if ([...L].some(x => marriagesOf(x).some(m => placed.has(spouseOf(m, x).ID)))) { hide(L); return; }
      L.forEach(x => placed.add(x)); draw.push(r);
    });
    ctx.willDraw = all ? placed : null;
    draw.forEach(r => {
      if (ctx.seen.has(r.ID)) return;
      const ms = marriagesOf(r.ID); if (all && ms.length && ms.every(m => ctx.doneM.has(m.ID))) return;
      html += descHtml(r, ctx);
    });
    if (all) S.DB.people.slice().sort(byBirth).forEach(p => { if (ctx.seen.has(p.ID) || hidden.has(p.ID)) return; if (marriagesOf(p.ID).some(m => ctx.seen.has(spouseOf(m, p.ID).ID))) return; html += descHtml(p, ctx); });
    html = '<ul>' + html + '</ul>';
  }
  $('treeBox').innerHTML = html;
  if (S.picked && S.picked.size) paintPicked();
  applyPan();
  requestAnimationFrame(() => {
    if (view.sel && nodeEl(view.sel)) { if (recenter) centerOn(view.sel, true); }
    else if (recenter) fit();
  });
}

// ---- pan & zoom
function applyPan() { $('treeBox').style.transform = 'translate(' + pan.x + 'px,' + pan.y + 'px) scale(' + pan.s + ')'; }
function zoomAt(f, cx, cy) {
  const ns = Math.min(2.5, Math.max(0.15, pan.s * f)); f = ns / pan.s;
  pan.x = cx - (cx - pan.x) * f; pan.y = cy - (cy - pan.y) * f; pan.s = ns; applyPan();
}
function zoomBy(f) { const r = $('treeWrap').getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); }
function fit() {
  const w = $('treeWrap'), b = $('treeBox'), W = w.clientWidth, H = w.clientHeight;
  const bw = b.scrollWidth, bh = b.scrollHeight;
  // fit the width (tall family chains are fine to scroll), but never so small it can't be read
  pan.s = Math.max(0.45, Math.min(1, W / bw)); pan.x = bw * pan.s <= W ? (W - bw * pan.s) / 2 : W / 2 - (bw * pan.s) / 2; pan.y = 8; applyPan();
}
function centerOn(id, flash) {
  const el = nodeEl(id); if (!el) return false;
  const w = $('treeWrap').getBoundingClientRect(), r = el.getBoundingClientRect();
  if (pan.s < 0.6) { zoomAt(0.9 / pan.s, r.left + r.width / 2 - w.left, r.top + r.height / 2 - w.top); }
  const r2 = el.getBoundingClientRect();
  pan.x += (w.left + w.width / 2) - (r2.left + r2.width / 2); pan.y += (w.top + w.height / 3) - (r2.top + r2.height / 2); applyPan();
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  return true;
}
let drag = null, moved = false;
function setupPan() {
  const w = $('treeWrap'), pts = new Map();
  w.addEventListener('pointerdown', e => { pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = false; drag = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; });
  w.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()], r = w.getBoundingClientRect();
      const other = [...pts.entries()].find(([k]) => k !== e.pointerId)[1];
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y), d1 = Math.hypot(a.x - b.x, a.y - b.y);
      if (d0 > 0) zoomAt(d1 / d0, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
      moved = true; return;
    }
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 6) return;
    if (!moved) { moved = true; w.setPointerCapture(e.pointerId); w.classList.add('dragging'); }
    pan.x = drag.px + dx; pan.y = drag.py + dy; applyPan();
  });
  const end = e => { pts.delete(e.pointerId); if (!pts.size) { drag = null; w.classList.remove('dragging'); } else { const p = [...pts.values()][0]; drag = { x: p.x, y: p.y, px: pan.x, py: pan.y }; } };
  w.addEventListener('pointerup', end); w.addEventListener('pointercancel', end);
  w.addEventListener('wheel', e => {
    e.preventDefault(); const r = w.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 40 && !e.shiftKey && Math.abs(e.deltaX) < 2) zoomAt(Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top);
    else { pan.x -= e.deltaX; pan.y -= e.deltaY; applyPan(); }
  }, { passive: false });
}
const nodeEl = id => $('treeBox').querySelector('.node.main[data-id="' + CSS.escape(id) + '"]') || $('treeBox').querySelector('.node[data-id="' + CSS.escape(id) + '"]');
function markSel() {
  document.querySelectorAll('#treeBox .node.sel').forEach(e => e.classList.remove('sel'));
  document.querySelectorAll('#treeBox .node[data-id="' + CSS.escape(view.sel) + '"]').forEach(e => e.classList.add('sel'));
}
function tapNode(e, id) { if (moved) return; if (S.selectMode) return togglePick(id); view.sel = id; markSel(); openProfile(id, true); }

// ============ Multi-select & bulk edit ============
S.selectMode = false; S.picked = new Set();
function toggleSelect() {
  S.selectMode = !S.selectMode;
  if (!S.selectMode) S.picked.clear();
  $('selBtn').classList.toggle('on', S.selectMode);
  $('treeWrap').classList.toggle('selecting', S.selectMode);
  paintPicked(); updateSelBar();
  if (S.selectMode) toast('Tap people to select them', 1800);
}
function togglePick(id) { S.picked.has(id) ? S.picked.delete(id) : S.picked.add(id); paintPicked(); updateSelBar(); }
function clearPicked() { S.picked.clear(); paintPicked(); updateSelBar(); }
function paintPicked() { document.querySelectorAll('#treeBox .node[data-id]').forEach(el => el.classList.toggle('picked', S.picked.has(el.dataset.id))); }
function updateSelBar() {
  $('selBar').hidden = !(S.selectMode && S.tab === 'tree');
  const n = S.picked.size;
  $('selCount').textContent = n ? n + ' selected' : 'Tap people to select';
  $('selEdit').disabled = !n;
  $('selEdit').textContent = n === 1 ? 'Quick edit' : n ? 'Edit ' + n : 'Edit';
}
const BULK_FIELDS = [['Name', 'Name'], ['Gender', 'Gender'], ['BirthYear', 'Birth'], ['DeathYear', 'Death'], ['Family', 'Family / Gotra'], ['Village', 'Village'], ['Phone', 'Mobile']];
function openBulk() {
  const ids = [...S.picked].filter(id => P[id]); if (!ids.length) return;
  const direct = can('editor');
  $('bulkTitle').textContent = ids.length === 1 ? (direct ? 'Quick edit' : 'Suggest a change') : (direct ? 'Edit ' : 'Suggest changes to ') + ids.length + ' people';
  $('bulkNote').hidden = direct; $('bulkSave').textContent = direct ? 'Save' : 'Send for approval';
  $('applyAll').hidden = ids.length < 2; $('allFamily').value = ''; $('allVillage').value = ''; $('allGender').value = '';
  $('bulkRows').innerHTML = ids.map(id => {
    const p = P[id], f = k => 'data-id="' + esc(id) + '" data-k="' + k + '" oninput="App.bulkDirty(this)"';
    return '<div class="brow" id="br_' + esc(id) + '"><div class="who">' + esc(relOf(p) || 'In the tree') + '</div>' +
      '<input ' + f('Name') + ' value="' + esc(p.Name) + '" placeholder="Name">' +
      '<div class="row2"><select ' + f('Gender') + ' onchange="App.bulkDirty(this)"><option value="">—</option><option value="M"' + (p.Gender === 'M' ? ' selected' : '') + '>Male</option><option value="F"' + (p.Gender === 'F' ? ' selected' : '') + '>Female</option></select>' +
      '<input ' + f('BirthYear') + ' inputmode="numeric" placeholder="Birth" value="' + esc(p.BirthYear) + '"><input ' + f('DeathYear') + ' inputmode="numeric" placeholder="Death" value="' + esc(p.DeathYear) + '"></div>' +
      '<div class="row2"><input ' + f('Family') + ' placeholder="Family / Gotra" value="' + esc(p.Family) + '"><input ' + f('Village') + ' placeholder="Village" value="' + esc(p.Village) + '"></div>' +
      '<div class="row2"><input ' + f('Phone') + ' type="tel" inputmode="tel" placeholder="Mobile" value="' + esc(p.Phone) + '"></div></div>';
  }).join('');
  $('bulkOv').classList.add('show');
  if (ids.length === 1) setTimeout(() => $('bulkRows').querySelector('input').focus(), 60);
}
function closeBulk() { $('bulkOv').classList.remove('show'); }
function bulkRead() {
  const out = {};
  $('bulkRows').querySelectorAll('[data-id]').forEach(el => { (out[el.dataset.id] = out[el.dataset.id] || {})[el.dataset.k] = el.value.trim(); });
  return out;
}
function bulkDirty(el) {
  const id = el.dataset.id, v = bulkRead()[id], p = P[id];
  $('br_' + id).classList.toggle('changed', BULK_FIELDS.some(([k]) => String(v[k] ?? '') !== String(p[k] ?? '')));
}
function applyAll() {
  const fam = $('allFamily').value.trim(), vil = $('allVillage').value.trim(), g = $('allGender').value;
  if (!fam && !vil && !g) return toast('Type a family or village, or choose a gender to apply');
  $('bulkRows').querySelectorAll('[data-k="Village"]').forEach(el => { if (vil) { el.value = vil; bulkDirty(el); } });
  $('bulkRows').querySelectorAll('[data-k="Family"]').forEach(el => { if (fam) { el.value = fam; bulkDirty(el); } });
  $('bulkRows').querySelectorAll('[data-k="Gender"]').forEach(el => { if (g) { el.value = g; bulkDirty(el); } });
}
async function saveBulk() {
  const vals = bulkRead(), people = [];
  for (const [id, v] of Object.entries(vals)) {
    const p = P[id];
    if (!BULK_FIELDS.some(([k]) => String(v[k] ?? '') !== String(p[k] ?? ''))) continue;
    if (!v.Name) return toast('Name can’t be empty');
    if (v.Phone && !/^\+?[0-9][0-9 ()-]{5,19}$/.test(v.Phone)) return toast('Check the mobile number for ' + v.Name, 3500);
    people.push({ ...personFields(p), name: v.Name, gender: v.Gender || null, birth_year: v.BirthYear || null, death_year: v.DeathYear || null, family: v.Family || null, village: v.Village || null, phone: v.Phone || null });
  }
  if (!people.length) return toast('Nothing changed');
  try {
    if (can('editor')) {
      const n = await busy('Saving…', () => api.savePeople(S.treeId, { people }));
      closeBulk(); clearPicked(); await reload(); toast('Updated ' + n + (n === 1 ? ' person' : ' people'));
    } else {
      await busy('Sending…', () => api.submitRequest(S.treeId, 'save_people', { people }, 'Edit ' + people.length + ' ' + (people.length === 1 ? 'person' : 'people') + ': ' + people.map(x => x.name).slice(0, 4).join(', ') + (people.length > 4 ? '…' : '')));
      closeBulk(); clearPicked(); toast('Sent for approval ✓', 3000);
    }
  } catch {}
}
function toggle(e, id, open) { e.stopPropagation(); if (moved) return; expandState[id] = open; S.expandAll = false; renderTree(false); }
function expandAll(on) { expandState = {}; S.expandAll = on; renderTree(false); requestAnimationFrame(fit); }
function focusNode(e, id) {
  if (e && moved) return;
  view.sel = id;
  if ($('treeBox').querySelector('.node.main[data-id="' + CSS.escape(id) + '"]')) { markSel(); centerOn(id, true); return; }
  if (parentRows(id).length || (PRP[id] || []).length) return openFamily(null, id);   // their own family tree
  showInTree(id);
}
function showInTree(id) {
  closeProfile(); tab('tree');
  const m = view.mode === 'anc' ? savedMode() : view.mode;
  if (view.mode !== 'anc' && $('treeBox').querySelector('.node.main[data-id="' + CSS.escape(id) + '"]')) { view.sel = id; markSel(); centerOn(id, true); return; }
  navigate({ mode: m, root: '__all', sel: id });
  if (!$('treeBox').querySelector('.node.main[data-id="' + CSS.escape(id) + '"]') && !$('treeBox').querySelector('.node[data-id="' + CSS.escape(id) + '"]'))
    navigate({ mode: m, root: topAncestor(id), sel: id });
}
function findInTree() { pick('Find in tree', null, id => { if (id) showInTree(id); }); }

// ============ Requests inbox ============
function personName(id) { return (P[id] && P[id].Name) || '(not in tree yet)'; }
function describePayload(r) {
  if (r.kind === 'save_people') {
    const lbl = { name: 'Name', gender: 'Gender', birth_year: 'Birth', death_year: 'Death', family: 'Family', village: 'Village', phone: 'Mobile' }, ok = { name: 'Name', gender: 'Gender', birth_year: 'BirthYear', death_year: 'DeathYear', family: 'Family', village: 'Village', phone: 'Phone' };
    return '<div class="diff">' + (r.payload.people || []).map(np => {
      const old = P[np.id], ch = Object.keys(lbl).filter(k => String(np[k] ?? '') !== String(old ? old[ok[k]] ?? '' : ''));
      return '<div><b>' + esc(old ? old.Name : np.name) + '</b>: ' + (ch.length ? ch.map(k => lbl[k] + ' ' + (old && old[ok[k]] ? '<span class="old">' + esc(old[ok[k]]) + '</span> → ' : '') + '<span class="new">' + esc(np[k] ?? '(empty)') + '</span>').join(', ') : '<span class="muted">no change</span>') + '</div>';
    }).join('') + '</div>';
  }
  if (r.kind === 'delete_person') {
    const p = P[r.payload.id];
    return '<div class="diff">Remove <b>' + esc(p ? label(p) : 'a person who is no longer in the tree') + '</b> and their links.</div>';
  }
  const pl = r.payload, np = pl.person || {}, old = np.id ? P[np.id] : null;
  const fields = [['Name', 'name', 'Name'], ['Gender', 'gender', 'Gender'], ['Birth year', 'birth_year', 'BirthYear'], ['Death year', 'death_year', 'DeathYear'], ['Date of birth', 'birth_date', 'BirthDate'], ['Date of death', 'death_date', 'DeathDate'], ['Passed away', 'deceased', 'Deceased'], ['Family', 'family', 'Family'], ['Village', 'village', 'Village'], ['Mobile', 'phone', 'Phone'], ['Notes', 'notes', 'Notes']];
  let h = '<div class="diff">';
  fields.forEach(([lbl, k, ok]) => {
    const fv = v => v === true ? 'Yes' : (v === false || v == null) ? '' : String(v), nv = fv(np[k]), ov = old ? fv(old[ok]) : '';
    if (old && nv === ov) return;
    if (!nv && !ov) return;
    h += '<div>' + lbl + ': ' + (old && ov ? '<span class="old">' + esc(ov) + '</span> → ' : '') + '<span class="new">' + esc(nv || '(empty)') + '</span></div>';
  });
  const par = (pl.parents || []).map(x => (x.type === 'Adopted' ? 'adoptive ' : '') + [x.father_id && 'father ' + personName(x.father_id), x.mother_id && 'mother ' + personName(x.mother_id)].filter(Boolean).join(', ')).join('; ');
  const oldPar = old ? parentRows(old.ID).map(x => (x.Type === 'Adopted' ? 'adoptive ' : '') + [x.FatherID && 'father ' + personName(x.FatherID), x.MotherID && 'mother ' + personName(x.MotherID)].filter(Boolean).join(', ')).join('; ') : '';
  if (par !== oldPar && (par || oldPar)) h += '<div>Parents: ' + (oldPar ? '<span class="old">' + esc(oldPar) + '</span> → ' : '') + '<span class="new">' + esc(par || 'none') + '</span></div>';
  const mar = (pl.marriages || []).map(m => personName(m.spouse_id) + (m.status && m.status !== 'Current' ? ' (' + m.status + ')' : '')).join(', ');
  const oldMar = old ? marriagesOf(old.ID).map(m => spouseOf(m, old.ID).Name + (ended(m) ? ' (' + m.Status + ')' : '')).join(', ') : '';
  if (mar !== oldMar && (mar || oldMar)) h += '<div>Spouse: ' + (oldMar ? '<span class="old">' + esc(oldMar) + '</span> → ' : '') + '<span class="new">' + esc(mar || 'none') + '</span></div>';
  if (pl.new_parents) {
    const n = pl.new_parents, f = n.father_id ? personName(n.father_id) : n.father ? n.father.name + ' (new)' : '', m = n.mother_id ? personName(n.mother_id) : n.mother ? n.mother.name + ' (new)' : '';
    h += '<div>Add parents: <span class="new">' + esc([f && 'father ' + f, m && 'mother ' + m].filter(Boolean).join(', ')) + '</span></div>';
  }
  (pl.link_children || []).forEach(lc => { if ((lc.child_ids || []).length) h += '<div>Also ' + (np.gender === 'F' ? 'mother' : np.gender === 'M' ? 'father' : 'parent') + ' of: <span class="new">' + esc(lc.child_ids.map(personName).join(', ')) + '</span> <span class="muted">(children of ' + esc(personName(lc.spouse_id)) + ')</span></div>'; });
  if (h === '<div class="diff">') h += '<div class="muted">No visible changes.</div>';
  return h + '</div>';
}
async function renderInbox() {
  const box = $('inbox');
  box.innerHTML = '<div class="empty"><div class="spinner" style="margin:auto"></div></div>';
  try {
    const reqs = await api.listRequests(S.treeId);
    const me = S.user && S.user.id;
    const pending = reqs.filter(r => r.status === 'pending');
    let h = '';
    if (can('editor')) {
      h += '<div class="section"><h2>Waiting for approval</h2>' + (pending.length ? pending.map(r => reqCard(r, true)).join('') : '<div class="empty">Nothing to review 🎉</div>') + '</div>';
      const done = reqs.filter(r => r.status !== 'pending').slice(0, 30);
      if (done.length) h += '<div class="section"><h3>Recently reviewed</h3>' + done.map(r => reqCard(r, false)).join('') + '</div>';
      h += '<div class="section"><h3>Change history</h3><div id="historyBox"><button class="btn sm ghost" onclick="App.loadHistory()">Show recent changes</button></div></div>';
    } else {
      const mine = reqs.filter(r => r.requested_by === me);
      h += '<div class="section"><h2>Your suggestions</h2><p class="muted small">Editors review these before they appear in the tree.</p>' +
        (mine.length ? mine.map(r => reqCard(r, false, true)).join('') : '<div class="empty">You haven’t suggested any changes yet. Open a person and tap “Suggest edit”.</div>') + '</div>';
    }
    box.innerHTML = h;
    const ic = $('inboxCount'); ic.hidden = !(can('editor') && pending.length); ic.textContent = pending.length;
  } catch (e) { box.innerHTML = '<div class="empty">Could not load requests.</div>'; fail(e); }
}
function reqCard(r, actionable, mine) {
  return '<div class="req"><div class="head"><span class="title">' + esc(r.summary || (r.kind === 'delete_person' ? 'Delete person' : 'Change')) + '</span>' +
    '<span class="pill ' + r.status + '">' + r.status + '</span></div>' +
    '<div class="sub">by ' + esc(who(r.requester)) + ' · ' + ago(r.created_at) + (r.reviewer ? ' · reviewed by ' + esc(who(r.reviewer)) : '') + '</div>' +
    describePayload(r) + (r.review_note ? '<div class="sub">Note: ' + esc(r.review_note) + '</div>' : '') +
    (actionable ? '<div class="actions"><input id="note_' + r.id + '" placeholder="Note (optional)" style="flex:1"><button class="btn sm danger" onclick="App.review(\'' + r.id + '\', false)">Reject</button><button class="btn sm ok" onclick="App.review(\'' + r.id + '\', true)">Approve</button></div>' : '') +
    (mine && r.status === 'pending' ? '<div class="actions"><button class="btn sm ghost" onclick="App.cancelReq(\'' + r.id + '\')">Withdraw</button></div>' : '') + '</div>';
}
async function review(id, approve) {
  const note = ($('note_' + id) || {}).value || '';
  try { await busy(approve ? 'Approving…' : 'Rejecting…', () => api.reviewRequest(id, approve, note)); toast(approve ? 'Approved and added to the tree' : 'Rejected'); await reload(); renderInbox(); } catch {}
}
async function cancelReq(id) { try { await busy('Withdrawing…', () => api.cancelRequest(id)); renderInbox(); } catch {} }
async function loadHistory() {
  const box = $('historyBox'); box.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const rows = await api.history(S.treeId);
    box.innerHTML = rows.length ? rows.map(r => {
      const d = r.after || r.before || {};
      const what = r.entity === 'people' ? (d.name || '') : r.entity === 'marriages' ? 'marriage ' + personName(d.husband_id) + ' ♥ ' + personName(d.wife_id) : 'parents of ' + personName(d.child_id);
      return '<div class="member"><div class="grow"><b>' + esc(r.action) + '</b> ' + esc(what) + '<div class="sub">' + esc(who(r.who)) + ' · ' + ago(r.at) + '</div></div></div>';
    }).join('') : '<div class="muted">No changes recorded yet.</div>';
  } catch (e) { fail(e); }
}

// ============ Members (owners) ============
const ROLE_HELP = { viewer: 'can view', contributor: 'can suggest changes', editor: 'can edit & approve', owner: 'full control' };
const roleSelect = (cur, onchange) => '<select onchange="' + onchange + '">' + Object.keys(RANK).map(r => '<option value="' + r + '"' + (r === cur ? ' selected' : '') + '>' + r + '</option>').join('') + '</select>';
async function renderMembers() {
  const box = $('members');
  if (!can('owner')) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="empty"><div class="spinner" style="margin:auto"></div></div>';
  try {
    const [members, invites, reqs] = await Promise.all([api.members(S.treeId), api.invites(S.treeId), api.accessRequests(S.treeId)]);
    const link = location.origin + location.pathname + '?tree=' + S.treeId;
    let h = '<div class="section card"><h2>Invite family</h2><p class="muted small">Share this link. People who open it can sign in and ask to join; you approve them here.</p>' +
      '<div class="row"><input readonly value="' + esc(link) + '" id="shareLink"><button class="btn" onclick="App.share()">Share</button></div>' +
      '<p class="muted small" style="margin-top:12px">Or add someone directly by email — they get access as soon as they sign in.</p>' +
      '<form class="row" onsubmit="event.preventDefault(); App.invite()"><input id="invEmail" type="email" placeholder="email@gmail.com" required>' +
      '<select id="invRole" style="width:auto">' + Object.keys(RANK).map(r => '<option' + (r === 'viewer' ? ' selected' : '') + '>' + r + '</option>').join('') + '</select><button class="btn">Add</button></form></div>';
    if (reqs.length) h += '<div class="section"><h2>Asking to join</h2>' + reqs.map(r =>
      '<div class="req"><div class="head"><span class="title">' + esc(who(r.profile)) + '</span><span class="sub">' + esc(r.profile.email || '') + ' · ' + ago(r.created_at) + '</span></div>' +
      (r.message ? '<div class="diff">' + esc(r.message) + '</div>' : '') +
      '<div class="actions">Give access as <select id="ar_' + r.id + '" style="width:auto">' + Object.keys(RANK).map(x => '<option' + (x === 'viewer' ? ' selected' : '') + '>' + x + '</option>').join('') + '</select>' +
      '<span class="spacer"></span><button class="btn sm danger" onclick="App.reviewAccess(\'' + r.id + '\', false)">Decline</button><button class="btn sm ok" onclick="App.reviewAccess(\'' + r.id + '\', true)">Approve</button></div></div>').join('') + '</div>';
    h += '<div class="section"><h2>Members (' + members.length + ')</h2><p class="muted small">' + Object.entries(ROLE_HELP).map(([k, v]) => '<b>' + k + '</b> ' + v).join(' · ') + '</p>' +
      members.sort((a, b) => RANK[b.role] - RANK[a.role] || who(a.profile).localeCompare(who(b.profile))).map(m =>
        '<div class="member"><span class="av">' + (m.profile.avatar_url ? '<img src="' + esc(m.profile.avatar_url) + '" alt="">' : esc(initials(who(m.profile)))) + '</span>' +
        '<div class="grow"><div class="nm">' + esc(who(m.profile)) + (m.user_id === S.user.id ? ' (you)' : '') + '</div><div class="sub">' + esc(m.profile.email || '') + '</div></div>' +
        roleSelect(m.role, 'App.setRole(\'' + m.user_id + '\', this.value)') +
        (m.user_id === S.user.id ? '' : '<button class="x" title="Remove" onclick="App.removeMember(\'' + m.user_id + '\')">✕</button>') + '</div>').join('') + '</div>';
    if (invites.length) h += '<div class="section"><h3>Invited, not signed in yet</h3>' + invites.map(i =>
      '<div class="member"><span class="av">✉️</span><div class="grow"><div class="nm">' + esc(i.email) + '</div><div class="sub">' + esc(i.role) + ' · ' + ago(i.created_at) + '</div></div>' +
      '<button class="x" onclick="App.cancelInvite(\'' + esc(i.email) + '\')">✕</button></div>').join('') + '</div>';
    box.innerHTML = h;
    const mc = $('membersCount'); mc.hidden = !reqs.length; mc.textContent = reqs.length;
  } catch (e) { box.innerHTML = '<div class="empty">Could not load members.</div>'; fail(e); }
}
async function share() {
  const url = $('shareLink').value, text = 'Join our family tree “' + S.treeName + '”';
  try { if (navigator.share) { await navigator.share({ title: S.treeName, text, url }); return; } } catch { return; }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { $('shareLink').select(); toast('Copy the link above'); }
}
async function invite() {
  const email = $('invEmail').value.trim(), role = $('invRole').value;
  try { const r = await busy('Adding…', () => api.invite(S.treeId, email, role)); toast(r === 'added' ? 'Added — they can open the tree now' : 'Invited — access starts when they sign in', 3000); renderMembers(); } catch {}
}
async function cancelInvite(email) { try { await busy('Removing…', () => api.cancelInvite(S.treeId, email)); renderMembers(); } catch {} }
async function setRole(user, role) { try { await busy('Updating…', () => api.setRole(S.treeId, user, role)); toast('Role updated'); } catch { renderMembers(); } }
async function removeMember(user) { if (!window.confirm('Remove this member from the tree?')) return; try { await busy('Removing…', () => api.removeMember(S.treeId, user)); renderMembers(); } catch {} }
async function reviewAccess(id, approve) {
  const role = ($('ar_' + id) || {}).value || 'viewer';
  try { await busy(approve ? 'Approving…' : 'Declining…', () => api.reviewAccess(id, approve, role)); toast(approve ? 'Approved as ' + role : 'Declined'); renderMembers(); } catch {}
}

// ============ Auth / tree actions ============
async function signInGoogle() { try { await api.signInGoogle(); } catch (e) { fail(e); } }
async function signInEmail() {
  const email = $('email').value.trim(); if (!email) return;
  try { await busy('Sending link…', () => api.signInEmail(email)); $('signinMsg').textContent = 'Check ' + email + ' for a sign-in link. Open it on this device.'; } catch {}
}
async function signOut() { await api.signOut(); S.user = null; S.treeId = null; route(); }
async function createTree() {
  const name = $('newTreeName').value.trim(); if (!name) return;
  try { const id = await busy('Creating…', () => api.createTree(name)); S.trees = await api.myTrees(); openTree(S.trees.find(t => t.id === id)); } catch {}
}
async function requestAccess(id) {
  try { await busy('Sending…', () => api.requestAccess(id, ($('joinMsg') || {}).value)); showJoin(id); } catch {}
}
function goTrees() { setUrlTree(null); S.treeId = null; api.myTrees().then(ts => { S.trees = ts; showTrees(); }).catch(fail); }

// ============ Expose to inline handlers ============
window.App = {
  signInGoogle, signInEmail, signOut, createTree, requestAccess, goTrees,
  openTreeId: id => openTree(S.trees.find(t => t.id === id)), reload, tab,
  renderList, openProfile, profBack, closeProfile, relateFrom,
  pickDone, closePick, renderPick,
  openEdit, closeEdit, save, del, addChild, addChildFromTree, addSpouse, addSpouseFromTree, pickParent, pickSpouse,
  addParentRow: () => { readForm(); F.parents.push({ FatherID: '', MotherID: '', Type: 'Adopted' }); renderRelRows(); },
  addMarriageRow: () => { readForm(); F.marriages.push({ SpouseID: '', Status: 'Current', Year: '' }); renderRelRows(); },
  rmParent: i => { readForm(); F.parents.splice(i, 1); renderRelRows(); },
  rmMarriage: i => { readForm(); F.marriages.splice(i, 1); renderRelRows(); },
  setM: (i, k, v) => (F.marriages[i][k] = v),
  dateSync,
  toggleKid: (i, id, on) => { const s = new Set(F.marriages[i].LinkKids || []); on ? s.add(id) : s.delete(id); F.marriages[i].LinkKids = [...s]; },
  allKids: (i, on) => { readForm(); F.marriages[i].LinkKids = on ? freeKids(F.marriages[i].SpouseID) : []; renderRelRows(); },
  navigate, back, setMode, zoomBy, fit, expandAll, toggle, tapNode, focusNode, showInTree, findInTree,
  openParents: (id, fromTree, e) => { if (e) { e.stopPropagation(); if (moved) return; } openParents(id, fromTree); },
  closeParents, saveParents, parPick, parClear: k => { PA[k] = { id: '', name: '' }; renderParents(); }, parName: (k, v) => (PA[k].name = v),
  openFamily, goUp, toggleChain, treeMode: () => (view.mode === 'anc' ? savedMode() : view.mode),
  setAncBoth: on => { S.ancBoth = on; store.set('ancBoth', on ? '1' : '0'); renderTree(true); },
  toggleSelect, clearPicked, openBulk, closeBulk, bulkDirty, applyAll, saveBulk,
  review, cancelReq, loadHistory, share, invite, cancelInvite, setRole, removeMember, reviewAccess,
};

setupPan();
$('f_Gender').addEventListener('change', () => { if (F) { readForm(); renderRelRows(); } });
boot().catch(fail);
