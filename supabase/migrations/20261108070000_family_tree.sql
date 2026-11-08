-- =====================================================================
-- Village Family Tree — schema, row-level security, and RPCs
--
-- Roles per tree (ordered):  viewer < contributor < editor < owner
--   viewer       read the tree
--   contributor  read + submit edit requests (an editor approves them)
--   editor       read + edit directly + approve/reject edit requests
--   owner        everything + manage members and access requests
--
-- All writes to people / marriages / parent_links go through the RPCs
-- below (save_person, delete_person, review_edit_request) so that a
-- person and their links are always saved together, atomically.
-- =====================================================================

create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create type public.tree_role as enum ('viewer', 'contributor', 'editor', 'owner');

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  email        text,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

create table public.trees (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  description text,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create table public.tree_members (
  tree_id    uuid not null references public.trees (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.tree_role not null,
  added_by   uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tree_id, user_id)
);
create index on public.tree_members (user_id);

create table public.access_requests (
  id             uuid primary key default gen_random_uuid(),
  tree_id        uuid not null references public.trees (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  message        text,
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  granted_role   public.tree_role,
  decided_by     uuid references auth.users (id) on delete set null,
  decided_at     timestamptz,
  created_at     timestamptz not null default now()
);
create unique index access_requests_one_pending on public.access_requests (tree_id, user_id) where status = 'pending';

create table public.people (
  id          uuid primary key default gen_random_uuid(),
  tree_id     uuid not null references public.trees (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  gender      text check (gender in ('M', 'F')),
  birth_year  int check (birth_year between 1 and 2200),
  death_year  int check (death_year between 1 and 2200),
  family      text,
  notes       text,
  legacy_id   text,
  created_by  uuid references auth.users (id) on delete set null,
  updated_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on public.people (tree_id);
create unique index people_legacy on public.people (tree_id, legacy_id) where legacy_id is not null;

create table public.marriages (
  id         uuid primary key default gen_random_uuid(),
  tree_id    uuid not null references public.trees (id) on delete cascade,
  husband_id uuid not null references public.people (id) on delete cascade,
  wife_id    uuid not null references public.people (id) on delete cascade,
  status     text not null default 'Current' check (status in ('Current', 'Ended (death)', 'Ended (separation)')),
  year       int,
  notes      text,
  created_at timestamptz not null default now(),
  check (husband_id <> wife_id),
  unique (husband_id, wife_id)
);
create index on public.marriages (tree_id);
create index on public.marriages (wife_id);

create table public.parent_links (
  id         uuid primary key default gen_random_uuid(),
  tree_id    uuid not null references public.trees (id) on delete cascade,
  child_id   uuid not null references public.people (id) on delete cascade,
  father_id  uuid references public.people (id) on delete set null,
  mother_id  uuid references public.people (id) on delete set null,
  type       text not null default 'Biological' check (type in ('Biological', 'Adopted')),
  created_at timestamptz not null default now(),
  check (child_id <> father_id and child_id <> mother_id),
  check (father_id is null or mother_id is null or father_id <> mother_id)
);
create index on public.parent_links (tree_id);
create index on public.parent_links (child_id);
create index on public.parent_links (father_id);
create index on public.parent_links (mother_id);

create table public.edit_requests (
  id           uuid primary key default gen_random_uuid(),
  tree_id      uuid not null references public.trees (id) on delete cascade,
  requested_by uuid not null references auth.users (id) on delete cascade,
  kind         text not null check (kind in ('save_person', 'delete_person')),
  payload      jsonb not null,
  summary      text,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by  uuid references auth.users (id) on delete set null,
  reviewed_at  timestamptz,
  review_note  text,
  result_id    uuid,
  created_at   timestamptz not null default now()
);
create index on public.edit_requests (tree_id, status);

create table public.audit_log (
  id        bigint generated always as identity primary key,
  tree_id   uuid not null references public.trees (id) on delete cascade,
  user_id   uuid,
  action    text not null,
  entity    text not null,
  entity_id uuid,
  before    jsonb,
  after     jsonb,
  at        timestamptz not null default now()
);
create index on public.audit_log (tree_id, at desc);

-- ---------------------------------------------------------------------
-- Helpers (private schema — not exposed through the API)
-- ---------------------------------------------------------------------
create or replace function private.role_in(p_tree uuid)
returns public.tree_role language sql stable security definer set search_path = '' as $$
  select m.role from public.tree_members m where m.tree_id = p_tree and m.user_id = (select auth.uid())
$$;

create or replace function private.has_role(p_tree uuid, p_min public.tree_role)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.role_in(p_tree) >= p_min, false)
$$;

grant usage on schema private to authenticated;
grant execute on function private.role_in(uuid), private.has_role(uuid, public.tree_role) to authenticated;

-- Profile row for every new auth user
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, email, avatar_url)
  values (new.id,
          coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
          new.email,
          new.raw_user_meta_data ->> 'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users for each row execute function private.handle_new_user();

-- Audit trail for people / marriages / parent_links
create or replace function private.audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare r jsonb := to_jsonb(coalesce(new, old));
begin
  -- the whole tree is being deleted: nothing left to audit
  if not exists (select 1 from public.trees where id = (r ->> 'tree_id')::uuid) then return null; end if;
  insert into public.audit_log (tree_id, user_id, action, entity, entity_id, before, after)
  values ((r ->> 'tree_id')::uuid, (select auth.uid()), lower(tg_op), tg_table_name, (r ->> 'id')::uuid,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;

create trigger audit_people        after insert or update or delete on public.people        for each row execute function private.audit();
create trigger audit_marriages     after insert or update or delete on public.marriages     for each row execute function private.audit();
create trigger audit_parent_links  after insert or update or delete on public.parent_links  for each row execute function private.audit();

-- A parent link that lost both parents (after a delete) is meaningless
create or replace function private.cleanup_parent_links()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.parent_links where father_id is null and mother_id is null;
  return null;
end $$;
create trigger parent_links_cleanup after update on public.parent_links
  for each statement execute function private.cleanup_parent_links();

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.trees           enable row level security;
alter table public.tree_members    enable row level security;
alter table public.access_requests enable row level security;
alter table public.people          enable row level security;
alter table public.marriages       enable row level security;
alter table public.parent_links    enable row level security;
alter table public.edit_requests   enable row level security;
alter table public.audit_log       enable row level security;

-- profiles: yourself, plus anyone who shares a tree with you or asked to join a tree you own
create policy profiles_select on public.profiles for select to authenticated using (
  id = (select auth.uid())
  or exists (select 1 from public.tree_members a join public.tree_members b on a.tree_id = b.tree_id
             where a.user_id = (select auth.uid()) and b.user_id = profiles.id)
  or exists (select 1 from public.access_requests r
             where r.user_id = profiles.id and private.has_role(r.tree_id, 'owner'))
);
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- trees
create policy trees_select on public.trees for select to authenticated using (private.has_role(id, 'viewer'));
create policy trees_update on public.trees for update to authenticated
  using (private.has_role(id, 'owner')) with check (private.has_role(id, 'owner'));
create policy trees_delete on public.trees for delete to authenticated using (private.has_role(id, 'owner'));

-- tree_members: members see each other; changes only via owner RPCs
create policy members_select on public.tree_members for select to authenticated using (private.has_role(tree_id, 'viewer'));

-- access_requests: requester sees own; owners see their tree's
create policy access_select on public.access_requests for select to authenticated
  using (user_id = (select auth.uid()) or private.has_role(tree_id, 'owner'));

-- tree data: read for viewers; writes only through RPCs
create policy people_select       on public.people       for select to authenticated using (private.has_role(tree_id, 'viewer'));
create policy marriages_select    on public.marriages    for select to authenticated using (private.has_role(tree_id, 'viewer'));
create policy parent_links_select on public.parent_links for select to authenticated using (private.has_role(tree_id, 'viewer'));

-- edit_requests: requester sees own; editors see all for the tree
create policy edit_requests_select on public.edit_requests for select to authenticated
  using (requested_by = (select auth.uid()) or private.has_role(tree_id, 'editor'));

-- audit log: editors
create policy audit_select on public.audit_log for select to authenticated using (private.has_role(tree_id, 'editor'));

-- Nothing is readable or writable by anonymous visitors
revoke all on all tables in schema public from anon;
revoke insert, update, delete on public.trees, public.tree_members, public.access_requests, public.people,
  public.marriages, public.parent_links, public.edit_requests, public.audit_log from authenticated;

-- ---------------------------------------------------------------------
-- Core write logic (private; called by the public RPCs)
-- payload = {
--   person:    {id?, name, gender, birth_year, death_year, family, notes},
--   parents:   [{father_id, mother_id, type}],          -- optional: replaces all if present
--   marriages: [{spouse_id, status, year, notes}]       -- optional: replaces all if present
-- }
-- ---------------------------------------------------------------------
create or replace function private.apply_save_person(p_tree uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_person jsonb := coalesce(p -> 'person', '{}'::jsonb);
  v_id     uuid  := nullif(v_person ->> 'id', '')::uuid;
  v_name   text  := trim(coalesce(v_person ->> 'name', ''));
  v_gender text  := nullif(v_person ->> 'gender', '');
  v_uid    uuid  := (select auth.uid());
  r jsonb; m jsonb; f uuid; mo uuid; s uuid; s_gender text; self_wife boolean;
begin
  if v_name = '' then raise exception 'Name is required'; end if;
  if v_gender is not null and v_gender not in ('M', 'F') then v_gender := null; end if;

  if v_id is not null then
    update public.people set
      name = v_name, gender = v_gender,
      birth_year = nullif(v_person ->> 'birth_year', '')::int,
      death_year = nullif(v_person ->> 'death_year', '')::int,
      family = nullif(trim(coalesce(v_person ->> 'family', '')), ''),
      notes  = nullif(trim(coalesce(v_person ->> 'notes', '')), ''),
      updated_by = v_uid, updated_at = now()
    where id = v_id and tree_id = p_tree;
    if not found then raise exception 'Person not found in this tree'; end if;
  else
    insert into public.people (tree_id, name, gender, birth_year, death_year, family, notes, created_by, updated_by)
    values (p_tree, v_name, v_gender,
            nullif(v_person ->> 'birth_year', '')::int, nullif(v_person ->> 'death_year', '')::int,
            nullif(trim(coalesce(v_person ->> 'family', '')), ''), nullif(trim(coalesce(v_person ->> 'notes', '')), ''),
            v_uid, v_uid)
    returning id into v_id;
  end if;

  if p ? 'parents' then
    delete from public.parent_links where child_id = v_id;
    for r in select * from jsonb_array_elements(coalesce(p -> 'parents', '[]'::jsonb)) loop
      f  := nullif(r ->> 'father_id', '')::uuid;
      mo := nullif(r ->> 'mother_id', '')::uuid;
      continue when f is null and mo is null;
      if f = v_id or mo = v_id then raise exception 'A person cannot be their own parent'; end if;
      if f = mo then raise exception 'Father and mother must be different people'; end if;
      if f is not null and not exists (select 1 from public.people where id = f and tree_id = p_tree) then
        raise exception 'Father not found in this tree'; end if;
      if mo is not null and not exists (select 1 from public.people where id = mo and tree_id = p_tree) then
        raise exception 'Mother not found in this tree'; end if;
      insert into public.parent_links (tree_id, child_id, father_id, mother_id, type)
      values (p_tree, v_id, f, mo, case when r ->> 'type' = 'Adopted' then 'Adopted' else 'Biological' end);
    end loop;
  end if;

  if p ? 'marriages' then
    delete from public.marriages where husband_id = v_id or wife_id = v_id;
    for m in select * from jsonb_array_elements(coalesce(p -> 'marriages', '[]'::jsonb)) loop
      s := nullif(m ->> 'spouse_id', '')::uuid;
      continue when s is null;
      if s = v_id then raise exception 'A person cannot marry themselves'; end if;
      select gender into s_gender from public.people where id = s and tree_id = p_tree;
      if not found then raise exception 'Spouse not found in this tree'; end if;
      self_wife := v_gender = 'F' or (v_gender is distinct from 'M' and s_gender = 'M');
      insert into public.marriages (tree_id, husband_id, wife_id, status, year, notes)
      values (p_tree,
              case when self_wife then s else v_id end,
              case when self_wife then v_id else s end,
              case when m ->> 'status' in ('Current', 'Ended (death)', 'Ended (separation)') then m ->> 'status' else 'Current' end,
              nullif(m ->> 'year', '')::int,
              nullif(trim(coalesce(m ->> 'notes', '')), ''))
      on conflict (husband_id, wife_id) do nothing;
    end loop;
  end if;

  return v_id;
end $$;

create or replace function private.apply_delete_person(p_tree uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.people where id = p_id and tree_id = p_tree;
  if not found then raise exception 'Person not found in this tree'; end if;
end $$;

-- ---------------------------------------------------------------------
-- Public RPCs (called from the app with supabase.rpc)
-- ---------------------------------------------------------------------

-- Create a tree; caller becomes owner
create or replace function public.create_tree(p_name text, p_description text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'Sign in required'; end if;
  insert into public.trees (name, description, created_by) values (trim(p_name), p_description, v_uid) returning id into v_id;
  insert into public.tree_members (tree_id, user_id, role, added_by) values (v_id, v_uid, 'owner', v_uid);
  return v_id;
end $$;

-- What a signed-in user can learn about a tree from an invite link
create or replace function public.tree_info(p_tree uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', t.id, 'name', t.name,
    'my_role', private.role_in(t.id),
    'my_request', (select r.status from public.access_requests r
                   where r.tree_id = t.id and r.user_id = (select auth.uid())
                   order by r.created_at desc limit 1))
  from public.trees t where t.id = p_tree
$$;

create or replace function public.request_access(p_tree uuid, p_message text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'Sign in required'; end if;
  if not exists (select 1 from public.trees where id = p_tree) then raise exception 'Tree not found'; end if;
  if private.role_in(p_tree) is not null then raise exception 'You are already a member of this tree'; end if;
  select id into v_id from public.access_requests where tree_id = p_tree and user_id = v_uid and status = 'pending';
  if v_id is not null then return v_id; end if;
  insert into public.access_requests (tree_id, user_id, message) values (p_tree, v_uid, p_message) returning id into v_id;
  return v_id;
end $$;

create or replace function public.review_access_request(p_request uuid, p_approve boolean, p_role public.tree_role default 'viewer')
returns void language plpgsql security definer set search_path = '' as $$
declare r public.access_requests;
begin
  select * into r from public.access_requests where id = p_request for update;
  if not found then raise exception 'Request not found'; end if;
  if not private.has_role(r.tree_id, 'owner') then raise exception 'Only owners can review access requests'; end if;
  if r.status <> 'pending' then raise exception 'Request already %', r.status; end if;
  update public.access_requests set status = case when p_approve then 'approved' else 'rejected' end,
    granted_role = case when p_approve then p_role end, decided_by = (select auth.uid()), decided_at = now()
  where id = p_request;
  if p_approve then
    insert into public.tree_members (tree_id, user_id, role, added_by) values (r.tree_id, r.user_id, p_role, (select auth.uid()))
    on conflict (tree_id, user_id) do update set role = excluded.role;
  end if;
end $$;

create or replace function public.set_member_role(p_tree uuid, p_user uuid, p_role public.tree_role)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_role(p_tree, 'owner') then raise exception 'Only owners can change roles'; end if;
  if p_role <> 'owner' and exists (select 1 from public.tree_members where tree_id = p_tree and user_id = p_user and role = 'owner')
     and (select count(*) from public.tree_members where tree_id = p_tree and role = 'owner') = 1 then
    raise exception 'A tree must keep at least one owner';
  end if;
  update public.tree_members set role = p_role where tree_id = p_tree and user_id = p_user;
  if not found then raise exception 'Not a member of this tree'; end if;
end $$;

create or replace function public.remove_member(p_tree uuid, p_user uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (private.has_role(p_tree, 'owner') or p_user = (select auth.uid())) then
    raise exception 'Only owners can remove members'; end if;
  if exists (select 1 from public.tree_members where tree_id = p_tree and user_id = p_user and role = 'owner')
     and (select count(*) from public.tree_members where tree_id = p_tree and role = 'owner') = 1 then
    raise exception 'A tree must keep at least one owner';
  end if;
  delete from public.tree_members where tree_id = p_tree and user_id = p_user;
end $$;

-- Direct edits (editors and owners)
create or replace function public.save_person(p_tree uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_role(p_tree, 'editor') then raise exception 'You need editor access to make direct changes'; end if;
  return private.apply_save_person(p_tree, p);
end $$;

create or replace function public.delete_person(p_tree uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_role(p_tree, 'editor') then raise exception 'You need editor access to delete'; end if;
  perform private.apply_delete_person(p_tree, p_id);
end $$;

-- Suggested edits (contributors and above)
create or replace function public.submit_edit_request(p_tree uuid, p_kind text, p_payload jsonb, p_summary text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not private.has_role(p_tree, 'contributor') then raise exception 'You need contributor access to suggest changes'; end if;
  if p_kind not in ('save_person', 'delete_person') then raise exception 'Unknown request type'; end if;
  insert into public.edit_requests (tree_id, requested_by, kind, payload, summary)
  values (p_tree, (select auth.uid()), p_kind, p_payload, p_summary) returning id into v_id;
  return v_id;
end $$;

create or replace function public.review_edit_request(p_request uuid, p_approve boolean, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare r public.edit_requests; v_result uuid;
begin
  select * into r from public.edit_requests where id = p_request for update;
  if not found then raise exception 'Request not found'; end if;
  if not private.has_role(r.tree_id, 'editor') then raise exception 'You need editor access to review requests'; end if;
  if r.status <> 'pending' then raise exception 'Request already %', r.status; end if;
  if p_approve then
    if r.kind = 'save_person' then
      v_result := private.apply_save_person(r.tree_id, r.payload);
    else
      v_result := (r.payload ->> 'id')::uuid;
      perform private.apply_delete_person(r.tree_id, v_result);
    end if;
  end if;
  update public.edit_requests set status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_by = (select auth.uid()), reviewed_at = now(), review_note = p_note, result_id = v_result
  where id = p_request;
  return v_result;
end $$;

-- Withdraw your own pending request
create or replace function public.cancel_edit_request(p_request uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.edit_requests where id = p_request and requested_by = (select auth.uid()) and status = 'pending';
  if not found then raise exception 'No pending request of yours with that id'; end if;
end $$;

-- Only signed-in users may call the RPCs
revoke execute on function
  public.create_tree(text, text), public.tree_info(uuid), public.request_access(uuid, text),
  public.review_access_request(uuid, boolean, public.tree_role), public.set_member_role(uuid, uuid, public.tree_role),
  public.remove_member(uuid, uuid), public.save_person(uuid, jsonb), public.delete_person(uuid, uuid),
  public.submit_edit_request(uuid, text, jsonb, text), public.review_edit_request(uuid, boolean, text),
  public.cancel_edit_request(uuid)
from public, anon;
grant execute on function
  public.create_tree(text, text), public.tree_info(uuid), public.request_access(uuid, text),
  public.review_access_request(uuid, boolean, public.tree_role), public.set_member_role(uuid, uuid, public.tree_role),
  public.remove_member(uuid, uuid), public.save_person(uuid, jsonb), public.delete_person(uuid, uuid),
  public.submit_edit_request(uuid, text, jsonb, text), public.review_edit_request(uuid, boolean, text),
  public.cancel_edit_request(uuid)
to authenticated;
