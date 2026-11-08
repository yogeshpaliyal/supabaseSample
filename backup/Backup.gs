/**
 * Vanshavali — nightly backup of the Supabase family tree into this Google Sheet.
 *
 * Writes these tabs (overwritten on every run; use File → Version history to see older days):
 *   Backup · People, Backup · Marriages, Backup · Parent links, Backup · Members,
 *   Backup · Edit requests, Backup · Info
 *
 * Setup (once):
 *   1. Project Settings (⚙) → Script properties → Add property
 *        BACKUP_TOKEN = <your backup token>
 *   2. Select function "setupDailyBackup" → Run → allow access.
 *      It runs a first backup now and then every night at about 2 AM.
 */

const SUPABASE_URL = 'https://ofypjtgbqcwtudlpdtyx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Cr2e68h2FGP-fTgnChkIRQ_gdUDK1y1';   // public key; the token below is what grants access

function backupNow() {
  const token = PropertiesService.getScriptProperties().getProperty('BACKUP_TOKEN');
  if (!token) throw new Error('Add BACKUP_TOKEN in Project Settings → Script properties first.');

  const res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/export_backup', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: SUPABASE_KEY },
    payload: JSON.stringify({ p_token: token }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Backup failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 300));
  }
  const d = JSON.parse(res.getContentText());
  const treeName = {}; d.trees.forEach(t => treeName[t.id] = t.name);
  const name = {}; d.people.forEach(p => name[p.id] = p.name);
  const nm = id => (id && name[id]) || '';

  // readable relationships next to each person
  const bio = {}; d.parent_links.forEach(l => { if (l.type === 'Biological' || !bio[l.child_id]) bio[l.child_id] = l; });
  const spouses = {};
  d.marriages.forEach(m => {
    (spouses[m.husband_id] = spouses[m.husband_id] || []).push(nm(m.wife_id) + (m.status !== 'Current' ? ' (' + m.status + ')' : ''));
    (spouses[m.wife_id] = spouses[m.wife_id] || []).push(nm(m.husband_id) + (m.status !== 'Current' ? ' (' + m.status + ')' : ''));
  });

  writeTab_('Backup · People',
    ['Tree', 'Name', 'Gender', 'Birth year', 'Death year', 'Family / Gotra', 'Mobile', 'Father', 'Mother', 'Spouse(s)', 'Notes', 'id', 'father_id', 'mother_id', 'updated_at'],
    d.people.map(p => {
      const l = bio[p.id] || {};
      return [treeName[p.tree_id] || '', p.name, p.gender || '', p.birth_year || '', p.death_year || '', p.family || '', p.phone || '',
              nm(l.father_id), nm(l.mother_id), (spouses[p.id] || []).join(', '), p.notes || '', p.id, l.father_id || '', l.mother_id || '', p.updated_at];
    }));
  writeTab_('Backup · Marriages', ['Tree', 'Husband', 'Wife', 'Status', 'Year', 'Notes', 'id', 'husband_id', 'wife_id'],
    d.marriages.map(m => [treeName[m.tree_id] || '', nm(m.husband_id), nm(m.wife_id), m.status, m.year || '', m.notes || '', m.id, m.husband_id, m.wife_id]));
  writeTab_('Backup · Parent links', ['Tree', 'Child', 'Father', 'Mother', 'Type', 'id', 'child_id', 'father_id', 'mother_id'],
    d.parent_links.map(l => [treeName[l.tree_id] || '', nm(l.child_id), nm(l.father_id), nm(l.mother_id), l.type, l.id, l.child_id, l.father_id || '', l.mother_id || '']));
  writeTab_('Backup · Members', ['Tree', 'Name', 'Email', 'Role', 'Since'],
    d.members.map(m => [treeName[m.tree_id] || '', m.name || '', m.email || '', m.role, m.since]));
  writeTab_('Backup · Edit requests', ['Tree', 'Summary', 'Status', 'Created', 'Reviewed', 'Payload (JSON)'],
    d.edit_requests.map(e => [treeName[e.tree_id] || '', e.summary || e.kind, e.status, e.created_at, e.reviewed_at || '', JSON.stringify(e.payload)]));
  writeTab_('Backup · Info', ['Item', 'Value'], [
    ['Last backup', new Date()],
    ['Exported at (server)', d.exported_at],
    ['Trees', d.trees.map(t => t.name + ' (' + t.id + ')').join(', ')],
    ['People', d.people.length], ['Marriages', d.marriages.length], ['Parent links', d.parent_links.length], ['Members', d.members.length],
    ['How to see older backups', 'File → Version history → See version history'],
  ]);
  return d.people.length;
}

function writeTab_(title, headers, rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(title) || ss.insertSheet(title);
  sh.clearContents();
  const data = [headers].concat(rows.map(r => r.map(v => (typeof v === 'string' && /^[=+@-]/.test(v) ? "'" + v : v))));
  sh.getRange(1, 1, data.length, headers.length).setValues(data);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
}

/** Run once: schedules a daily backup (~2 AM) and runs the first one now. */
function setupDailyBackup() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'backupNow').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('backupNow').timeBased().everyDays(1).atHour(2).create();
  const n = backupNow();
  Logger.log('Daily backup scheduled. First backup saved ' + n + ' people.');
}
