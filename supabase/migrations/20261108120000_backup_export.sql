-- Read-only export for automated backups (e.g. the Google Sheet backup script).
-- Callers must present a secret backup token; only its SHA-256 hash is stored here.
-- Create a token with:  insert into private.backup_tokens (token_hash, label)
--                       values (encode(sha256(convert_to('<token>', 'UTF8')), 'hex'), 'google-sheet');

create table if not exists private.backup_tokens (
  token_hash text primary key,
  label      text,
  created_at timestamptz not null default now(),
  last_used  timestamptz
);

create or replace function public.export_backup(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_hash text := encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
begin
  update private.backup_tokens set last_used = now() where token_hash = v_hash;
  if not found then raise exception 'Invalid backup token'; end if;
  return jsonb_build_object(
    'exported_at', now(),
    'trees',        coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at) from public.trees t), '[]'),
    'people',       coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at) from public.people p), '[]'),
    'marriages',    coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at) from public.marriages m), '[]'),
    'parent_links', coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at) from public.parent_links l), '[]'),
    'members',      coalesce((select jsonb_agg(jsonb_build_object('tree_id', m.tree_id, 'role', m.role, 'email', pr.email,
                                 'name', pr.display_name, 'since', m.created_at) order by m.created_at)
                              from public.tree_members m left join public.profiles pr on pr.id = m.user_id), '[]'),
    'edit_requests',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at) from public.edit_requests e), '[]')
  );
end $$;

revoke all on private.backup_tokens from public, anon, authenticated;
revoke execute on function public.export_backup(text) from public;
grant execute on function public.export_backup(text) to anon, authenticated;
