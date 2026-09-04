# Bloque 4 — verificación backend

- `npm run check`
- Ejecutar `npm run postinstall` en un entorno de prueba y verificar que todos los runtime patches encuentran sus anchors.
- Confirmar POST /api/reports, GET /api/reports/me, GET /api/admin/reports y PATCH /api/admin/reports/:id/status.
- Confirmar que una suspensión vigente responde 403 con code ACCOUNT_SUSPENDED y suspendedUntil; una suspensión vencida se reactiva antes de esta comprobación.
- Confirmar que cambios de estado de reportes crean admin_actions y user_notifications.
- Pagos permanecen test_only/disabled.
