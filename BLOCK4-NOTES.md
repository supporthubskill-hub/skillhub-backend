# Implementación Bloque 4

Este bloque reutiliza las tablas `reports`, `admin_actions` y `user_notifications` existentes. No activa pagos ni añade dependencias.

El runtime patch se ejecuta después de `add-admin-sanctions.js` para conservar la reactivación automática de suspensiones vencidas y reemplazar únicamente la respuesta de login para una suspensión vigente.

La verificación completa de runtime y base de datos debe ejecutarse antes de fusionar/desplegar.
