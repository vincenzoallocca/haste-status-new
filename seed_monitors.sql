INSERT OR IGNORE INTO monitor_groups (id, name, slug, description, is_public, display_order)
VALUES ('grp-haste-core', 'HASTE Core Services', 'haste-core', 'Monitoraggio infrastruttura edge di HASTE Collective', 1, 1);

INSERT INTO monitors (id, name, script, group_id, interval_seconds, timeout_ms, active)
VALUES 
(
  'mon-haste-web',
  'HASTE Web (haste.it)',
  '{"steps":[{"name":"check_homepage","request":{"method":"GET","url":"https://haste.it/"},"assert":[{"check":"status","equals":200}]}]}',
  'grp-haste-core',
  60,
  10000,
  1
),
(
  'mon-haste-staff',
  'HASTE Staff Portal',
  '{"steps":[{"name":"check_staff","request":{"method":"GET","url":"https://haste.it/staff/"},"assert":[{"check":"status","equals":200}]}]}',
  'grp-haste-core',
  300,
  10000,
  1
),
(
  'mon-haste-catalog',
  'HASTE Catalogo & Shop',
  '{"steps":[{"name":"check_catalog","request":{"method":"GET","url":"https://haste.it/catalogo"},"assert":[{"check":"status","equals":200}]}]}',
  'grp-haste-core',
  300,
  10000,
  1
),
(
  'mon-haste-mailflare',
  'HASTE Mailflare (mail.haste.it)',
  '{"steps":[{"name":"check_mail","request":{"method":"GET","url":"https://mail.haste.it/"},"assert":[{"check":"status","lessThan":500}]}]}',
  'grp-haste-core',
  60,
  10000,
  1
)
ON CONFLICT(id) DO UPDATE SET
  interval_seconds = excluded.interval_seconds,
  name = excluded.name,
  script = excluded.script,
  group_id = excluded.group_id,
  timeout_ms = excluded.timeout_ms,
  active = excluded.active;

