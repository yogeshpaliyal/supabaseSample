-- save_person: optionally move a spouse's existing children under the couple

create or replace function private.apply_save_person(p_tree uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_person jsonb := coalesce(p -> 'person', '{}'::jsonb);
  v_id     uuid  := nullif(v_person ->> 'id', '')::uuid;
  v_name   text  := trim(coalesce(v_person ->> 'name', ''));
  v_gender text  := nullif(v_person ->> 'gender', '');
  v_phone  text  := nullif(regexp_replace(trim(coalesce(v_person ->> 'phone', '')), '\s+', ' ', 'g'), '');
  v_uid    uuid  := (select auth.uid());
  r jsonb; m jsonb; lc jsonb; c uuid; f uuid; mo uuid; s uuid; s_gender text; self_wife boolean;
begin
  if v_name = '' then raise exception 'Name is required'; end if;
  if v_gender is not null and v_gender not in ('M', 'F') then v_gender := null; end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9][0-9 ()-]{5,19}$' then
    raise exception 'Mobile number should contain only digits (and an optional + country code)'; end if;

  if v_id is not null then
    update public.people set
      name = v_name, gender = v_gender,
      birth_year = nullif(v_person ->> 'birth_year', '')::int,
      death_year = nullif(v_person ->> 'death_year', '')::int,
      family = nullif(trim(coalesce(v_person ->> 'family', '')), ''),
      notes  = nullif(trim(coalesce(v_person ->> 'notes', '')), ''),
      phone  = v_phone,
      updated_by = v_uid, updated_at = now()
    where id = v_id and tree_id = p_tree;
    if not found then raise exception 'Person not found in this tree'; end if;
  else
    insert into public.people (tree_id, name, gender, birth_year, death_year, family, notes, phone, created_by, updated_by)
    values (p_tree, v_name, v_gender,
            nullif(v_person ->> 'birth_year', '')::int, nullif(v_person ->> 'death_year', '')::int,
            nullif(trim(coalesce(v_person ->> 'family', '')), ''), nullif(trim(coalesce(v_person ->> 'notes', '')), ''),
            v_phone, v_uid, v_uid)
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

  -- Put existing children of a spouse under this couple (e.g. after adding a wife,
  -- her husband's children get her as their mother).
  -- link_children: [{spouse_id, child_ids: [...]}]
  if p ? 'link_children' then
    for lc in select * from jsonb_array_elements(coalesce(p -> 'link_children', '[]'::jsonb)) loop
      s := nullif(lc ->> 'spouse_id', '')::uuid;
      select (mm.wife_id = v_id) into self_wife from public.marriages mm
        where mm.tree_id = p_tree and ((mm.husband_id = v_id and mm.wife_id = s) or (mm.wife_id = v_id and mm.husband_id = s));
      if not found then raise exception 'Children can only be linked to a recorded marriage'; end if;
      for c in select (jsonb_array_elements_text(coalesce(lc -> 'child_ids', '[]'::jsonb)))::uuid loop
        if c = v_id or c = s then raise exception 'A person cannot be their own parent'; end if;
        if self_wife then
          update public.parent_links set mother_id = v_id where tree_id = p_tree and child_id = c and father_id = s;
        else
          update public.parent_links set father_id = v_id where tree_id = p_tree and child_id = c and mother_id = s;
        end if;
        if not found then raise exception 'That child is not linked to the spouse'; end if;
      end loop;
    end loop;
  end if;

  return v_id;
end $$;
