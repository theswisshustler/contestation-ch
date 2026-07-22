-- Autorise le compte principal à administrer la plateforme de publication.
-- L'utilisateur doit exister dans Supabase Auth avant l'application.
do $$
declare
  owner_user_id uuid;
begin
  select id
    into owner_user_id
    from auth.users
   where lower(email) = lower('rivierelouis@proton.me')
   order by created_at asc
   limit 1;

  if owner_user_id is null then
    raise exception 'Utilisateur Auth rivierelouis@proton.me introuvable';
  end if;

  insert into public.blog_admins (user_id, role)
  values (owner_user_id, 'owner'::public.blog_admin_role)
  on conflict (user_id) do update
    set role = excluded.role;
end;
$$;
