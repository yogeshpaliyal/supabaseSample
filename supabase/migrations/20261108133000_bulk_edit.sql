-- Bulk edit: update several people's details in one atomic call (editors),
-- or as a single edit request (contributors).
-- payload = { people: [ {id, name, gender, birth_year, death_year, family, notes, phone}, ... ] }
-- Only person fields are touched; parents and marriages are left as they are.

alter table public.edit_requests drop constraint if exists edit_requests_kind_check;
alter table public.edit_requests add constraint edit_requests_kind_check check (kind in ('save_person', 'delete_person', 'save_people'));

create or replace function private.apply_save_people(p_tree uuid, p jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare e jsonb; n int := 0;
begin
  if jsonb_typeof(p -> 'people') <> 'array' or jsonb_array_length(p -> 'people') = 0 then
    raise exception 'Nothing to save'; end if;
  if jsonb_array_length(p -> 'people') > 500 then raise exception 'Too many people in one edit'; end if;
  for e in select * from jsonb_array_elements(p -> 'people') loop
    if nullif(e ->> 'id', '') is null then raise exception 'Bulk edit only changes existing people'; end if;
    perform private.apply_save_person(p_tree, jsonb_build_object('person', e));
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.save_people(p_tree uuid, p jsonb)
returns int language plpgsql security definer set search_path = '' as $$
begin
  if not private.has_role(p_tree, 'editor') then raise exception 'You need editor access to make direct changes'; end if;
  return private.apply_save_people(p_tree, p);
end $$;

create or replace function public.submit_edit_request(p_tree uuid, p_kind text, p_payload jsonb, p_summary text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not private.has_role(p_tree, 'contributor') then raise exception 'You need contributor access to suggest changes'; end if;
  if p_kind not in ('save_person', 'delete_person', 'save_people') then raise exception 'Unknown request type'; end if;
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
    elsif r.kind = 'save_people' then
      perform private.apply_save_people(r.tree_id, r.payload);
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

revoke execute on function public.save_people(uuid, jsonb) from public, anon;
grant execute on function public.save_people(uuid, jsonb) to authenticated;
