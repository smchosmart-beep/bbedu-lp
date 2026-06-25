
CREATE TABLE public.hwpx_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name text NOT NULL,
  storage_path text NOT NULL UNIQUE,
  variant text,
  model text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  cost_krw numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, DELETE ON public.hwpx_files TO authenticated;
GRANT ALL ON public.hwpx_files TO service_role;

ALTER TABLE public.hwpx_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "hwpx_files admin read"
  ON public.hwpx_files FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "hwpx_files admin delete"
  ON public.hwpx_files FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE INDEX hwpx_files_created_at_idx ON public.hwpx_files (created_at DESC);

-- Storage policies on the `hwpx` bucket: admins (auth.uid + admin role) may
-- read directly. Server routes use service_role and bypass RLS for upload
-- and download — no policy needed for service_role.
CREATE POLICY "hwpx bucket admin read"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'hwpx'
    AND public.has_role(auth.uid(), 'admin'::public.app_role)
  );
