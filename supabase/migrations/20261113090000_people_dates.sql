-- Optional full birth / death dates (the year alone still works), and a
-- "deceased" flag for people whose death date is not known.
-- A trigger keeps birth_year / death_year in step with the dates, so the
-- year columns stay the single thing used for sorting and the year-only case.

alter table public.people add column if not exists birth_date date;
alter table public.people add column if not exists death_date date;
alter table public.people add column if not exists deceased boolean not null default false;
alter table public.people drop constraint if exists people_dates_order;
alter table public.people add constraint people_dates_order check (
  (birth_date is null or death_date is null or death_date >= birth_date) and
  (birth_year is null or death_year is null or death_year >= birth_year));

create or replace function private.people_dates() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- a newly given date sets its year; a year changed on its own drops a date that no longer matches
  if new.birth_date is not null and (tg_op = 'INSERT' or new.birth_date is distinct from old.birth_date) then
    new.birth_year := extract(year from new.birth_date)::int;
  elsif new.birth_date is not null and new.birth_year is distinct from extract(year from new.birth_date)::int then
    new.birth_date := null;
  end if;
  if new.death_date is not null and (tg_op = 'INSERT' or new.death_date is distinct from old.death_date) then
    new.death_year := extract(year from new.death_date)::int;
  elsif new.death_date is not null and new.death_year is distinct from extract(year from new.death_date)::int then
    new.death_date := null;
  end if;
  if new.death_year is not null or new.death_date is not null then new.deceased := true; end if;
  return new;
end $$;

drop trigger if exists people_dates on public.people;
create trigger people_dates before insert or update on public.people
  for each row execute function private.people_dates();

-- existing rows: anyone with a death year is deceased
update public.people set deceased = true where death_year is not null and not deceased;

create or replace function private.apply_save_person(p_tree uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_person jsonb := coalesce(p -> 'person', '{}'::jsonb);
  v_id     uuid  := nullif(v_person ->> 'id', '')::uuid;
  v_name   text  := trim(coalesce(v_person ->> 'name', ''));
  v_gender text  := nullif(v_person ->> 'gender', '');
  v_phone  text  := nullif(regexp_replace(trim(coalesce(v_person ->> 'phone', '')), '\s+', ' ', 'g'), '');
  v_village text := nullif(trim(coalesce(v_person ->> 'village', '')), '');
  v_uid    uuid  := (select auth.uid());
  r jsonb; m jsonb; lc jsonb; np jsonb; c uuid; f uuid; mo uuid; s uuid; s_gender text; self_wife boolean;
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
      village = v_village,
      birth_date = case when v_person ? 'birth_date' then nullif(v_person ->> 'birth_date', '')::date else birth_date end,
      death_date = case when v_person ? 'death_date' then nullif(v_person ->> 'death_date', '')::date else death_date end,
      deceased   = case when v_person ? 'deceased' then coalesce((v_person ->> 'deceased')::boolean, false) else deceased end,
      updated_by = v_uid, updated_at = now()
    where id = v_id and tree_id = p_tree;
    if not found then raise exception 'Person not found in this tree'; end if;
  else
    insert into public.people (tree_id, name, gender, birth_year, death_year, family, notes, phone, village,
                               birth_date, death_date, deceased, created_by, updated_by)
    values (p_tree, v_name, v_gender,
            nullif(v_person ->> 'birth_year', '')::int, nullif(v_person ->> 'death_year', '')::int,
            nullif(trim(coalesce(v_person ->> 'family', '')), ''), nullif(trim(coalesce(v_person ->> 'notes', '')), ''),
            v_phone, v_village,
            nullif(v_person ->> 'birth_date', '')::date, nullif(v_person ->> 'death_date', '')::date,
            coalesce((nullif(v_person ->> 'deceased', ''))::boolean, false), v_uid, v_uid)
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

  -- Add (new or existing) birth parents to this person, e.g. a wife's father and mother.
  -- new_parents: {father_id? | father: {name, family, birth_year}, mother_id? | mother: {...}}
  if p ? 'new_parents' then
    np := p -> 'new_parents';
    f  := nullif(np ->> 'father_id', '')::uuid;
    mo := nullif(np ->> 'mother_id', '')::uuid;
    if f is null and trim(coalesce(np -> 'father' ->> 'name', '')) <> '' then
      insert into public.people (tree_id, name, gender, family, village, birth_year, created_by, updated_by)
      values (p_tree, trim(np -> 'father' ->> 'name'), 'M', nullif(trim(coalesce(np -> 'father' ->> 'family', '')), ''),
              nullif(trim(coalesce(np -> 'father' ->> 'village', '')), ''), nullif(np -> 'father' ->> 'birth_year', '')::int, v_uid, v_uid)
      returning id into f;
    end if;
    if mo is null and trim(coalesce(np -> 'mother' ->> 'name', '')) <> '' then
      insert into public.people (tree_id, name, gender, family, village, birth_year, created_by, updated_by)
      values (p_tree, trim(np -> 'mother' ->> 'name'), 'F', nullif(trim(coalesce(np -> 'mother' ->> 'family', '')), ''),
              nullif(trim(coalesce(np -> 'mother' ->> 'village', '')), ''), nullif(np -> 'mother' ->> 'birth_year', '')::int, v_uid, v_uid)
      returning id into mo;
    end if;
    if f is null and mo is null then raise exception 'Enter the father or the mother'; end if;
    if f = v_id or mo = v_id then raise exception 'A person cannot be their own parent'; end if;
    if f is not null and not exists (select 1 from public.people where id = f and tree_id = p_tree) then raise exception 'Father not found in this tree'; end if;
    if mo is not null and not exists (select 1 from public.people where id = mo and tree_id = p_tree) then raise exception 'Mother not found in this tree'; end if;
    if f is not null and mo is not null then
      insert into public.marriages (tree_id, husband_id, wife_id) values (p_tree, f, mo) on conflict (husband_id, wife_id) do nothing;
    end if;
    update public.parent_links set father_id = coalesce(f, father_id), mother_id = coalesce(mo, mother_id)
      where tree_id = p_tree and child_id = v_id and type = 'Biological';
    if not found then
      insert into public.parent_links (tree_id, child_id, father_id, mother_id, type) values (p_tree, v_id, f, mo, 'Biological');
    end if;
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
