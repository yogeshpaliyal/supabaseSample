// Thin data layer over supabase-js. Everything the UI needs goes through here,
// so the UI can be tested with a fake implementation of the same functions.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });

function check({ data, error }) {
  if (error) throw new Error(error.message || String(error));
  return data;
}

async function selectAll(table, cols, filter) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).range(from, from + 999);
    q = filter(q);
    const rows = check(await q);
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

async function profilesFor(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return {};
  const rows = check(await sb.from('profiles').select('id, display_name, email, avatar_url').in('id', uniq));
  return Object.fromEntries(rows.map(r => [r.id, r]));
}

const here = () => location.origin + location.pathname + location.search;

export const api = {
  // ---- auth
  async session() { return check(await sb.auth.getSession()).session; },
  onAuth(cb) { sb.auth.onAuthStateChange((_e, s) => cb(s)); },
  async signInGoogle() { check(await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: here() } })); },
  async signInEmail(email) { check(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: here() } })); },
  async signOut() { await sb.auth.signOut(); },

  // ---- trees
  async myTrees() { return check(await sb.rpc('my_trees')); },
  async treeInfo(id) { return check(await sb.rpc('tree_info', { p_tree: id })); },
  async createTree(name) { return check(await sb.rpc('create_tree', { p_name: name })); },
  async requestAccess(id, message) { return check(await sb.rpc('request_access', { p_tree: id, p_message: message || null })); },

  async loadTree(id) {
    const [people, marriages, parents] = await Promise.all([
      selectAll('people', 'id, name, gender, birth_year, death_year, family, notes, phone, updated_at', q => q.eq('tree_id', id)),
      selectAll('marriages', 'id, husband_id, wife_id, status, year, notes', q => q.eq('tree_id', id)),
      selectAll('parent_links', 'id, child_id, father_id, mother_id, type', q => q.eq('tree_id', id)),
    ]);
    return { people, marriages, parents };
  },

  // ---- edits
  async savePerson(tree, payload) { return check(await sb.rpc('save_person', { p_tree: tree, p: payload })); },
  async deletePerson(tree, id) { return check(await sb.rpc('delete_person', { p_tree: tree, p_id: id })); },
  async submitRequest(tree, kind, payload, summary) {
    return check(await sb.rpc('submit_edit_request', { p_tree: tree, p_kind: kind, p_payload: payload, p_summary: summary }));
  },
  async listRequests(tree) {
    const rows = check(await sb.from('edit_requests').select('*').eq('tree_id', tree).order('created_at', { ascending: false }).limit(200));
    const prof = await profilesFor(rows.flatMap(r => [r.requested_by, r.reviewed_by]));
    return rows.map(r => ({ ...r, requester: prof[r.requested_by], reviewer: prof[r.reviewed_by] }));
  },
  async reviewRequest(id, approve, note) { return check(await sb.rpc('review_edit_request', { p_request: id, p_approve: approve, p_note: note || null })); },
  async cancelRequest(id) { return check(await sb.rpc('cancel_edit_request', { p_request: id })); },
  async history(tree) {
    const rows = check(await sb.from('audit_log').select('id, user_id, action, entity, entity_id, before, after, at').eq('tree_id', tree).order('at', { ascending: false }).limit(100));
    const prof = await profilesFor(rows.map(r => r.user_id));
    return rows.map(r => ({ ...r, who: prof[r.user_id] }));
  },

  // ---- members (owners)
  async members(tree) {
    const rows = check(await sb.from('tree_members').select('user_id, role, created_at').eq('tree_id', tree));
    const prof = await profilesFor(rows.map(r => r.user_id));
    return rows.map(r => ({ ...r, profile: prof[r.user_id] || {} }));
  },
  async invites(tree) { return check(await sb.from('tree_invites').select('email, role, created_at').eq('tree_id', tree).order('created_at')); },
  async accessRequests(tree) {
    const rows = check(await sb.from('access_requests').select('*').eq('tree_id', tree).eq('status', 'pending').order('created_at'));
    const prof = await profilesFor(rows.map(r => r.user_id));
    return rows.map(r => ({ ...r, profile: prof[r.user_id] || {} }));
  },
  async invite(tree, email, role) { return check(await sb.rpc('invite_member', { p_tree: tree, p_email: email, p_role: role })); },
  async cancelInvite(tree, email) { return check(await sb.rpc('cancel_invite', { p_tree: tree, p_email: email })); },
  async setRole(tree, user, role) { return check(await sb.rpc('set_member_role', { p_tree: tree, p_user: user, p_role: role })); },
  async removeMember(tree, user) { return check(await sb.rpc('remove_member', { p_tree: tree, p_user: user })); },
  async reviewAccess(id, approve, role) { return check(await sb.rpc('review_access_request', { p_request: id, p_approve: approve, p_role: role })); },
};
