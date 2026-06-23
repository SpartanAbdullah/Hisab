-- Receipt photos: attach an image to a transaction.
--
-- Storage model: a PRIVATE Supabase Storage bucket `receipts`. Each object is
-- keyed under the owner's uid folder (`{user_id}/{transaction_id}.jpg`), and
-- RLS on storage.objects restricts every operation to objects whose first path
-- segment equals the caller's uid. Display uses short-lived signed URLs (the
-- bucket is never public). The transaction row stores only the object PATH in
-- a new `receipt_path` column.

-- 1) The column on transactions (nullable; no receipt by default).
alter table public.transactions
  add column if not exists receipt_path text;

-- 2) The private bucket.
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- 3) RLS: owner-only access, scoped by the {uid}/ path prefix.
drop policy if exists receipts_select_own on storage.objects;
create policy receipts_select_own on storage.objects
  for select using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists receipts_insert_own on storage.objects;
create policy receipts_insert_own on storage.objects
  for insert with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists receipts_update_own on storage.objects;
create policy receipts_update_own on storage.objects
  for update using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists receipts_delete_own on storage.objects;
create policy receipts_delete_own on storage.objects
  for delete using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
