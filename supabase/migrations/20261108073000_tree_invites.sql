-- Invite people to a tree by email. If they already have an account they are
-- added immediately; otherwise the invite is applied when they first sign in.

create table public.tree_invites (
  tree_id    uuid not null references public.trees (id) on delete cascade,
  email      text not null check (email = lower(trim(email)) and position('@' in email) > 1),
  role       public.tree_role not null,
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tree_id, email)
);
alter table public.tree_invites enable row level security;
create policy invites_select on public.tree_invites for select to authenticated using (private.has_role(tree_id, 'owner'));
revoke all on public.tree_invites from anon;
revoke insert, update, delete on public.tree_invites from authenticated;

-- New users: create profile, then apply any pending invites for their email
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, email, avatar_url)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
          new.email,
          new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;

  insert into public.tree_members (tree_id, user_id, role, added_by)
  select i.tree_id, new.id, i.role, i.invited_by from public.tree_invites i where i.email = lower(new.email)
  on conflict (tree_id, user_id) do nothing;
  delete from public.tree_invites where email = lower(new.email);
  return new;
end $$;

create or replace function public.invite_member(p_tree uuid, p_email text, p_role public.tree_role default 'viewer')
returns text language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(trim(p_email)); v_user uuid;
begin
  if not private.has_role(p_tree, 'owner') then raise exception 'Only owners can invite members'; end if;
  if position('@' in v_email) < 2 then raise exception 'Enter a valid email'; end if;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is not null then
    insert into public.tree_members (tree_id, user_id, role, added_by) values (p_tree, v_user, p_role, (select auth.uid()))
    on conflict (tree_id, user_id) do update set role = excluded.role;
    update public.access_requests set status = 'approved', granted_role = p_role, decided_by = (select auth.uid()), decided_at = now()
      where tree_id = p_tree and user_id = v_user and status = 'pending';
    return 'added';
  end if;
  insert into public.tree_invites (tree_id, email, role, invited_by) values (p_tree, v_email, p_role, (select auth.uid()))
  on conflict (tree_id, email) do update set role = excluded.role;
  return 'invited';
end $$;

create or replace function public.cancel_invite(p_tree uuid, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_role(p_tree, 'owner') then raise exception 'Only owners can cancel invites'; end if;
  delete from public.tree_invites where tree_id = p_tree and email = lower(trim(p_email));
end $$;

-- Trees the signed-in user belongs to (for the tree switcher)
create or replace function public.my_trees()
returns table (id uuid, name text, role public.tree_role, people_count bigint, pending_edits bigint, pending_access bigint)
language sql stable security definer set search_path = '' as $$
  select t.id, t.name, m.role,
         (select count(*) from public.people p where p.tree_id = t.id),
         case when m.role >= 'editor' then (select count(*) from public.edit_requests e where e.tree_id = t.id and e.status = 'pending') else 0 end,
         case when m.role = 'owner' then (select count(*) from public.access_requests a where a.tree_id = t.id and a.status = 'pending') else 0 end
  from public.tree_members m join public.trees t on t.id = m.tree_id
  where m.user_id = (select auth.uid())
  order by t.name
$$;

revoke execute on function public.invite_member(uuid, text, public.tree_role), public.cancel_invite(uuid, text), public.my_trees() from public, anon;
grant execute on function public.invite_member(uuid, text, public.tree_role), public.cancel_invite(uuid, text), public.my_trees() to authenticated;
