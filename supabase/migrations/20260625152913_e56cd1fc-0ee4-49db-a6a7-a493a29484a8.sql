-- ai_usage_log/hwpx_files: 서비스 역할(서버 admin 인서트 경로)에 Data API GRANT 보강.
-- ai_usage_log의 콜 단위 로그 인서트가 누락된 원인이 GRANT 누락일 가능성에 대비.
GRANT SELECT, INSERT ON public.ai_usage_log TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hwpx_files TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_config TO service_role;